// dsh-tts-reader — Client half.
//
// Adds a "read aloud" action to every finalized assistant message. The page
// never talks to api.deepseek.com and never sees the API key: it posts the
// session/message identity to this plugin's own Host route, which resolves the
// text, synthesizes it through the official TTS API, and streams raw PCM back.
//
// Playback follows the official web client's approach: the response stream is
// converted Int16 → Float32 and scheduled chunk by chunk on one AudioContext,
// so the first sentence starts long before the whole reply is synthesized.
//
// Cache: the finished PCM chunks stay in memory per message (bounded), so the
// second click replays instantly; the Host also caches the WAV on disk, so a
// page reload still answers without a second API call.

window.__ModuleLoader__.load({
  id: 'dsh-tts-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG_PATH = '/api/dsh-tts/config'
    const READ_PATH = '/api/dsh-tts/read'
    const PLAN_PATH = '/api/dsh-tts/plan'
    const CLEAR_PATH = '/api/dsh-tts/cache/clear'
    const EVENTS_PATH = '/api/dsh-tts/events'
    const RECENT_PATH = '/api/dsh-tts/recent'

    const SAMPLE_RATE = 24000
    const START_DELAY = 0.1

    // Locale follows the Host's active language (what DSH itself shows), not the
    // browser's: the plugin's copy must switch with the app. `ctx.locale` is
    // wired in apply(); the navigator language is only the pre-injection guess.
    let localeCtx = null
    let localeListeners = []
    function currentLang() {
      try {
        const snapshot = localeCtx && typeof localeCtx.getLocale === 'function' ? localeCtx.getLocale() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active.toLowerCase() : ''
        if (active) return active.startsWith('zh') ? 'zh' : 'en'
      } catch {}
      try {
        return String(navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }
    const t = (zh, en) => (currentLang() === 'zh' ? zh : en)

    // Re-render a component when the app language changes.
    function useLocaleTick() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        localeListeners.push(force)
        return () => {
          localeListeners = localeListeners.filter(entry => entry !== force)
        }
      }, [])
    }

    function watchLocale(ctx) {
      try {
        if (typeof ctx.locale.subscribe !== 'function') return
        ctx.effect(() => ctx.locale.subscribe(() => {
          for (const force of localeListeners.slice()) {
            try { force() } catch {}
          }
        }), 'dsh-tts-reader: locale')
      } catch {}
    }

    // Messages that have been read at least once: the speaker button uses this
    // only to know it can offer "play again (cached)".
    const playedMessages = new Set()
    let current = null // { key, controller, context }
    let playback = { key: null, phase: 'idle', error: '', queued: null }
    const listeners = new Set()

    // Speech waiting for the audio before it, in arrival order: [{ key, speak }].
    let speechQueue = []

    // Auto-read state, kept in sync with the Host settings.
    let autoRead = false
    let autoReadInterim = false
    let speakQuestions = true
    let speakApprovals = true
    // Playback rate: 1 is unchanged. Applied client-side as a pitch-preserving
    // time-stretch — the TTS API has no speed parameter.
    let speed = 1
    // Which synthesizer the Host is configured with. `browser` never reaches the
    // Host: the page speaks the paragraphs itself.
    let engineMode = 'deepseek'
    let activeSessionId = null
    const autoPlayed = new Set()
    let eventSource = null

    // The replay button polls the Host for the pending question / approval, so
    // it shows up even if a particular page instance missed the event.
    const PENDING_PATH = '/api/dsh-tts/pending'
    const BRIDGE_PATH = '/api/dsh-tts/bridge'
    const SPEECH_VOICE_KEY = 'dsh-tts-reader:speech-voice'
    const SPEECH_FIRST_TIMEOUT_MS = 8000

    // ---------------------------------------------------------- browser speech
    // A real browser ships speech voices; a desktop shell (Electron) exposes the
    // API but no engine, so it needs the bridge to a browser.
    function speechSynth() {
      try {
        if (typeof window === 'undefined') return null
        return window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function'
          ? window.speechSynthesis
          : null
      } catch { return null }
    }

    let speechVoices = []
    const speechListeners = new Set()

    function refreshSpeechVoices() {
      const synth = speechSynth()
      let list = []
      try { list = (synth && synth.getVoices()) || [] } catch { list = [] }
      const changed = list.length !== speechVoices.length
        || list.some((voice, index) => (speechVoices[index] && speechVoices[index].voiceURI) !== voice.voiceURI)
      speechVoices = list
      if (changed) {
        for (const listener of speechListeners) {
          try { listener(speechVoices) } catch {}
        }
      }
      return speechVoices
    }

    function subscribeSpeechVoices(listener) {
      speechListeners.add(listener)
      return () => { speechListeners.delete(listener) }
    }

    const isDesktopShell = (() => {
      try {
        const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '')
        if (/Electron/i.test(ua)) return true
        // The packaged shell could strip the token from the UA; the renderer's
        // own process object is the second tell.
        const proc = typeof window !== 'undefined' ? window.process : null
        return !!(proc && proc.versions && proc.versions.electron)
      } catch { return false }
    })()

    // Which of the two browser paths this shell uses: its own voices, or the
    // bridge to a real browser. A desktop shell defaults to the bridge, because
    // its voice list can look fine and still stay silent.
    const BRIDGE_TARGET = 'bridge'
    const speechTargetValue = () => {
      const stored = storedSpeechVoice()
      if (isDesktopShell) return stored === '' || stored === BRIDGE_TARGET ? BRIDGE_TARGET : stored
      return stored || ((pickSpeechVoice() || {}).voiceURI || '')
    }
    const usesBridge = () => speechTargetValue() === BRIDGE_TARGET

    const speechCapable = () => speechVoices.length > 0

    function storedSpeechVoice() {
      try { return window.localStorage.getItem(SPEECH_VOICE_KEY) || '' } catch { return '' }
    }

    function rememberSpeechVoice(uri) {
      try {
        if (uri) window.localStorage.setItem(SPEECH_VOICE_KEY, uri)
        else window.localStorage.removeItem(SPEECH_VOICE_KEY)
      } catch {}
    }

    function isCloudVoice(voice) { return voice && voice.localService === false }

    /** Prefer the remembered voice, then a local Chinese one, then anything. */
    function pickSpeechVoice() {
      const wanted = storedSpeechVoice()
      const byUri = wanted ? speechVoices.find((voice) => voice.voiceURI === wanted) : null
      if (byUri) return byUri
      const local = speechVoices.filter((voice) => !isCloudVoice(voice))
      const pool = local.length > 0 ? local : speechVoices
      return pool.find((voice) => /^zh/i.test(voice.lang || '')) || pool[0] || null
    }

    /**
     * Ask the Host to hand this text to the default browser. The desktop shell
     * has no speech engine, so this is how it reads aloud at all.
     */
    async function openBridge(target) {
      const payload = {}
      if (target && target.sessionId) payload.sessionId = target.sessionId
      if (target && target.messageId) payload.messageId = target.messageId
      if (target && target.text) payload.text = target.text
      // The bridge reads at the speed set on the settings page.
      payload.speed = Number(speed) || 1
      try {
        const response = await fetch(BRIDGE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || !body || body.ok !== true) {
          throw new Error((body && body.error) || t('朗读桥失败', 'the bridge failed'))
        }
        const value = body.value || {}
        if (value.delivered > 0) {
          // A bridge tab was already listening: nothing new was opened.
          showFailureToast(t('已发送到浏览器里那个朗读页', 'sent to the bridge tab you already have open'), 'ok')
        } else if (!value.launched && value.url) {
          try { await navigator.clipboard.writeText(value.url) } catch {}
          showFailureToast(t('没能自动打开浏览器，链接已复制到剪贴板：', 'could not open a browser; the link is copied: ') + value.url)
        }
        return value
      } catch (error) {
        showFailureToast((error && error.message) || String(error))
        return null
      }
    }

    function applyRemoteConfig(value) {
      if (!value || typeof value !== 'object') return
      autoRead = value.autoRead === true
      autoReadInterim = value.autoReadInterim === true
      speakQuestions = value.speakQuestions !== false
      speakApprovals = value.speakApprovals !== false
      if (typeof value.engine === 'string') engineMode = value.engine
      const nextSpeed = Number(value.speed)
      const resolved = Number.isFinite(nextSpeed) && nextSpeed > 0 ? Math.min(2, Math.max(0.5, nextSpeed)) : 1
      if (resolved === speed) return
      speed = resolved
      // A speed change from settings applies to the audio in flight right away.
      if (player) {
        playerRerender(player, speed)
        playerView({ speed })
      }
    }

    let configLoaded = false
    function loadConfigOnce() {
      if (configLoaded) return
      configLoaded = true
      fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
        .then((res) => res.json())
        .then((body) => { if (body && body.ok) applyRemoteConfig(body.value) })
        .catch(() => {})
    }

    function ensureEvents(ctx) {
      if (eventSource || typeof EventSource === 'undefined') return
      try {
        eventSource = new EventSource(EVENTS_PATH)
      } catch {
        eventSource = null
        return
      }
      eventSource.onmessage = (event) => {
        let payload = null
        try { payload = JSON.parse(event.data) } catch { return }
        if (!payload) return
        if (payload.type === 'question' || payload.type === 'approval') {
          // Speech for these comes from the /pending probe below, so one page
          // instance owns it even when the feed reconnects.
          return
        }
        if (payload.type === 'question-closed' || payload.type === 'approval-closed') {
          // Answered or withdrawn: stop its audio now instead of waiting for the
          // next poll. Both key spellings are tried because the close line only
          // carries the id.
          const id = String(payload.id || '')
          if (id) {
            for (const key of ['prompt:' + id, 'prompt:approval:' + id]) {
              if (current && current.key === key) stopCurrentOnly()
              dropQueued(key)
            }
          }
          return
        }
        if (payload.type !== 'assistant') return
        handleAssistant(payload.sessionId, payload.messageId, payload.final)
      }
      eventSource.onerror = () => {
        // Reconnect later instead of a tight retry loop.
        try { eventSource.close() } catch {}
        eventSource = null
        setTimeout(() => { if (!eventSource) ensureEvents(ctx) }, 5000)
      }
      ctx.effect(() => () => {
        try { eventSource && eventSource.close() } catch {}
        eventSource = null
      }, 'dsh-tts-reader: events')
    }

    // One assistant message from either transport (SSE or the polling
    // fallback). Interim output is opt-in; the turn's last output always plays.
    function handleAssistant(sessionId, messageId, final) {
      if (!autoRead) return
      if (final !== true && !autoReadInterim) return
      const sid = String(sessionId || '')
      const mid = String(messageId || '')
      if (!sid || !mid) return
      if (!activeSessionId || sid !== activeSessionId) return
      autoReadMessage(sid, mid)
    }

    // Polling fallback for the assistant feed: the page's EventSource can drop
    // silently (no error, no reconnect), and auto-read must not depend on it.
    // The first successful poll only establishes the cursor, so a page load
    // never replays the backlog.
    let recentCursor = null
    function pollRecent() {
      const query = recentCursor === null ? '' : '?after=' + String(recentCursor)
      fetch(RECENT_PATH + query, { headers: { accept: 'application/json' } })
        .then((res) => res.json())
        .then((body) => {
          if (!body || !body.ok || !body.value) return
          const items = Array.isArray(body.value.items) ? body.value.items : []
          const seq = Number(body.value.seq)
          if (recentCursor === null) {
            recentCursor = Number.isFinite(seq) ? seq : 0
            return
          }
          for (const item of items) {
            if (!item) continue
            const value = Number(item.seq)
            if (Number.isFinite(value) && value > recentCursor) recentCursor = value
            handleAssistant(item.sessionId, item.messageId, item.final)
          }
          if (Number.isFinite(seq) && seq > recentCursor) recentCursor = seq
        })
        .catch(() => {})
    }

    function setPlayback(patch) {
      playback = { ...playback, ...patch }
      for (const listener of listeners) {
        try { listener(playback) } catch {}
      }
    }

    function usePlayback() {
      const [value, setValue] = React.useState(playback)
      React.useEffect(() => {
        listeners.add(setValue)
        setValue(playback)
        return () => { listeners.delete(setValue) }
      }, [])
      return value
    }

    // Abort only what is audible; the waiting queue is untouched. Starting the
    // next queued item uses this, so draining never discards the rest.
    function stopCurrentOnly() {
      playerStop()
      current = null
      setPlayback({ key: null, phase: 'idle', error: '' })
    }

    // A user stop: silence now AND drop everything waiting.
    function stopPlayback() {
      clearQueue()
      stopCurrentOnly()
    }

    function clearQueue() {
      if (speechQueue.length === 0 && playback.queued === null) return
      speechQueue = []
      setPlayback({ queued: null })
    }

    const queueHead = () => (speechQueue.length > 0 ? speechQueue[0].key : null)
    const isQueued = (key) => speechQueue.some(item => item.key === key)

    // Strict FIFO: an approval arriving while a mid-turn read is playing waits
    // its turn behind both the current audio and the reads already queued.
    function enqueueSpeech(key, speak) {
      if (speechQueue.some(item => item.key === key)) return
      speechQueue.push({ key, speak })
      setPlayback({ queued: queueHead() })
    }

    function dropQueued(key) {
      const next = speechQueue.filter(item => item.key !== key)
      if (next.length === speechQueue.length) return
      speechQueue = next
      setPlayback({ queued: queueHead() })
    }

    function drainQueue() {
      const next = speechQueue.shift()
      setPlayback({ queued: queueHead() })
      if (next) {
        try { next.speak() } catch {}
      }
    }

    // Auto-read of one assistant message. Queues instead of cutting in, so a
    // mid-turn read never truncates the question the user is hearing.
    function autoReadMessage(sessionId, messageId) {
      const key = sessionId + ':' + messageId
      if (autoPlayed.has(key)) return
      autoPlayed.add(key)
      const speak = () => { void startReadAloud(sessionId, messageId, key) }
      if (current || speechQueue.length > 0) {
        enqueueSpeech(key, speak)
        return
      }
      speak()
    }

    // Speech for the pending question or approval. It waits for the current
    // audio and for the reads queued before it; the card button can cut in.
    function autoReadPrompt(key, text) {
      if (!text) return
      if ((current && current.key !== key) || speechQueue.length > 0) {
        enqueueSpeech(key, () => { void startReadAloud(null, null, key, { text }) })
        return
      }
      void startReadAloud(null, null, key, { text })
    }

    // A user gesture: cut whatever plays and speak this now.
    function speakNow(key, speak) {
      clearQueue()
      stopCurrentOnly()
      speak()
    }

    function toFloat32(bytes) {
      const samples = new Float32Array(bytes.length >> 1)
      const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = view.getInt16(i * 2, true) / 0x8000
      }
      return samples
    }

    function concatBytes(left, right) {
      if (left.length === 0) return new Uint8Array(right)
      const merged = new Uint8Array(left.length + right.length)
      merged.set(left)
      merged.set(right, left.length)
      return merged
    }

    function schedule(context, samples, startAt) {
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start(startAt)
      return { source, end: startAt + buffer.duration }
    }

    const EMPTY = new Float32Array(0)

    // WSOLA (waveform-similarity overlap-add): changes duration without moving
    // the pitch, which is the only way to get playback speed here — the DeepSeek
    // TTS API has no speed parameter. Streaming: push() keeps the unfinished
    // tail and returns output as soon as enough of it is settled.
    class Stretcher {
      /** @param {number} durationRatio played length ÷ original length (= 1/speed). */
      constructor(durationRatio) {
        this.ratio = Math.min(4, Math.max(0.25, durationRatio))
        this.frame = 1024 // ~43 ms at 24 kHz
        this.hop = this.frame >> 1
        this.search = this.hop >> 1
        this.minOut = 2048
        this.window = new Float32Array(this.frame)
        for (let i = 0; i < this.frame; i += 1) {
          this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.frame)
        }
        this.input = EMPTY
        this.inputBase = 0
        this.out = new Float32Array(4096)
        this.outLen = 0
        this.outBase = 0
        this.frames = 0
        this.prevStart = -1
      }

      #targetAbs() {
        return Math.round((this.frames * this.hop) / this.ratio)
      }

      #grow(needed) {
        if (needed <= this.out.length) return
        let size = this.out.length
        while (size < needed) size *= 2
        const next = new Float32Array(size)
        next.set(this.out.subarray(0, this.outLen))
        this.out = next
      }

      // Nudge the frame start to the offset whose head best continues the
      // previous frame, which is what keeps the waveform from canceling itself.
      #frameStart(inputEnd) {
        const target = this.#targetAbs()
        if (this.prevStart < 0) return target
        const ref = this.prevStart + this.hop
        if (ref + this.hop > inputEnd) return target
        let best = target
        let bestScore = Infinity
        const from = Math.max(0, target - this.search)
        const to = target + this.search
        for (let candidate = from; candidate <= to; candidate += 1) {
          if (candidate + this.frame > inputEnd) break
          let score = 0
          for (let n = 0; n < this.hop; n += 1) {
            const diff = this.input[ref + n - this.inputBase] - this.input[candidate + n - this.inputBase]
            score += diff * diff
            if (score >= bestScore) break
          }
          if (score < bestScore) { bestScore = score; best = candidate }
        }
        return best
      }

      #take() {
        const readyAbs = this.frames * this.hop
        const ready = readyAbs - this.outBase
        if (ready < this.minOut) return EMPTY
        const output = this.out.slice(0, ready)
        const rest = this.out.slice(ready, this.outLen)
        this.out = new Float32Array(Math.max(rest.length + this.frame * 2, 4096))
        this.out.set(rest)
        this.outLen = rest.length
        this.outBase = readyAbs
        return output
      }

      push(samples) {
        if (!samples || samples.length === 0) return EMPTY
        const merged = new Float32Array(this.input.length + samples.length)
        merged.set(this.input)
        merged.set(samples, this.input.length)
        this.input = merged
        const inputEnd = this.inputBase + this.input.length
        for (;;) {
          const start = this.#frameStart(inputEnd)
          if (start + this.frame > inputEnd) break
          const at = this.frames * this.hop - this.outBase
          const local = start - this.inputBase
          this.#grow(at + this.frame)
          for (let n = 0; n < this.frame; n += 1) {
            this.out[at + n] += this.window[n] * this.input[local + n]
          }
          if (at + this.frame > this.outLen) this.outLen = at + this.frame
          this.prevStart = start
          this.frames += 1
          // Drop input that can no longer be reached by a future frame.
          const keepFrom = Math.max(0, this.#targetAbs() - this.search - this.hop)
          if (keepFrom > this.inputBase) {
            this.input = this.input.slice(keepFrom - this.inputBase)
            this.inputBase = keepFrom
          }
        }
        return this.#take()
      }

      flush() {
        if (this.outLen <= 0) return EMPTY
        const output = this.out.slice(0, this.outLen)
        this.out = new Float32Array(4096)
        this.outLen = 0
        this.outBase += output.length
        return output
      }
    }

    // Settings preview: one fixed sentence through the current engine and voice,
    // using the same Host route as a normal read so the sample is cached and the
    // second click is instant. It keeps its own AudioContext, so the read-aloud
    // button state stays untouched.
    const PREVIEW_TEXT = '你好，这是一段语音试听，用来确认音色。Hello, this is a preview.'
    const previewListeners = new Set()
    let previewPhase = 'idle'
    let preview = null

    function setPreviewPhase(phase) {
      if (previewPhase === phase) return
      previewPhase = phase
      for (const listener of previewListeners) {
        try { listener(phase) } catch {}
      }
    }

    function subscribePreview(listener) {
      previewListeners.add(listener)
      return () => { previewListeners.delete(listener) }
    }

    function stopPreview() {
      const active = preview
      preview = null
      if (active) {
        active.cancelled = true
        try { active.controller.abort() } catch {}
        if (active.timer) clearTimeout(active.timer)
        try { if (active.context) active.context.close() } catch {}
        if (active.speech) {
          try { const synth = speechSynth(); if (synth) synth.cancel() } catch {}
        }
      }
      setPreviewPhase('idle')
    }

    function createPreviewScheduler(context, active) {
      const durationRatio = speed > 0 ? 1 / speed : 1
      const stretcher = Math.abs(durationRatio - 1) > 0.01 ? new Stretcher(durationRatio) : null
      let nextTime = 0
      let last = null
      const emit = (samples) => {
        if (!samples || samples.length === 0) return
        const startAt = last ? Math.max(nextTime, context.currentTime) : context.currentTime + START_DELAY
        const scheduled = schedule(context, samples, startAt)
        active.sources.push(scheduled.source)
        nextTime = scheduled.end
        last = scheduled.source
      }
      return {
        feed(samples) {
          if (stretcher) emit(stretcher.push(samples))
          else emit(samples)
        },
        finish() {
          if (stretcher) emit(stretcher.flush())
          return { last, end: nextTime }
        },
      }
    }

    /** Preview through Web Speech: no Host round-trip, no cache, no AudioContext. */
    function playPreviewSpeech() {
      const synth = speechSynth()
      refreshSpeechVoices()
      if (!synth || !speechCapable()) {
        showFailureToast(t('这台环境没有浏览器语音，无法试听', 'no browser voices here'))
        return
      }
      const active = { speech: true, timer: 0, cancelled: false }
      preview = active
      setPreviewPhase('loading')
      const utter = new window.SpeechSynthesisUtterance(PREVIEW_TEXT)
      const voice = pickSpeechVoice()
      if (voice) { utter.voice = voice; utter.lang = voice.lang }
      utter.rate = Math.min(2, Math.max(0.5, speed))
      let started = false
      const done = () => {
        if (preview !== active) return
        preview = null
        if (active.timer) clearTimeout(active.timer)
        setPreviewPhase('idle')
      }
      utter.onstart = () => {
        if (preview !== active) return
        started = true
        setPreviewPhase('playing')
      }
      utter.onend = done
      utter.onerror = (event) => {
        const reason = (event && event.error) || 'unknown'
        if (preview !== active) return
        done()
        if (reason === 'interrupted' || reason === 'canceled') return
        if (reason === 'not-allowed') {
          showFailureToast(t('浏览器要求页面上先有一次点击才允许发声：请再点一次试听',
            'the browser needs one click on this page before it may speak; try again'))
          return
        }
        showFailureToast(t('试听失败：', 'preview failed: ') + reason)
      }
      active.timer = setTimeout(() => {
        if (started || preview !== active) return
        try { synth.cancel() } catch {}
        done()
        showFailureToast(isCloudVoice(voice)
          ? t('这个云端音色 8 秒内没有出声，多半连不上厂商服务器；换成 ⌂ 本地音色试试',
            'the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice')
          : t('浏览器 8 秒内没有出声，可能被自动播放策略挡住', 'no sound in 8 s; the browser may be blocking autoplay'))
      }, SPEECH_FIRST_TIMEOUT_MS)
      try { synth.speak(utter) } catch (error) {
        done()
        showFailureToast((error && error.message) || String(error))
      }
    }

    async function playPreview() {
      if (preview) { stopPreview(); return }
      if (engineMode === 'browser') {
        if (usesBridge()) { void openBridge({ text: PREVIEW_TEXT }); return }
        playPreviewSpeech()
        return
      }
      const active = { context: null, controller: new AbortController(), sources: [], timer: 0, cancelled: false }
      preview = active
      setPreviewPhase('loading')
      try {
        // Created inside the click: browsers only allow sound from a gesture.
        const context = new AudioContext({ sampleRate: SAMPLE_RATE })
        active.context = context
        void context.resume().catch(() => {})
        const response = await fetch(READ_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: PREVIEW_TEXT }),
          signal: active.controller.signal,
        })
        const type = String(response.headers.get('content-type') || '')
        if (type.indexOf('application/json') !== -1) {
          let payload = null
          try { payload = await response.json() } catch {}
          throw new Error((payload && payload.error) || t('语音合成失败', 'Speech synthesis failed'))
        }
        if (!response.ok || !response.body) {
          throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')
        }
        if (preview === active) setPreviewPhase('playing')
        const reader = response.body.getReader()
        active.controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) })
        const scheduler = createPreviewScheduler(context, active)
        let rest = new Uint8Array(0)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (active.cancelled) return
          const merged = concatBytes(rest, value)
          const samples = toFloat32(merged)
          rest = merged.slice(samples.length * 2)
          if (samples.length === 0) continue
          scheduler.feed(samples)
        }
        if (active.cancelled) return
        const { last, end } = scheduler.finish()
        const reset = () => {
          if (preview !== active) return
          preview = null
          try { context.close() } catch {}
          setPreviewPhase('idle')
        }
        if (!last) { reset(); return }
        // Web Audio keeps playing after the stream ends; release it when the
        // scheduled tail is over.
        active.timer = setTimeout(reset, Math.max(0, (end - context.currentTime) * 1000) + 200)
      } catch (error) {
        if (active.cancelled) return
        if (preview === active) preview = null
        try { if (active.context) active.context.close() } catch {}
        setPreviewPhase('idle')
        showFailureToast((error && error.message) || String(error))
      }
    }

    // ------------------------------------------------------------- unit player
    // Playback is per paragraph: /plan lists the paragraphs, /read with a unit
    // index streams one of them. The floating window navigates them and a speed
    // change only re-renders the part that has not been heard yet.
    let player = null
    let playerWindowEl = null
    let speedSaveTimer = 0
    const PLAYER_UNIT_GAP_MS = 60

    const previewOf = (unit) => {
      const text = unit && typeof unit.text === 'string' ? unit.text : ''
      const trimmed = text.replace(/\s+/g, ' ').trim()
      return trimmed.length > 28 ? trimmed.slice(0, 28) + '…' : trimmed
    }

    function concatFloat(chunks) {
      let length = 0
      for (const chunk of chunks) length += chunk.length
      const out = new Float32Array(length)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    }

    function playerClampSpeed(value) {
      const number = Number(value)
      return Number.isFinite(number) ? Math.min(2, Math.max(0.5, Math.round(number * 100) / 100)) : 1
    }

    function playerStopSources(session) {
      for (const source of session.sources) {
        try { source.onended = null } catch {}
        try { source.stop() } catch {}
        try { source.disconnect() } catch {}
      }
      session.sources = []
      session.last = null
      session.nextTime = 0
      session.startTime = 0
    }

    function playerStop() {
      const session = player
      player = null
      if (session && session.kind === 'speech') {
        // Browser speech owns no AudioContext: cancel the queue and drop timers.
        if (session.timer) clearTimeout(session.timer)
        if (session.watchdog) clearTimeout(session.watchdog)
        try { const synth = speechSynth(); if (synth) synth.cancel() } catch {}
        current = null
        updatePlayerWindow()
        return
      }
      if (session) {
        if (session.pendingNext) clearTimeout(session.pendingNext)
        if (session.prefetch) { try { session.prefetch.controller.abort() } catch {} }
        if (session.req) { try { session.req.abort() } catch {} }
        try { session.controller.abort() } catch {}
        playerStopSources(session)
        try { session.context.close() } catch {}
      }
      current = null
      updatePlayerWindow()
    }

    function playerEnsureStretcher(session) {
      const ratio = session.renderSpeed > 0 ? 1 / session.renderSpeed : 1
      session.stretcher = Math.abs(ratio - 1) > 0.01 ? new Stretcher(ratio) : null
    }

    function playerSchedule(session, samples, gen) {
      if (!samples || samples.length === 0) return
      const context = session.context
      if (!context) return
      const now = context.currentTime
      const startAt = session.last ? Math.max(session.nextTime, now) : now + START_DELAY
      if (!session.last) session.startTime = startAt
      const scheduled = schedule(context, samples, startAt)
      session.sources.push(scheduled.source)
      session.nextTime = scheduled.end
      session.last = scheduled.source
      session.gen = gen
    }

    function playerFeedSamples(session, samples, gen) {
      if (!samples || samples.length === 0) return
      session.chunks.push(samples)
      session.totalSamples += samples.length
      if (session.stretcher) playerSchedule(session, session.stretcher.push(samples), gen)
      else playerSchedule(session, samples, gen)
    }

    /** Re-render everything after a speed change, starting where the ear is. */
    function playerRerender(session, nextSpeed) {
      const context = session.context
      if (!context) return
      const now = context.currentTime
      const flat = concatFloat(session.chunks)
      const elapsed = session.last ? Math.max(0, now - session.startTime) : 0
      const played = Math.min(flat.length, Math.round(elapsed * session.renderSpeed * SAMPLE_RATE))
      const gen = session.gen
      playerStopSources(session)
      session.speed = nextSpeed
      session.renderSpeed = nextSpeed
      playerEnsureStretcher(session)
      session.startTime = now - (played / SAMPLE_RATE) / Math.max(0.01, nextSpeed)
      const remainder = flat.subarray(played)
      const fed = session.stretcher ? session.stretcher.push(remainder) : remainder
      if (fed.length) playerSchedule(session, fed, gen)
      // The unit already finished streaming: flush the stretcher now, or the
      // re-render would leave its buffered tail unscheduled.
      if (session.ended && session.stretcher) {
        const tail = session.stretcher.flush()
        if (tail.length) playerSchedule(session, tail, gen)
      }
      if (session.ended && session.last) {
        session.last.onended = () => { if (player === session && session.gen === gen) playerAdvance(session, gen) }
      }
    }

    function playerApplySpeed(nextSpeed) {
      const next = playerClampSpeed(nextSpeed)
      const session = player
      if (session && session.kind === 'speech') {
        // A running utterance keeps its old rate, so restart the current
        // paragraph from the last word boundary to make the change audible now.
        session.speed = next
        playerView({ speed: next })
        if (!session.desiredPaused) speakSpeechUnit(session, session.unit, session.boundary || 0)
      } else if (session) {
        playerRerender(session, next)
        playerView({ speed: next })
      }
      if (next === speed) return
      speed = next
      // Persist for later reads, but never twice per drag.
      if (speedSaveTimer) clearTimeout(speedSaveTimer)
      speedSaveTimer = setTimeout(() => {
        speedSaveTimer = 0
        void fetch(CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ speed: next }),
        }).catch(() => {})
      }, 350)
    }

    function playerTogglePause() {
      const session = player
      if (!session) return
      if (session.phase === 'paused') playerResume()
      else playerPause()
    }

    function playerPause() {
      const session = player
      if (!session) return
      if (session.kind === 'speech') {
        session.desiredPaused = true
        session.phase = 'paused'
        try { const synth = speechSynth(); if (synth) synth.pause() } catch {}
        setPlayback({ phase: 'paused' })
        playerView({ phase: 'paused' })
        return
      }
      if (!session.context) return
      session.desiredPaused = true
      session.phase = 'paused'
      try { void session.context.suspend().catch(() => {}) } catch {}
      setPlayback({ phase: 'paused' })
      playerView({ phase: 'paused' })
    }

    function playerResume() {
      const session = player
      if (!session) return
      if (session.kind === 'speech') {
        session.desiredPaused = false
        session.phase = 'playing'
        try { const synth = speechSynth(); if (synth) synth.resume() } catch {}
        setPlayback({ phase: 'playing' })
        playerView({ phase: 'playing' })
        return
      }
      if (!session.context) return
      session.desiredPaused = false
      session.phase = 'playing'
      try { void session.context.resume().catch(() => {}) } catch {}
      setPlayback({ phase: 'playing' })
      playerView({ phase: 'playing' })
    }

    function playerStep(delta) {
      const session = player
      if (!session) return
      const target = session.unit + delta
      if (target < 0 || target >= session.units.length) return
      if (session.kind === 'speech') speakSpeechUnit(session, target, 0)
      else void playerPlayUnit(session, target)
    }

    function playerAdvance(session, gen) {
      if (player !== session || session.gen !== gen) return
      if (session.unit + 1 >= session.units.length) {
        playerFinish()
        return
      }
      session.pendingNext = setTimeout(() => {
        session.pendingNext = 0
        if (player === session) void playerPlayUnit(session, session.unit + 1)
      }, PLAYER_UNIT_GAP_MS)
    }

    function playerFinish() {
      playerStop()
      setPlayback({ key: null, phase: 'idle', error: '' })
      drainQueue()
    }

    function playerEndUnit(session, gen) {
      if (player !== session || session.gen !== gen) return
      session.ended = true
      if (!session.last) { playerAdvance(session, gen); return }
      // Synthesis may have finished before the audio did; then advance right away.
      if (session.nextTime <= session.context.currentTime + 0.02) { playerAdvance(session, gen); return }
      session.last.onended = () => { if (player === session && session.gen === gen) playerAdvance(session, gen) }
    }

    function playerUnitRequest(session, index, signal) {
      const unit = session.units[index]
      const body = {
        unit: index,
        unitTotal: session.units.length,
        // The plan already has this paragraph, so the Host can synthesize it
        // without reading the session again — that read is the slowest local step.
        unitText: unit && typeof unit.text === 'string' ? unit.text : '',
      }
      if (!body.unitText) delete body.unitText
      if (session.sessionId && session.messageId) {
        body.sessionId = session.sessionId
        body.messageId = session.messageId
      }
      // Fallback for a Host that does not understand unitText: a selection
      // re-resolves to the same plan, so `unit` still addresses it.
      if (session.selection) body.text = session.selection
      return fetch(READ_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    }

    /**
     * Synthesize the next paragraph in the background while this one plays. Its
     * audio is buffered, or handed to the player once it becomes current, so a
     * paragraph boundary no longer waits for the whole next paragraph: a long
     * one starts from whatever is buffered and keeps streaming as it plays.
     */
    function playerPrefetch(session, index) {
      if (!session || index < 0 || index >= session.units.length) return
      if (session.prefetch && session.prefetch.index === index) return
      if (session.prefetch) { try { session.prefetch.controller.abort() } catch {} }
      const controller = new AbortController()
      let finish = () => {}
      let failPrefetch = () => {}
      const record = {
        index,
        controller,
        chunks: [],
        consumer: null,
        done: false,
        error: null,
        finished: new Promise((resolve) => { finish = resolve }),
        failed: new Promise((_resolve, reject) => { failPrefetch = reject }),
      }
      record.failed.catch(() => {})
      session.prefetch = record
      void (async () => {
        try {
          const response = await playerUnitRequest(session, index, controller.signal)
          const type = String(response.headers.get('content-type') || '')
          if (type.indexOf('application/json') !== -1) {
            let payload = null
            try { payload = await response.json() } catch {}
            throw new Error((payload && payload.error) || t('语音合成失败', 'Speech synthesis failed'))
          }
          if (!response.ok || !response.body) {
            throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')
          }
          const reader = response.body.getReader()
          controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) })
          let rest = new Uint8Array(0)
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            const merged = concatBytes(rest, value)
            const samples = toFloat32(merged)
            rest = merged.slice(samples.length * 2)
            if (samples.length === 0) continue
            if (record.consumer) record.consumer(samples)
            else record.chunks.push(samples)
            if (record.chunks.length > 512) record.chunks.splice(0, record.chunks.length - 512)
          }
          record.done = true
          finish()
        } catch (error) {
          record.done = true
          if (controller.signal.aborted) { finish(); return }
          record.error = error
          failPrefetch(error)
          finish()
        }
      })()
    }

    async function playerPlayUnit(session, index) {
      if (player !== session) return
      const target = Math.max(0, Math.min(index, session.units.length - 1))
      session.unit = target
      session.gen += 1
      const gen = session.gen
      session.ended = false
      session.chunks = []
      session.totalSamples = 0
      session.stretcher = null
      session.speed = speed
      session.renderSpeed = speed
      playerStopSources(session)
      if (session.req) { try { session.req.abort() } catch {} }
      if (session.pendingNext) { clearTimeout(session.pendingNext); session.pendingNext = 0 }
      // A prefetched paragraph is already being synthesized, so its buffered
      // audio plays at once and the rest is handed over as it arrives.
      const prefetched = session.prefetch && session.prefetch.index === target ? session.prefetch : null
      if (prefetched) session.prefetch = null
      const controller = prefetched ? prefetched.controller : new AbortController()
      session.req = controller
      session.phase = session.desiredPaused ? 'paused' : 'loading'
      playerView({ unit: target, phase: session.phase, speed: session.speed, preview: previewOf(session.units[target]) })
      setPlayback({ key: session.key, phase: session.phase })
      if (session.desiredPaused) {
        try { void session.context.suspend().catch(() => {}) } catch {}
      }

      try {
        if (prefetched) {
          const record = prefetched
          playerEnsureStretcher(session)
          for (const chunk of record.chunks) playerFeedSamples(session, chunk, gen)
          record.chunks = []
          if (session.chunks.length > 0 && !session.desiredPaused) {
            session.phase = 'playing'
            playerView({ phase: 'playing' })
            setPlayback({ phase: 'playing' })
          }
          record.consumer = (samples) => {
            if (player !== session || session.gen !== gen) return
            if (session.phase === 'loading') {
              session.phase = 'playing'
              playerView({ phase: 'playing' })
              setPlayback({ phase: 'playing' })
            }
            playerFeedSamples(session, samples, gen)
          }
          playerPrefetch(session, target + 1)
          await record.finished
          if (player !== session || session.gen !== gen) return
          record.consumer = null
          if (controller.signal.aborted) return
          if (record.error) { fail(session.key, record.error); return }
          if (session.stretcher) {
            const tail = session.stretcher.flush()
            if (tail.length) playerSchedule(session, tail, gen)
          }
          playerEndUnit(session, gen)
          return
        }

        const response = await playerUnitRequest(session, target, controller.signal)
        const type = String(response.headers.get('content-type') || '')
        if (type.indexOf('application/json') !== -1) {
          let payload = null
          try { payload = await response.json() } catch {}
          throw new Error((payload && payload.error) || t('语音合成失败', 'Speech synthesis failed'))
        }
        if (!response.ok || !response.body) {
          throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')
        }
        if (player !== session || session.gen !== gen) return
        // The next paragraph is opened while this one plays.
        playerPrefetch(session, target + 1)
        const reader = response.body.getReader()
        controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) })
        playerEnsureStretcher(session)
        let rest = new Uint8Array(0)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (player !== session || session.gen !== gen) return
          const merged = concatBytes(rest, value)
          const samples = toFloat32(merged)
          rest = merged.slice(samples.length * 2)
          if (samples.length === 0) continue
          if (session.phase === 'loading') {
            session.phase = 'playing'
            playerView({ phase: 'playing' })
            setPlayback({ phase: 'playing' })
          }
          playerFeedSamples(session, samples, gen)
        }
        if (player !== session || session.gen !== gen) return
        if (session.stretcher) {
          const tail = session.stretcher.flush()
          if (tail.length) playerSchedule(session, tail, gen)
        }
        playerEndUnit(session, gen)
      } catch (error) {
        if (player !== session || session.gen !== gen) return
        if (controller.signal.aborted) return
        fail(session.key, error)
      }
    }

    // ------------------------------------------------ browser speech playback
    // Web Speech hands back no samples: there is nothing to cache, and the only
    // speed control is the utterance rate. The same floating window drives it.
    function speechTimersOff(session) {
      if (!session) return
      if (session.timer) { clearTimeout(session.timer); session.timer = 0 }
      if (session.watchdog) { clearTimeout(session.watchdog); session.watchdog = 0 }
    }

    function speakSpeechUnit(session, index, fromChar) {
      if (player !== session) return
      const synth = speechSynth()
      if (!synth) {
        fail(session.key, new Error(t('这个环境没有浏览器朗读能力', 'browser speech is not available here')))
        return
      }
      if (session.units.length === 0) return
      const target = Math.max(0, Math.min(index, session.units.length - 1))
      const unit = session.units[target] || {}
      const text = String(unit.text || '')
      const base = Math.max(0, Math.min(fromChar || 0, Math.max(0, text.length - 1)))
      session.unit = target
      session.boundary = base
      session.gen += 1
      const gen = session.gen
      speechTimersOff(session)
      try { synth.cancel() } catch {}
      session.phase = session.desiredPaused ? 'paused' : 'loading'
      playerView({ unit: target, phase: session.phase, speed: session.speed, preview: previewOf(unit) })
      setPlayback({ key: session.key, phase: session.phase })
      if (session.desiredPaused) {
        try { synth.pause() } catch {}
      }

      const utter = new window.SpeechSynthesisUtterance(text.slice(base))
      const voice = pickSpeechVoice()
      if (voice) { utter.voice = voice; utter.lang = voice.lang }
      utter.rate = Math.min(2, Math.max(0.5, Number(session.speed) || 1))
      utter.pitch = 1
      utter.volume = 1
      let started = false

      utter.onstart = () => {
        if (player !== session || session.gen !== gen) return
        started = true
        if (session.watchdog) { clearTimeout(session.watchdog); session.watchdog = 0 }
        if (session.desiredPaused) return
        session.phase = 'playing'
        playerView({ phase: 'playing' })
        setPlayback({ phase: 'playing' })
      }
      utter.onboundary = (event) => {
        if (player !== session || session.gen !== gen) return
        if (event && typeof event.charIndex === 'number') session.boundary = base + event.charIndex
      }
      utter.onend = () => {
        if (player !== session || session.gen !== gen) return
        speechTimersOff(session)
        session.boundary = 0
        if (session.unit + 1 >= session.units.length) { playerFinish(); return }
        session.timer = setTimeout(() => {
          session.timer = 0
          if (player === session) speakSpeechUnit(session, session.unit + 1, 0)
        }, PLAYER_UNIT_GAP_MS)
      }
      utter.onerror = (event) => {
        if (player !== session || session.gen !== gen) return
        const reason = (event && event.error) || 'unknown'
        if (reason === 'interrupted' || reason === 'canceled') return
        speechTimersOff(session)
        // Autoplay policy: speech driven by an event (auto-read) may be blocked
        // until the page sees a click. Say so instead of "failed".
        if (reason === 'not-allowed') {
          fail(session.key, new Error(t('浏览器要求页面上先有一次点击才允许发声：请点一下朗读按钮。',
            'the browser needs one click on this page before it may speak; press read')))
          return
        }
        fail(session.key, new Error(t('浏览器朗读失败：', 'browser speech failed: ') + reason))
      }
      // A cloud voice that cannot reach its vendor never fires onstart and never
      // fires onerror, so silence is the only signal.
      session.watchdog = setTimeout(() => {
        session.watchdog = 0
        if (started || player !== session) return
        const cloud = isCloudVoice(voice)
        // A desktop shell that stayed silent switches itself to the bridge, so
        // the next click does not wait eight seconds again.
        if (isDesktopShell) rememberSpeechVoice(BRIDGE_TARGET)
        fail(session.key, new Error(cloud
          ? t('这个云端音色 8 秒内没有出声（多半连不上厂商服务器），请换成 ⌂ 本地音色',
            'no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice')
          : isDesktopShell
            ? t('这个桌面外壳没能出声，已切换到朗读桥：再点一次朗读会在浏览器里读',
              'this desktop shell stayed silent; it now uses the bridge — press read again')
            : t('浏览器 8 秒内没有出声，可能被自动播放策略挡住，请再点一次朗读',
              'no sound in 8 s; the browser may be blocking autoplay — press read again')))
      }, SPEECH_FIRST_TIMEOUT_MS)

      // Chrome drops a speak() issued in the same tick as cancel(); yield first.
      session.timer = setTimeout(() => {
        session.timer = 0
        if (player !== session || session.gen !== gen) return
        try { synth.speak(utter) } catch (error) { fail(session.key, error) }
      }, 30)
    }

    async function startSpeechReadAloud(sessionId, messageId, stateKey, selection) {      refreshSpeechVoices()
      if (!speechCapable()) {
        fail(stateKey, new Error(t('这台环境没有浏览器语音', 'no browser voices here')))
        return
      }
      stopCurrentOnly()
      const session = {
        kind: 'speech',
        key: stateKey, sessionId, messageId, selection: selection || '',
        units: [], unit: 0, total: 0, phase: 'loading', desiredPaused: false,
        speed, boundary: 0, gen: 0, watchdog: 0, timer: 0,
        view: { open: true, unit: 0, total: 0, phase: 'loading', speed, preview: '' },
      }
      player = session
      current = { key: stateKey }
      playedMessages.add(stateKey)
      setPlayback({ key: stateKey, phase: 'loading', error: '' })
      updatePlayerWindow()
      try {
        const response = await fetch(PLAN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(sessionId && messageId ? { sessionId, messageId } : {}),
            ...(selection ? { text: selection } : {}),
          }),
        })
        const payload = await response.json().catch(() => null)
        if (player !== session) return
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || t('这条消息没有可朗读的文字', 'nothing to read here'))
        }
        const units = Array.isArray(payload.value && payload.value.units) ? payload.value.units : []
        if (units.length === 0) throw new Error(t('这条消息没有可朗读的文字', 'nothing to read here'))
        session.units = units
        session.total = units.length
        session.view.total = units.length
        session.view.preview = previewOf(units[0])
        updatePlayerWindow()
        speakSpeechUnit(session, 0, 0)
      } catch (error) {
        if (player !== session) return
        fail(stateKey, error)
      }
    }

    async function startReadAloud(sessionId, messageId, stateKey, options) {
      const selection = options && options.text ? String(options.text) : ''
      if (engineMode === 'browser') {
        refreshSpeechVoices()
        // Desktop: the bridge is the default and needs no voice list at all.
        if (usesBridge() || (!speechCapable() && isDesktopShell)) {
          setPlayback({ key: null, phase: 'idle', error: '' })
          // A selection read has no message id, so the text itself goes along.
          void openBridge({ sessionId, messageId, text: selection || undefined })
          return
        }
        if (!speechCapable()) {
          fail(stateKey, new Error(t('这个环境没有浏览器语音', 'no browser voices here')))
          return
        }
        await startSpeechReadAloud(sessionId, messageId, stateKey, selection)
        return
      }
      // Only the audible item is replaced: the waiting queue must survive, or
      // draining one entry would throw away the rest.
      stopCurrentOnly()
      // Must be created synchronously inside the click: the browser only lets a
      // gesture-created AudioContext produce sound.
      const context = new AudioContext({ sampleRate: SAMPLE_RATE })
      // Created on a path that may not follow a gesture (SSE-driven auto-read);
      // resume is a no-op once the page is allowed to play.
      void context.resume().catch(() => {})
      const controller = new AbortController()
      const session = {
        key: stateKey, sessionId, messageId, selection,
        context, controller,
        units: [], unit: 0, total: 0, standalone: false,
        phase: 'loading', desiredPaused: false, gen: 0,
        chunks: [], totalSamples: 0, sources: [], last: null,
        nextTime: 0, startTime: 0, stretcher: null,
        speed, renderSpeed: speed, ended: false, pendingNext: 0, prefetch: null, req: null,
        view: { open: true, unit: 0, total: 0, phase: 'loading', speed, preview: '' },
      }
      player = session
      current = { key: stateKey, controller, context }
      playedMessages.add(stateKey)
      setPlayback({ key: stateKey, phase: 'loading', error: '' })
      updatePlayerWindow()
      try {
        const response = await fetch(PLAN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(sessionId && messageId ? { sessionId, messageId } : {}),
            ...(selection ? { text: selection } : {}),
          }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || t('这条消息没有可朗读的文字', 'nothing to read here'))
        }
        if (player !== session) return
        const value = payload.value || {}
        const units = Array.isArray(value.units) ? value.units : []
        if (units.length === 0) throw new Error(t('这条消息没有可朗读的文字', 'nothing to read here'))
        session.units = units
        session.total = units.length
        session.standalone = value.standalone === true
        session.view.total = units.length
        session.view.preview = previewOf(units[0])
        updatePlayerWindow()
        await playerPlayUnit(session, 0)
      } catch (error) {
        if (player !== session) return
        if (controller.signal.aborted) return
        fail(stateKey, error)
      }
    }

    // ------------------------------------------------------- floating window
    function playerView(patch) {
      if (!player) return
      Object.assign(player.view, patch)
      updatePlayerWindow()
    }

    const PLAYER_POS_KEY = 'dsh-tts-reader:player-pos'

    function storedPlayerPos() {
      try {
        const raw = window.localStorage.getItem(PLAYER_POS_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return parsed
      } catch {}
      return null
    }

    function savePlayerPos(left, top) {
      try { window.localStorage.setItem(PLAYER_POS_KEY, JSON.stringify({ left, top })) } catch {}
    }

    function makePlayerButton(text, title) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = text
      button.title = title
      button.style.cssText = 'box-sizing:border-box;height:26px;min-width:30px;padding:0 6px;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:8px;background:transparent;'
        + 'color:inherit;font-size:13px;line-height:1;font-family:inherit;cursor:pointer'
      return button
    }

    function buildPlayerWindow() {
      if (playerWindowEl) return playerWindowEl
      if (typeof document === 'undefined' || !document.body) return null
      const wrap = document.createElement('div')
      try { wrap.setAttribute('popover', 'manual') } catch {}
      wrap.style.cssText = 'position:fixed;inset:auto 20px 20px auto;margin:0;padding:0;z-index:2147483645;display:none;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#1c1c1c);'
        + 'color:var(--dsw-alias-label-primary,#eee);box-shadow:0 10px 30px rgba(0,0,0,.4);font-size:12px;'
        + 'font-family:inherit;min-width:288px;max-width:360px;user-select:none'
      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;'
        + 'border-bottom:1px solid var(--dsw-alias-border-l2,#3a3a3a);touch-action:none'
      const title = document.createElement('span')
      title.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600'
      title.textContent = t('语音朗读', 'Read aloud')
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.title = t('停止朗读', 'Stop reading')
      close.style.cssText = 'padding:2px 6px;border:0;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7'
      close.onclick = () => stopPlayback()
      head.append(title, close)

      const meta = document.createElement('div')
      meta.style.cssText = 'padding:6px 10px 0;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      const controls = document.createElement('div')
      controls.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 10px'
      const prev = makePlayerButton('⏮', t('上一段', 'Previous paragraph'))
      const play = makePlayerButton('⏸', t('暂停 / 继续', 'Pause / resume'))
      const next = makePlayerButton('⏭', t('下一段', 'Next paragraph'))
      prev.onclick = () => playerStep(-1)
      next.onclick = () => playerStep(1)
      play.onclick = () => playerTogglePause()

      const speedBox = document.createElement('div')
      speedBox.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto'
      const speedInput = document.createElement('input')
      speedInput.type = 'range'
      speedInput.min = '0.5'
      speedInput.max = '2'
      speedInput.step = '0.05'
      speedInput.title = t('播放速度', 'Playback speed')
      speedInput.style.cssText = 'width:88px;margin:0;accent-color:var(--dsw-alias-state-business-primary,#3b82f6)'
      const speedValue = document.createElement('span')
      speedValue.style.cssText = 'width:38px;text-align:right;font-variant-numeric:tabular-nums'
      speedInput.oninput = () => {
        const value = playerClampSpeed(speedInput.value)
        speedValue.textContent = value.toFixed(2) + '×'
        playerApplySpeed(value)
      }
      speedBox.append(speedInput, speedValue)
      controls.append(prev, play, next, speedBox)

      // Drag by the header; the position survives reloads.
      let drag = null
      head.addEventListener('pointerdown', (event) => {
        if (event.target === close) return
        const rect = wrap.getBoundingClientRect()
        drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
        try { head.setPointerCapture(event.pointerId) } catch {}
        event.preventDefault()
      })
      head.addEventListener('pointermove', (event) => {
        if (!drag) return
        const left = Math.max(8, Math.min(Math.max(8, window.innerWidth - 120), drag.left + event.clientX - drag.x))
        const top = Math.max(8, Math.min(Math.max(8, window.innerHeight - 80), drag.top + event.clientY - drag.y))
        wrap.style.left = left + 'px'
        wrap.style.top = top + 'px'
        wrap.style.right = 'auto'
        wrap.style.bottom = 'auto'
      })
      const endDrag = () => {
        if (!drag) return
        drag = null
        const rect = wrap.getBoundingClientRect()
        savePlayerPos(rect.left, rect.top)
      }
      head.addEventListener('pointerup', endDrag)
      head.addEventListener('pointercancel', endDrag)

      wrap.append(head, meta, controls)
      document.body.appendChild(wrap)
      try { if (typeof wrap.showPopover === 'function') wrap.showPopover() } catch {
        try { wrap.removeAttribute('popover') } catch {}
      }
      playerWindowEl = wrap
      wrap.__parts = { wrap, title, meta, prev, play, next, speedInput, speedValue }
      const saved = storedPlayerPos()
      if (saved) {
        wrap.style.left = saved.left + 'px'
        wrap.style.top = saved.top + 'px'
        wrap.style.right = 'auto'
        wrap.style.bottom = 'auto'
      }
      return wrap
    }

    function updatePlayerWindow() {
      const wrap = buildPlayerWindow()
      if (!wrap) return
      if (!player) {
        wrap.style.display = 'none'
        return
      }
      const parts = wrap.__parts
      const view = player.view
      wrap.style.display = 'block'
      try {
        if (typeof wrap.showPopover === 'function' && !wrap.matches(':popover-open')) wrap.showPopover()
      } catch {}
      parts.title.textContent = view.phase === 'paused' ? t('已暂停', 'Paused') : t('语音朗读', 'Read aloud')
      const progress = view.total > 1 ? (Math.min(view.unit + 1, view.total) + '/' + view.total + ' · ') : ''
      parts.meta.textContent = progress + (view.preview || '')
      parts.play.textContent = view.phase === 'paused' ? '▶' : '⏸'
      parts.play.title = view.phase === 'paused' ? t('继续', 'Resume') : t('暂停', 'Pause')
      parts.play.disabled = view.phase === 'loading'
      parts.prev.disabled = view.unit <= 0
      parts.next.disabled = view.unit >= view.total - 1
      const speedText = (Number(view.speed) || 1)
      parts.speedInput.value = String(speedText)
      parts.speedValue.textContent = speedText.toFixed(2) + '×'
    }

    function fail(key, error) {
      if (!player || player.key !== key) return
      const message = (error && error.message) || String(error)
      playerStop()
      setPlayback({ key, phase: 'idle', error: message })
      // The button only keeps the text in a tooltip, which is gone as soon as
      // the pointer moves; put the failure where it can be read and copied.
      console.warn('[dsh-tts-reader] playback failed:', message)
      showFailureToast(message)
      drainQueue()
    }

    // A dismissible top-layer card for playback failures. Popover keeps it above
    // modals and transforms, the same trick the request-card button uses.
    let toastEl = null
    let toastTimer = 0

    function hideFailureToast() {
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0 }
      const node = toastEl
      toastEl = null
      if (!node) return
      try { if (node.matches && node.matches(':popover-open')) node.hidePopover() } catch {}
      try { node.remove() } catch {}
    }

    function showFailureToast(message, tone) {
      if (typeof document === 'undefined' || !document.body) return
      const ok = tone === 'ok'
      hideFailureToast()
      const node = document.createElement('div')
      try { node.setAttribute('popover', 'manual') } catch {}
      node.setAttribute('role', 'alert')
      node.style.cssText = 'position:fixed;inset:auto 16px 16px auto;margin:0;z-index:2147483646;'
        + 'max-width:min(420px,calc(100vw - 32px));padding:11px 34px 12px 13px;border-radius:10px;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#1c1c1c);'
        + 'color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.5;'
        + 'box-shadow:0 8px 28px rgba(0,0,0,.38);font-family:inherit'
      const title = document.createElement('div')
      title.textContent = ok ? t('已交给浏览器', 'Sent to the browser') : t('朗读失败', 'Playback failed')
      title.style.cssText = 'font-weight:600;margin-bottom:4px;color:' + (ok ? '#30a46c' : '#e5484d')
      const body = document.createElement('div')
      body.textContent = String(message || '')
      body.style.cssText = 'white-space:pre-wrap;word-break:break-word;user-select:text;cursor:text'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.setAttribute('aria-label', t('关闭', 'Dismiss'))
      close.style.cssText = 'position:absolute;top:3px;right:4px;padding:2px 6px;border:0;background:transparent;'
        + 'color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7'
      close.onclick = hideFailureToast
      node.append(title, body, close)
      document.body.appendChild(node)
      try { if (typeof node.showPopover === 'function') node.showPopover() } catch {
        // Without the top layer the fixed position still works, but a popover
        // left unshown would stay display:none.
        try { node.removeAttribute('popover') } catch {}
      }
      toastEl = node
      toastTimer = setTimeout(hideFailureToast, ok ? 5000 : 30000)
    }

    function SpeakerIcon() {
      // Rounded speaker + two arcs, adapted from Lucide's volume-2 icon (ISC,
      // see THIRD_PARTY.md); the web client renders the same shape.
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', {
          d: 'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z',
          key: 'body',
        }),
        h('path', { d: 'M16 9a5 5 0 0 1 0 6', key: 'wave-1' }),
        h('path', { d: 'M19.4 18.4a9 9 0 0 0 0-12.8', key: 'wave-2' }),
      )
    }

    function ReadingBars({ mode }) {
      return h('span', {
        className: 'dsh-tts-bars'
          + (mode === 'loading' ? ' is-loading' : '')
          + (mode === 'paused' ? ' is-paused' : ''),
        'aria-hidden': true,
        children: [0, 1, 2, 3].map((index) => h('i', { key: index, style: { animationDelay: (index * 0.12) + 's' } })),
      })
    }

    function SessionTracker(props) {
      const sessionId = props && props.sessionId
      const previous = React.useRef(null)
      React.useEffect(() => {
        if (!sessionId) return
        const next = String(sessionId)
        // Leaving the session must not keep speaking into the new one.
        if (previous.current !== null && previous.current !== next) {
          stopPlayback()
        }
        previous.current = next
        activeSessionId = next
      }, [sessionId])
      return null
    }

    // Floating replay button for a pending question or approval. The request
    // dialog covers the composer, so this lives on the frame-wide overlay and
    // stays clickable above it.
    function subscribePlayback(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }

    // Replay button for a pending question or approval. It is mounted straight
    // into the request card's own header row, so it neither floats over the card
    // nor depends on either UI package; the top-layer fallback only covers a
    // native modal <dialog>, which makes everything outside it inert.
    function mountPromptButton() {
      if (typeof document === 'undefined' || !document.body) return () => {}
      // Two mount modes. Inside a request card the button is an ordinary child
      // of the card's header row (no top layer needed, no overlap). Otherwise it
      // floats in the browser top layer so a native modal <dialog> cannot cover
      // it — the popover UA stylesheet sets `inset: 0`, hence explicit sides.
      const FLOAT_STYLE = 'position:fixed;left:auto;bottom:auto;z-index:2147483647;display:none;'
        + 'margin:0;padding:0;border:0;background:transparent;overflow:visible'
      const CARD_STYLE = 'position:static;top:auto;right:auto;display:none;z-index:auto;'
        + 'margin:0 0 0 auto;padding:0;border:0;background:transparent;overflow:visible;'
        + 'align-self:center;flex:0 0 auto'
      const BUTTON_BASE = 'display:inline-flex;align-items:center;gap:6px;white-space:nowrap;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);'
        + 'background:var(--dsw-alias-bg-layer-2,#1c1c1c);color:var(--dsw-alias-label-primary,#eee);'
        + 'font-size:12px;font-family:inherit;cursor:pointer'

      const wrap = document.createElement('div')
      try { wrap.setAttribute('popover', 'manual') } catch {}
      wrap.style.cssText = FLOAT_STYLE
      const button = document.createElement('button')
      button.type = 'button'
      button.style.cssText = BUTTON_BASE
      const styleButton = (compact) => {
        button.style.height = compact ? '24px' : '28px'
        button.style.padding = compact ? '0 8px' : '0 10px'
        button.style.borderRadius = compact ? '12px' : '14px'
        button.style.boxShadow = compact ? 'none' : '0 2px 8px rgba(0,0,0,.32)'
      }
      styleButton(false)
      const iconEl = document.createElement('span')
      iconEl.textContent = '🔊'
      const labelEl = document.createElement('span')
      button.appendChild(iconEl)
      button.appendChild(labelEl)
      wrap.appendChild(button)
      document.body.appendChild(wrap)
      let removed = false

      // Request surfaces are NOT native <dialog> elements: an approval or a
      // question takes over the composer seat and renders as ordinary DOM with
      // a stable data hook. Neither package exposes an extension slot inside the
      // card (approval has only the single `conversation.approval.detail` seat
      // that the command detail already owns; the question card renders none),
      // so the button is mounted as a real child of the card's header row.
      const ANCHOR_ROOTS = ['[data-approval-key]', '[data-question-key]']
      const CORNER_INSET = 10
      const BUTTON_LIFT = 32
      const EDGE_MIN = 8

      // Fixed offsets resolve against the nearest ancestor with a transform,
      // filter, perspective or contain — not the viewport. Return that box so a
      // measured card rect can be converted into the right coordinate space.
      const offsetBase = () => {
        let node = wrap.parentElement
        while (node && node !== document.documentElement && node !== document.body) {
          let style
          try { style = getComputedStyle(node) } catch { style = null }
          if (style) {
            const contain = String(style.contain || '')
            if ((style.transform && style.transform !== 'none')
              || (style.filter && style.filter !== 'none')
              || (style.perspective && style.perspective !== 'none')
              || String(style.willChange || '').includes('transform')
              || /paint|layout|strict|content/.test(contain)) {
              return node.getBoundingClientRect()
            }
          }
          node = node.parentElement
        }
        return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      }

      const anchorRoot = () => {
        for (const selector of ANCHOR_ROOTS) {
          let root = null
          try { root = document.querySelector(selector) } catch { root = null }
          if (root && !wrap.contains(root)) return root
        }
        return null
      }

      // The visible card inside an anchor root. Takeover roots are full-width
      // centering wrappers, so the card is usually the first element child; a
      // screen-filling wrapper needs the largest child instead.
      const cardElement = (root) => {
        const rect = root.getBoundingClientRect()
        if (rect.width < 80 || rect.height < 60) return null
        const viewport = Math.max(window.innerWidth * window.innerHeight, 1)
        if (rect.width * rect.height > viewport * 0.85) {
          let best = null
          let bestArea = 0
          for (const child of root.querySelectorAll('section,div,form,article')) {
            if (wrap.contains(child)) continue
            const r = child.getBoundingClientRect()
            if (r.width < 200 || r.height < 60) continue
            if (r.width * r.height > viewport * 0.85) continue
            const area = r.width * r.height
            if (area > bestArea) { best = child; bestArea = area }
          }
          if (best) return best
        }
        const child = root.firstElementChild
        if (child && !wrap.contains(child)) {
          const r = child.getBoundingClientRect()
          if (r.width >= 200 && r.height >= 60) return child
        }
        return root
      }

      const anchorCard = () => {
        const root = anchorRoot()
        return root ? cardElement(root) : null
      }

      // The header row of a request card: question cards use <header> and end
      // with their icon buttons; approval cards lead with a status strip.
      const headerRow = (card) => {
        let header = null
        try { header = card.querySelector('header') } catch { header = null }
        if (!header) {
          const first = card.firstElementChild
          if (!first) return null
          const rect = first.getBoundingClientRect()
          if (rect.height <= 0 || rect.height > 64) return null
          header = first
        }
        // Sit left of the card's own icon cluster when there is one, so the
        // button never lands after the close control. A header whose only child
        // is that cluster appends instead.
        const last = header.lastElementChild
        if (last && last !== wrap) {
          const cluster = last.children.length > 0 && last.getBoundingClientRect().width < 160
          if (cluster && header.children.length > 1) return { row: header, before: last }
        }
        return { row: header, before: null }
      }

      const applyMode = (mode) => {
        if (mode === 'card') {
          wrap.style.cssText = CARD_STYLE
          styleButton(true)
          return
        }
        wrap.style.cssText = FLOAT_STYLE
        try { if (!wrap.hasAttribute('popover')) wrap.setAttribute('popover', 'manual') } catch {}
        styleButton(false)
      }

      // True when the button now lives inside the card's header row.
      const seatInCard = (card) => {
        const seat = headerRow(card)
        if (!seat) return false
        if (wrap.parentNode !== seat.row) {
          try { if (wrap.hasAttribute('popover')) wrap.removeAttribute('popover') } catch {}
          if (seat.before) seat.row.insertBefore(wrap, seat.before)
          else seat.row.appendChild(wrap)
          applyMode('card')
          return true
        }
        if (seat.before && wrap.nextElementSibling !== seat.before) {
          seat.row.insertBefore(wrap, seat.before)
        }
        return true
      }

      let placeFrame = 0
      const place = () => {
        placeFrame = 0
        if (removed) return
        // In-card placement is ordinary flow layout; only the floating fallback
        // needs computed coordinates.
        if (!wrap.hasAttribute('popover')) return
        const base = offsetBase()
        const card = anchorCard()
        const cardRect = card ? card.getBoundingClientRect() : null
        // Offsets are relative to `base`, which is the viewport for a plain
        // fixed element but an ancestor box when that ancestor creates a
        // containing block, so everything is measured against base.top/right.
        let top
        let right
        if (cardRect) {
          const cardTop = cardRect.top - base.top
          // Sit on the card's top edge, right-aligned; fall inside when the
          // card already touches the top of the screen.
          top = cardTop - BUTTON_LIFT
          if (top < EDGE_MIN) top = cardTop + EDGE_MIN
          right = base.right - cardRect.right + CORNER_INSET
        } else {
          top = 56
          right = CORNER_INSET + 8
        }
        const maxTop = Math.max((base.bottom - base.top) - 36, EDGE_MIN)
        top = Math.min(Math.max(top, EDGE_MIN), maxTop)
        right = Math.max(right, EDGE_MIN)
        wrap.style.top = Math.round(top) + 'px'
        wrap.style.right = Math.round(right) + 'px'
        wrap.style.left = 'auto'
        wrap.style.bottom = 'auto'
      }

      const schedulePlace = () => {
        if (placeFrame) return
        try { placeFrame = requestAnimationFrame(place) } catch { placeFrame = 0; place() }
      }

      // Request dialogs animate in, so the corner keeps moving for a moment
      // after they appear: poll the position briefly instead of trusting one
      // measurement.
      let settleTimer = 0
      const settlePlace = () => {
        try { clearInterval(settleTimer) } catch {}
        let ticks = 12
        settleTimer = setInterval(() => {
          place()
          if (--ticks <= 0) { try { clearInterval(settleTimer) } catch {} settleTimer = 0 }
        }, 50)
      }

      let sizeObserver = null
      let observedElement = null
      const watchLayout = () => {
        if (removed) return
        const target = anchorCard()
        if (target === observedElement) return
        if (sizeObserver) { try { sizeObserver.disconnect() } catch {} sizeObserver = null }
        observedElement = target
        if (!target || typeof ResizeObserver !== 'function') return
        try {
          sizeObserver = new ResizeObserver(() => schedulePlace())
          sizeObserver.observe(target)
        } catch { sizeObserver = null }
      }

      const onViewportChange = () => { watchLayout(); schedulePlace() }
      window.addEventListener('resize', onViewportChange)
      document.addEventListener('scroll', schedulePlace, true)

      let pending = null
      let lastSpoken = null
      let raisedFor = null
      let spokenFor = null

      const keyOf = (value) => 'prompt:' + (value.kind === 'approval' ? 'approval:' : '') + value.id
      const isPlaying = () => !!(current && pending && current.key === keyOf(pending))

      const raisePopover = () => {
        if (!wrap.hasAttribute('popover')) return
        try {
          if (typeof wrap.hidePopover === 'function') wrap.hidePopover()
        } catch {}
        try {
          if (typeof wrap.showPopover === 'function') wrap.showPopover()
        } catch {}
      }
      const dropPopover = () => {
        if (!wrap.hasAttribute('popover')) return
        try { if (typeof wrap.hidePopover === 'function') wrap.hidePopover() } catch {}
      }

      // Preferred mount: a real child of the request card's header row. Fallback
      // (no card, e.g. a native modal dialog): float in the top layer, and live
      // inside the dialog when one is open because it makes the rest inert.
      const adopt = () => {
        try {
          const card = anchorCard()
          if (card && seatInCard(card)) { watchLayout(); return }
        } catch {}
        try {
          applyMode('float')
          const dialog = document.querySelector('dialog[open]')
          const target = dialog || document.body
          if (wrap.parentNode !== target) target.appendChild(wrap)
          // A popover that is not open is display:none by UA rule, so entering
          // the floating mode has to reopen it.
          let open = false
          try { open = typeof wrap.matches === 'function' && wrap.matches(':popover-open') } catch { open = false }
          if (!open) raisePopover()
          settlePlace()
          watchLayout()
        } catch {}
      }

      const render = () => {
        if (removed) return
        if (!pending || !pending.text) { wrap.style.display = 'none'; dropPopover(); return }
        wrap.style.display = 'flex'
        const playing = isPlaying()
        // A queued request waits behind the audio that is already playing;
        // clicking cuts in and starts it immediately.
        const waiting = !!pending && isQueued(keyOf(pending))
        const label = pending.kind === 'approval' ? t('朗读授权', 'Read request') : t('朗读问题', 'Read question')
        const waitingLabel = t('等待上条朗读完成', 'Waiting for the current read')
        if (waiting && !playing) {
          iconEl.textContent = '⏳'
          labelEl.textContent = waitingLabel
          button.title = t('正在朗读上一条，点击可切断并立即朗读这一条', 'Reading the previous item — click to cut in and read this now')
        } else {
          iconEl.textContent = playing ? '⏹' : '🔊'
          labelEl.textContent = playing ? t('停止', 'Stop') : label
          button.title = playing ? t('点击停止', 'Click to stop') : label
        }
        schedulePlace()
      }

      const tick = () => {
        fetch(PENDING_PATH, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => {
            if (removed || !body || !body.ok) return
            pending = body.value || null
            // The request is over once it leaves /pending: an answered approval
            // or question must not keep talking.
            const nextKey = pending && pending.text ? keyOf(pending) : null
            if (spokenFor !== null && spokenFor !== nextKey) {
              if (current && current.key === spokenFor) stopCurrentOnly()
              dropQueued(spokenFor)
            }
            spokenFor = nextKey
            adopt()
            // The takeover card can mount a beat after the request exists, so
            // re-resolve the anchor on every poll.
            watchLayout()
            if (pending && pending.text) {
              // Re-raise on every new request: the dialog may have opened since.
              if (pending.id !== raisedFor) { raisePopover(); raisedFor = pending.id; settlePlace() }
              if (pending.id !== lastSpoken) {
                const enabled = pending.kind === 'approval' ? speakApprovals : speakQuestions
                if (enabled) {
                  lastSpoken = pending.id
                  // Queues behind the audio already playing; the button cuts in.
                  autoReadPrompt(keyOf(pending), pending.text)
                }
              }
            } else {
              raisedFor = null
            }
            render()
          })
          .catch(() => {})
      }

      button.addEventListener('click', () => {
        if (!pending) return
        const key = keyOf(pending)
        // Waiting state: cut the current audio and speak this request now.
        if (isQueued(key)) {
          speakNow(key, () => { void startReadAloud(null, null, key, { text: pending.text }) })
          return
        }
        if (isPlaying()) { stopPlayback(); render(); return }
        speakNow(key, () => { void startReadAloud(null, null, key, { text: pending.text }) })
        setTimeout(render, 60)
      })

      const timer = setInterval(tick, 2000)
      const off = subscribePlayback(render)
      // The button lives outside React, so it subscribes to language changes
      // itself.
      const localeListener = () => render()
      localeListeners.push(localeListener)
      tick()
      return () => {
        removed = true
        clearInterval(timer)
        localeListeners = localeListeners.filter(entry => entry !== localeListener)
        try { clearInterval(settleTimer) } catch {}
        if (placeFrame) { try { cancelAnimationFrame(placeFrame) } catch {} placeFrame = 0 }
        if (sizeObserver) { try { sizeObserver.disconnect() } catch {} sizeObserver = null }
        try { window.removeEventListener('resize', onViewportChange) } catch {}
        try { document.removeEventListener('scroll', schedulePlace, true) } catch {}
        try { off() } catch {}
        try { wrap.remove() } catch {}
      }
    }

    function ReadAloudAction(props) {
      const messageId = props && props.messageId
      const sessionId = props && props.sessionId
      const key = String(sessionId) + ':' + String(messageId)
      const state = usePlayback()
      const selectionRef = React.useRef('')
      useLocaleTick()
      React.useEffect(() => {
        if (sessionId) activeSessionId = String(sessionId)
      }, [sessionId])
      const mine = state.key === key
      const phase = mine ? state.phase : 'idle'
      const error = mine ? state.error : ''
      const cached = playedMessages.has(key)

      const title = error
        ? error
        : phase === 'loading'
          ? t('正在合成…', 'Synthesizing…')
          : phase === 'playing'
            ? t('点击停止（悬浮窗可暂停、前后翻段）', 'Click to stop (the floating window pauses and steps)')
            : phase === 'paused'
              ? t('已暂停；点悬浮窗继续', 'Paused — resume from the floating window')
              : cached
                ? t('再次播放（本地缓存）', 'Play again (cached)')
                : t('朗读这条回复（选中文字则读它所在的整段）', 'Read this reply aloud (the paragraphs around the selection)')

      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        // Capture the selection before mousedown clears it.
        onMouseDown: () => {
          try { selectionRef.current = String(window.getSelection() || '').trim() } catch { selectionRef.current = '' }
        },
        onClick: () => {
          if (phase === 'loading' || phase === 'playing' || phase === 'paused') { stopPlayback(); return }
          const selected = selectionRef.current.slice(0, 4000)
          // A manual read is a deliberate override: it drops the queue.
          speakNow(key, () => {
            void startReadAloud(sessionId, messageId, key, selected ? { text: selected } : undefined)
          })
        },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          height: '24px', minWidth: '22px', padding: '0 3px', border: 'none',
          background: 'transparent', cursor: 'pointer', borderRadius: '4px',
          color: error ? '#e5484d' : 'var(--dsw-alias-label-secondary)',
          opacity: phase === 'idle' && !cached ? 0.9 : 1,
        },
        children: [
          phase === 'idle' ? h(SpeakerIcon, { key: 'icon' }) : h(ReadingBars, { mode: phase, key: 'bars' }),
          error ? h('span', { key: 'mark' }, '!') : null,
        ],
      })
    }

    // Numeric settings commit on Enter or blur, never per keystroke: typing
    // "512" used to send three saves (5, 51, 512), each of which reset the
    // client cache and refetched the config.
    function NumberInput(props) {
      const value = props && props.value
      const min = props && typeof props.min === 'number' ? props.min : 0
      const max = props && typeof props.max === 'number' ? props.max : 999999
      const onCommit = props && props.onCommit
      const [draft, setDraft] = React.useState(null)

      const commit = () => {
        const raw = draft
        setDraft(null)
        if (raw === null || String(raw).trim() === '') return
        const parsed = Number(String(raw).trim())
        if (!Number.isFinite(parsed)) return
        const next = Math.min(max, Math.max(min, Math.floor(parsed)))
        if (next === value || typeof onCommit !== 'function') return
        onCommit(next)
      }

      return h('input', {
        className: props.className,
        type: 'number', min: min, max: max, step: props.step, disabled: props.disabled,
        value: draft === null ? (value === undefined || value === null ? '' : value) : draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            try { event.currentTarget.blur() } catch {}
          } else if (event.key === 'Escape') {
            setDraft(null)
            try { event.currentTarget.blur() } catch {}
          }
        },
      })
    }

    // Text fields commit on Enter or blur, like the numeric ones: typing a path
    // must not POST the settings file on every keystroke.
    function TextInput(props) {
      const value = props && typeof props.value === 'string' ? props.value : ''
      const onCommit = props && props.onCommit
      const [draft, setDraft] = React.useState(null)

      const commit = () => {
        const raw = draft
        setDraft(null)
        if (raw === null) return
        const next = String(raw).trim()
        if (next === value || typeof onCommit !== 'function') return
        onCommit(next)
      }

      return h('input', {
        className: props.className,
        type: props.type === 'password' ? 'password' : 'text',
        placeholder: props.placeholder,
        spellCheck: false,
        disabled: props.disabled,
        value: draft === null ? value : draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            try { event.currentTarget.blur() } catch {}
          } else if (event.key === 'Escape') {
            setDraft(null)
            try { event.currentTarget.blur() } catch {}
          }
        },
      })
    }

    // Multi-line companion to TextInput for JSON headers/bodies. It commits on
    // blur only: Enter has to stay available for newlines.
    function TextAreaInput(props) {
      const value = typeof props.value === 'string' ? props.value : ''
      const onCommit = props.onCommit
      const [draft, setDraft] = React.useState(null)

      const commit = () => {
        const raw = draft
        setDraft(null)
        if (raw === null) return
        const next = String(raw).trim()
        if (next === value || typeof onCommit !== 'function') return
        onCommit(next)
      }

      return h('textarea', {
        className: props.className,
        rows: props.rows || 3,
        placeholder: props.placeholder,
        spellCheck: false,
        disabled: props.disabled,
        value: draft === null ? value : draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            setDraft(null)
            try { event.currentTarget.blur() } catch {}
          }
        },
      })
    }

    // Offline installation guide. A native <dialog> keeps it in the browser top
    // layer, so the settings pane's own scroll box cannot clip it, and Escape or
    // a backdrop click close it without extra listeners.
    function InstallGuide(props) {
      const open = props && props.open === true
      const onClose = props && typeof props.onClose === 'function' ? props.onClose : () => {}
      const ref = React.useRef(null)

      React.useEffect(() => {
        const node = ref.current
        if (!node) return
        if (open) {
          try { if (!node.open && typeof node.showModal === 'function') node.showModal() } catch {}
        } else {
          try { if (node.open) node.close() } catch {}
        }
      }, [open])

      if (!open) return null

      const link = (key, href, text) => h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, text)

      return h('dialog', {
        ref,
        className: 'dsh-tts-dialog',
        onClose,
        // A backdrop click lands on the <dialog> element itself.
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', { className: 'dsh-tts-dialog-head', key: 'head' },
          h('span', { className: 'dsh-tts-dialog-title', key: 'title' }, t('离线安装 Piper', 'Install Piper offline')),
          h('button', { key: 'close', className: 'dsh-tts-close', type: 'button', 'aria-label': t('关闭', 'Close'), onClick: onClose }, '×'),
        ),
        h('div', { className: 'dsh-tts-dialog-body', key: 'body' },
          h('div', { key: 'intro' }, t(
            '插件只负责朗读，不含 Piper 程序和语音模型。装好一次之后，合成完全离线、不花钱。',
            'This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.')),
          h('ol', { key: 'steps' },
            h('li', { key: 's1' }, t(
              '准备程序：取一个 piper 可执行文件。只用「花颜」的话，2023 版自包含包即可（约 37 MB，解压即用）；要用「超文 / 小雅」得装 Python 3.9–3.12 的 pip 版：pip install "piper-tts[zh]"。',
              'Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install "piper-tts[zh]".')),
            h('li', { key: 's2' }, t(
              '准备音色：一个音色是「.onnx + 同名 .json」两个文件，放进同一个目录（各约 60 MB）。超文 / 小雅 还要求该目录下有 g2pW/（约 260 MB）和 BERT 分词器（约 0.1 MB）。',
              'Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.')),
            h('li', { key: 's3' }, t(
              '填路径：回到上方，引擎选「本地 Piper」，填好「程序」与「音色模型」，状态变成「已就绪」就能离线朗读。',
              'Fill it in: pick "Local Piper" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.')),
          ),
          h('div', { className: 'dsh-tts-kv', key: 'size' }, t(
            '占用参考：花颜 ≈ 97 MB（程序 37 + 模型 60）；超文 / 小雅 ≈ 660 MB（再加 g2pW 与分词器）。',
            'Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.')),
          h('div', { className: 'dsh-tts-dialog-foot', key: 'links' },
            t('程序：', 'Program: '), link('piper', 'https://github.com/OHF-Voice/piper1-gpl', 'piper1-gpl'),
            t('，旧版也能用：', '; the older build works too: '), link('rhasspy', 'https://github.com/rhasspy/piper', 'rhasspy/piper'),
            h('br', { key: 'br' }),
            t('模型：', 'Voices: '), link('voices', 'https://huggingface.co/rhasspy/piper-voices', 'rhasspy/piper-voices'),
            t('，国内可用镜像 HF_ENDPOINT=https://hf-mirror.com。', '; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.'),
          ),
          h('div', { className: 'dsh-tts-dialog-foot', key: 'legal' }, t(
            'Piper 与 espeak-ng 是 GPL-3.0，语音模型各自另有限制条款；本插件不分发这些文件。',
            'Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.')),
        ),
      )
    }

    function TtsSettings() {
      const [config, setConfig] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // The speed slider previews while dragging and only saves on release, so
      // one drag is one write instead of dozens.
      const [speedDraft, setSpeedDraft] = React.useState(null)
      const [guideOpen, setGuideOpen] = React.useState(false)
      const [previewState, setPreviewState] = React.useState(previewPhase)
      // Browser voices arrive asynchronously (voiceschanged); re-render when they do.
      const [voices, setVoices] = React.useState(() => refreshSpeechVoices().slice())
      useLocaleTick()

      React.useEffect(() => {
        const sync = () => setVoices(refreshSpeechVoices().slice())
        sync()
        const synth = speechSynth()
        if (!synth) return
        const timer = setTimeout(sync, 900)
        try { synth.addEventListener('voiceschanged', sync) } catch {}
        return () => {
          clearTimeout(timer)
          try { synth.removeEventListener('voiceschanged', sync) } catch {}
        }
      }, [])

      const load = React.useCallback(() => {
        fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => { if (body && body.ok) { setConfig(body.value); applyRemoteConfig(body.value) } })
          .catch(() => {})
      }, [])

      React.useEffect(() => { load() }, [load])
      // The preview button follows the module-level player, and leaving the page
      // stops a sample that is still playing.
      React.useEffect(() => subscribePreview(setPreviewState), [])
      React.useEffect(() => () => { stopPreview() }, [])

      const save = async (patch) => {
        setBusy(true); setNotice(''); setFailure('')
        try {
          const response = await fetch(CONFIG_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const body = await response.json()
          if (!body || body.ok !== true) throw new Error((body && body.error) || t('保存失败', 'Save failed'))
          setConfig(body.value)
          applyRemoteConfig(body.value)
          playedMessages.clear()
          setNotice(t('已保存', 'Saved'))
          // The sample was rendered by the previous settings; do not keep playing.
          stopPreview()
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const MIN_CACHE_MB = 50
      const MAX_CACHE_MB = 4096

      const commitSpeed = () => {
        const raw = speedDraft
        setSpeedDraft(null)
        if (raw === null) return
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) return
        const next = Math.round(Math.min(2, Math.max(0.5, parsed)) * 100) / 100
        if (config && next === config.speed) return
        void save({ speed: next })
      }

      if (!config) return h('div', { style: { padding: '4px 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, t('加载中…', 'Loading…'))

      const cacheMb = (config.cache && config.cache.bytes ? config.cache.bytes / 1048576 : 0).toFixed(1)
      const cacheLimit = config.cacheMaxMb || 200
      const cachePct = Math.min(100, Math.round(((config.cache && config.cache.bytes ? config.cache.bytes : 0) / (cacheLimit * 1048576)) * 100))
      // Where the synthesized audio lives: the cache folder, or RAM only.
      const cacheMode = config.cacheMode === 'memory' ? 'memory' : 'disk'
      const memCache = (config.cache && config.cache.memory) || { files: 0, bytes: 0, limitBytes: 134217728 }
      const memMb = (memCache.bytes / 1048576).toFixed(1)
      const memLimitMb = ((memCache.limitBytes || 134217728) / 1048576).toFixed(0)
      const memPct = Math.min(100, Math.round((memCache.bytes / (memCache.limitBytes || 134217728)) * 100))
      const piper = config.piper || { exe: false, model: false, modelEn: false, sampleRate: 0, voices: [] }
      const localVoices = Array.isArray(piper.voices) ? piper.voices : []
      const system = config.system || { supported: false, voices: [] }
      const systemVoices = Array.isArray(system.voices) ? system.voices : []
      const custom = config.custom || {
        protocol: 'openai', baseUrl: '', endpoint: '', effectiveUrl: '', requiresKey: true,
        model: '', voice: '', format: 'wav', keyConfigured: false, ready: false,
      }
      const protocol = custom.protocol === 'gpt-sovits' || custom.protocol === 'fish' || custom.protocol === 'template'
        ? custom.protocol
        : 'openai'
      const engine = config.engine || 'deepseek'
      // Piper is no longer offered (browser speech replaces it); the Host also
      // downgrades a saved `piper` value, so this stays false on purpose.
      const localEngine = false
      const cloudEngine = engine === 'deepseek'
      const browserEngine = engine === 'browser'
      const systemEngine = engine === 'system'
      const customEngine = engine === 'custom'
      const systemReady = system.supported === true && systemVoices.length > 0
      const customReady = custom.ready === true
      const browserReady = voices.length > 0
      const engineReady = cloudEngine ? config.keyConfigured === true
        // A desktop shell can always hand the text to a browser, voices or not.
        : browserEngine ? (browserReady || isDesktopShell)
          : systemEngine ? systemReady
            : customReady
      const engineHint = cloudEngine
        ? t('DeepSeek 官方 TTS：在线合成按量计费，用你自己的 API 余额；需要 Key 和网络。',
          'The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.')
        : browserEngine
          ? (isDesktopShell
            ? t('用浏览器朗读：桌面端默认交给默认浏览器（朗读桥），也可以选下面的本机语音。',
              'Read in a browser: this desktop shell hands the text to your browser by default; local voices below are optional.')
            : t('用浏览器自带的语音朗读：不用 Key、不落盘、不走 Host；语速就是语音引擎自身的语速。',
              'The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.'))
          : systemEngine
            ? t('操作系统自带的语音，离线、零下载；中英混读正常，但音色偏机械。',
              'Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.')
            : t('任何 OpenAI 兼容的 /v1/audio/speech 端点；在线服务按量计费、消耗你账户的余额，本机服务免费。Key 只存本机，不回传给页面。',
              'Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.')
      const engineStatus = engineReady
        ? t('已就绪', 'ready')
        : cloudEngine ? t('需配置 Key', 'key missing')
          : browserEngine ? t('这个环境没有浏览器语音', 'no browser voices')
            : systemEngine ? (system.supported ? t('没有语音', 'no voices') : t('系统不支持', 'unsupported'))
              : t('需要配置', 'needs setup')

      // One card head: title, optional right-hand status, one explanatory line.
      const head = (key, title, hint, extra) => h('div', { className: 'dsh-tts-head', key },
        h('div', { className: 'dsh-tts-headrow', key: 'title' },
          h('span', { className: 'dsh-tts-h1', key: 'h' }, title),
          extra || null),
        hint ? h('div', { className: 'dsh-tts-hint', key: 'hint' }, hint) : null,
      )

      // Two columns only: a fixed label gutter and one control column that every
      // control fills, so selects, inputs and buttons share the same edges.
      const row = (key, label, control) => h('div', { className: 'dsh-tts-row', key },
        h('span', { className: 'dsh-tts-label', key: 'label' }, label),
        h('span', { className: 'dsh-tts-grow', key: 'control' }, control),
      )

      const badge = (key, ok, text) => h('span', { className: 'dsh-tts-badge ' + (ok ? 'ok' : 'warn'), key }, text)

      // GPT-SoVITS accepts the same language set for text and prompt.
      const langOptions = () => [
        h('option', { value: 'zh', key: 'zh' }, t('中文', 'Chinese')),
        h('option', { value: 'en', key: 'en' }, 'English'),
        h('option', { value: 'ja', key: 'ja' }, t('日语', 'Japanese')),
        h('option', { value: 'ko', key: 'ko' }, t('韩语', 'Korean')),
        h('option', { value: 'yue', key: 'yue' }, t('粤语', 'Cantonese')),
        h('option', { value: 'auto', key: 'auto' }, t('自动', 'Auto')),
      ]

      const check = (key, field, text, hint, checked) => h('label', { className: 'dsh-tts-check', key },
        h('input', {
          type: 'checkbox', checked: checked, disabled: busy,
          onChange: (event) => save({ [field]: event.target.checked }),
        }),
        h('span', { className: 'dsh-tts-check-text' }, text),
        hint ? h('span', { className: 'dsh-tts-hint' }, hint) : null,
      )

      return h('div', { className: 'dsh-tts-settings' },
        h('div', { className: 'dsh-tts-card', key: 'engine' },
          head('head', t('合成引擎', 'Engine'), engineHint, badge('status', engineReady, engineStatus)),
          row('engine', t('引擎', 'Engine'),
            h('select', {
              className: 'dsh-tts-select', value: engine, disabled: busy,
              onChange: (event) => save({ engine: event.target.value }),
              children: [
                h('option', { value: 'deepseek', key: 'deepseek' }, t('DeepSeek 云（在线）', 'DeepSeek cloud (online)')),
                h('option', { value: 'browser', key: 'browser', disabled: !browserReady && !isDesktopShell },
                  browserReady
                    ? t('浏览器朗读（本机 ' + voices.length + ' 个语音）', 'Browser speech (' + voices.length + ' voices)')
                    : isDesktopShell
                      ? t('浏览器朗读（交给浏览器）', 'Browser speech (hand off to a browser)')
                      : t('浏览器朗读（这个环境没有语音）', 'Browser speech (no voices here)')),
                h('option', { value: 'system', key: 'system' }, t('系统语音（离线）', 'System voices (offline)')),
                h('option', { value: 'custom', key: 'custom' }, t('自定义 API（在线）', 'Custom API (online)')),
              ],
            }),
          ),
          browserEngine ? row('speech-voice', t('语音', 'Voice'), (voices.length > 0 || isDesktopShell)
            ? h('select', {
                className: 'dsh-tts-select',
                value: speechTargetValue(),
                disabled: busy,
                onChange: (event) => { rememberSpeechVoice(event.target.value); setVoices(refreshSpeechVoices().slice()) },
                children: [
                  // Only a desktop shell gets this: a real browser reads in place.
                  isDesktopShell ? h('option', { value: BRIDGE_TARGET, key: 'bridge' },
                    t('🌐 朗读桥 · 在浏览器中朗读（推荐）', '🌐 Speech bridge · read in a browser (recommended)')) : null,
                  ...voices.map((voice) => h('option', {
                    value: voice.voiceURI, key: voice.voiceURI,
                  }, (isCloudVoice(voice) ? '☁ ' : '⌂ ') + voice.name + ' · ' + voice.lang)),
                ].filter(Boolean),
              })
            : badge('state', false, t('这个环境没有浏览器语音', 'no browser voices here'))) : null,
          cloudEngine ? row('voice', t('音色', 'Voice'),
            h('select', {
              className: 'dsh-tts-select', value: config.voice, disabled: busy,
              onChange: (event) => save({ voice: event.target.value }),
              children: [
                h('option', { value: 'stella', key: 'stella' }, 'stella · ' + t('女声', 'female')),
                h('option', { value: 'tide', key: 'tide' }, 'tide · ' + t('男声', 'male')),
              ],
            }),
          ) : null,
          cloudEngine ? row('key', 'API Key',
            badge('state', config.keyConfigured === true, config.keyConfigured
              ? t('已配置（DEEPSEEK_API_KEY）', 'Configured · DEEPSEEK_API_KEY')
              : t('未配置，请到 设置 → 模型 填 Key', 'Not configured — set a key in Settings → Models')),
          ) : null,
          systemEngine ? row('system-voice', t('语音', 'Voice'), systemVoices.length > 0
            ? h('select', {
                className: 'dsh-tts-select', value: config.systemVoice || (systemVoices[0] && systemVoices[0].id) || '', disabled: busy,
                onChange: (event) => save({ systemVoice: event.target.value }),
                children: systemVoices.map((voice) => h('option', { value: voice.id, key: voice.id },
                  voice.name
                  + (voice.language ? ' · ' + voice.language : '')
                  + (voice.gender ? ' · ' + voice.gender : ''))),
              })
            : badge('state', false, system.supported
              ? t('没有可用的系统语音', 'no system voices installed')
              : t('当前系统不支持系统语音', 'not supported on this OS'))) : null,
          customEngine ? row('custom-protocol', t('协议', 'Protocol'),
            h('select', {
              className: 'dsh-tts-select', value: protocol, disabled: busy,
              onChange: (event) => save({ customProtocol: event.target.value }),
              children: [
                h('option', { value: 'openai', key: 'openai' }, t('OpenAI 兼容 /v1/audio/speech', 'OpenAI-compatible /v1/audio/speech')),
                h('option', { value: 'gpt-sovits', key: 'gpt-sovits' }, t('GPT-SoVITS（api_v2 /tts）', 'GPT-SoVITS (api_v2 /tts)')),
                h('option', { value: 'fish', key: 'fish' }, t('Fish Audio（/v1/tts）', 'Fish Audio (/v1/tts)')),
                h('option', { value: 'template', key: 'template' }, t('自定义请求模板', 'Custom request template')),
              ],
            })) : null,
          customEngine ? row('custom-url', 'Base URL', [
            h(TextInput, {
              key: 'input',
              className: 'dsh-tts-input wide', value: config.customBaseUrl, disabled: busy,
              placeholder: protocol === 'gpt-sovits' ? 'http://127.0.0.1:9880'
                : protocol === 'fish' ? 'https://api.fish.audio'
                  : protocol === 'template' ? 'http://127.0.0.1:8080'
                    : 'https://api.openai.com/v1',
              onCommit: (value) => void save({ customBaseUrl: value }),
            }),
            custom.effectiveUrl
              ? badge('state', true, custom.requiresKey
                ? t('需要 Key', 'key required')
                : t('本机服务，免 Key', 'local, no key'))
              : (config.customBaseUrl
                ? badge('state', false, t('地址无效', 'invalid URL'))
                : null),
          ]) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-ref', t('参考音频', 'Reference audio'), [
            h(TextInput, {
              key: 'input',
              className: 'dsh-tts-input wide', value: config.sovitsRefAudio, disabled: busy,
              placeholder: 'C:\\voices\\ref.wav（服务端本机路径）',
              onCommit: (value) => void save({ sovitsRefAudio: value }),
            }),
            config.sovitsRefAudio ? null : badge('state', false, t('必填', 'required')),
          ]) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-prompt', t('参考文本', 'Reference text'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.sovitsPromptText, disabled: busy,
              placeholder: t('参考音频里说的话（可留空）', 'what the reference audio says (optional)'),
              onCommit: (value) => void save({ sovitsPromptText: value }),
            })) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-text-lang', t('文本语言', 'Text language'),
            h('select', {
              className: 'dsh-tts-select', value: custom.lang || 'zh', disabled: busy,
              onChange: (event) => save({ sovitsTextLang: event.target.value }),
              children: langOptions(),
            })) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-prompt-lang', t('参考语言', 'Prompt language'),
            h('select', {
              className: 'dsh-tts-select', value: custom.promptLang || 'zh', disabled: busy,
              onChange: (event) => save({ sovitsPromptLang: event.target.value }),
              children: langOptions(),
            })) : null,
          customEngine && protocol === 'openai' ? row('custom-model', t('模型', 'Model'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customModel, disabled: busy,
              placeholder: 'tts-1',
              onCommit: (value) => void save({ customModel: value }),
            })) : null,
          customEngine && protocol === 'openai' ? row('custom-voice', t('音色', 'Voice'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customVoice, disabled: busy,
              placeholder: 'alloy',
              onCommit: (value) => void save({ customVoice: value }),
            })) : null,
          customEngine && protocol === 'openai' ? row('custom-format', t('返回格式', 'Format'),
            h('select', {
              className: 'dsh-tts-select', value: config.customFormat === 'pcm' ? 'pcm' : 'wav', disabled: busy,
              onChange: (event) => save({ customFormat: event.target.value }),
              children: [
                h('option', { value: 'wav', key: 'wav' }, t('wav（推荐）', 'wav (recommended)')),
                h('option', { value: 'pcm', key: 'pcm' }, t('pcm（24 kHz 裸流）', 'pcm (24 kHz raw)')),
              ],
            })) : null,
          customEngine && protocol === 'fish' ? row('fish-model', t('模型', 'Model'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customModel, disabled: busy,
              placeholder: 's2-pro',
              onCommit: (value) => void save({ customModel: value }),
            })) : null,
          customEngine && protocol === 'fish' ? row('fish-voice', t('参考音色 ID', 'Reference voice id'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customVoice, disabled: busy,
              placeholder: 'reference_id',
              onCommit: (value) => void save({ customVoice: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-method', t('方法', 'Method'),
            h('select', {
              className: 'dsh-tts-select', value: config.customMethod === 'GET' ? 'GET' : 'POST', disabled: busy,
              onChange: (event) => save({ customMethod: event.target.value }),
              children: [
                h('option', { value: 'POST', key: 'POST' }, 'POST'),
                h('option', { value: 'GET', key: 'GET' }, 'GET'),
              ],
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-path', t('路径', 'Path'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customPath, disabled: busy,
              placeholder: '/tts',
              onCommit: (value) => void save({ customPath: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-headers', t('请求头', 'Headers'),
            h(TextAreaInput, {
              className: 'dsh-tts-area', rows: 2, value: config.customHeaders, disabled: busy,
              placeholder: '{"x-api-key": "..."}',
              onCommit: (value) => void save({ customHeaders: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-body', t('请求体模板', 'Body template'),
            h(TextAreaInput, {
              className: 'dsh-tts-area', rows: 3, value: config.customBody, disabled: busy,
              placeholder: '{"text": "{{text}}", "voice": "{{voice}}"}',
              onCommit: (value) => void save({ customBody: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-audio', t('音频类型', 'Audio type'),
            h('select', {
              className: 'dsh-tts-select', value: config.customAudioType || 'auto', disabled: busy,
              onChange: (event) => save({ customAudioType: event.target.value }),
              children: [
                h('option', { value: 'auto', key: 'auto' }, t('自动识别（先嗅探 WAV）', 'auto (sniff WAV)')),
                h('option', { value: 'wav', key: 'wav' }, 'WAV'),
                h('option', { value: 'pcm', key: 'pcm' }, t('PCM（24 kHz 裸流）', 'PCM (24 kHz raw)')),
              ],
            })) : null,
          customEngine && (custom.requiresKey !== false || custom.keyConfigured) ? row('custom-key', 'API Key', [
            h(TextInput, {
              key: 'input',
              type: 'password',
              className: 'dsh-tts-input wide', value: '', disabled: busy,
              placeholder: custom.keyConfigured
                ? t('已配置，留空不改', 'configured — leave empty to keep')
                : 'sk-...',
              onCommit: (value) => void save({ customApiKey: value }),
            }),
            custom.keyConfigured
              ? h('button', {
                  key: 'clear', className: 'dsh-tts-btn', type: 'button', disabled: busy,
                  onClick: () => void save({ customApiKey: '' }),
                  children: t('清除', 'Clear'),
                })
              : null,
            badge('state', custom.keyConfigured === true, custom.keyConfigured ? t('已配置', 'configured') : t('未配置', 'missing')),
          ]) : null,
          row('preview', t('试听', 'Preview'), [
            h('button', {
              key: 'btn', className: 'dsh-tts-btn', type: 'button', disabled: busy,
              onClick: () => { if (previewState === 'idle') void playPreview(); else stopPreview() },
              children: previewState === 'loading'
                ? t('停止（正在合成）', 'Stop (synthesizing)')
                : previewState === 'playing'
                  ? t('停止试听', 'Stop preview')
                  : t('试听一下', 'Play a sample'),
            }),
            h('span', { key: 'hint', className: 'dsh-tts-hint' }, t('固定一句中英混读', 'fixed mixed zh/en sentence')),
          ]),
        ),
        h('div', { className: 'dsh-tts-card', key: 'speech' },
          head('head', t('朗读', 'Playback'),
            t('每段字数决定一次合成多长；速度只改播放快慢，不改音调。',
              'Part size sets how much text one synthesis covers; speed only changes playback, never pitch.')),
          row('chars', t('每段上限', 'Max per part'), [
            h(NumberInput, {
              key: 'input',
              className: 'dsh-tts-input num', min: 100, max: 4000, step: 100,
              value: config.maxChars, disabled: busy,
              onCommit: (value) => void save({ maxChars: value }),
            }),
            h('span', { className: 'dsh-tts-unit', key: 'unit' }, t('字', 'chars')),
          ]),
          row('speed', t('速度', 'Speed'), [
            h('input', {
              key: 'range',
              className: 'dsh-tts-range', type: 'range', min: 0.5, max: 2, step: 0.05,
              value: speedDraft === null ? config.speed : speedDraft,
              disabled: busy,
              'aria-label': t('朗读速度', 'Playback speed'),
              onChange: (event) => setSpeedDraft(event.target.value),
              onPointerUp: commitSpeed,
              onKeyUp: commitSpeed,
              onBlur: commitSpeed,
            }),
            h('span', { className: 'dsh-tts-value', key: 'value' }, (Number(speedDraft === null ? config.speed : speedDraft) || 1).toFixed(2) + '×'),
          ]),
        ),
        h('div', { className: 'dsh-tts-card', key: 'when' },
          head('head', t('自动朗读', 'Auto-read'),
            t('打开后自动念出对应内容；全关掉也还能点每条回复的喇叭。',
              'Turn these on to speak automatically; the speaker button still works with all of them off.')),
          // Every switch here is auto-reading; the label only names the source,
          // so the old "when to speak" framing is gone.
          check('auto', 'autoRead', t('读回复', 'Read replies'), t('回合结束的整条回复', "the turn's final reply"), config.autoRead === true),
          check('interim', 'autoReadInterim', t('读中途输出', 'Read mid-turn output'), t('需先开启「读回复」', 'needs "Read replies"'), config.autoReadInterim === true),
          check('q', 'speakQuestions', t('读提问', 'Read questions'), t('需要你作答的问题', 'prompts that need your answer'), config.speakQuestions !== false),
          check('ap', 'speakApprovals', t('读授权', 'Read approvals'), t('需要你确认的授权请求', 'requests that need your confirmation'), config.speakApprovals !== false),
        ),
        h('div', { className: 'dsh-tts-card', key: 'cache' },
          h('div', { className: 'dsh-tts-head', key: 'head' },
            h('div', { className: 'dsh-tts-headrow', key: 'title' },
              h('span', { className: 'dsh-tts-h1', key: 'h' }, t('音频缓存', 'Audio cache')),
            ),
            h('div', { className: 'dsh-tts-hint', key: 'hint' },
              cacheMode === 'disk'
                ? ((config.cache ? config.cache.files : 0) + t(' 个文件 · ', ' files · ') + cacheMb + ' MB / ' + cacheLimit + ' MB'
                  + (config.cache && config.cache.pinned && config.cache.pinned.files > 0
                    ? t('（固定提示语 ' + config.cache.pinned.files + ' 个，不参与淘汰）',
                      ' (' + config.cache.pinned.files + ' pinned, never evicted)')
                    : ''))
                : (t('内存中 ', 'in memory: ') + memCache.files + t(' 段 · ', ' entries · ') + memMb + ' MB / ' + memLimitMb + ' MB')),
            h('div', { className: 'dsh-tts-hint', key: 'note' },
              t('只缓存走 Host 合成的引擎（DeepSeek / 自定义 API / 系统语音）；浏览器朗读不产生缓存。',
                'Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.')),
            h('div', { className: 'dsh-tts-meter', key: 'meter' },
              h('i', { style: { width: (cacheMode === 'disk' ? cachePct : memPct) + '%' } })),
          ),
          row('mode', t('位置', 'Location'),
            h('select', {
              className: 'dsh-tts-select', value: cacheMode, disabled: busy,
              onChange: (event) => void save({ cacheMode: event.target.value }),
              children: [
                h('option', { value: 'disk', key: 'disk' }, t('硬盘（重启后仍在）', 'Disk (survives a restart)')),
                h('option', { value: 'memory', key: 'memory' }, t('内存（重启即清空，不写盘）', 'Memory (cleared on restart, nothing written)')),
              ],
            })),
          cacheMode === 'disk' ? row('limit', t('上限', 'Limit'), [
            h(NumberInput, {
              key: 'input',
              className: 'dsh-tts-input num', min: MIN_CACHE_MB, max: MAX_CACHE_MB, step: 50,
              value: config.cacheMaxMb, disabled: busy,
              onCommit: (value) => void save({ cacheMaxMb: value }),
            }),
            h('span', { className: 'dsh-tts-unit', key: 'unit' }, 'MB'),
          ]) : null,
          row('clear', t('清理', 'Cleanup'), [
            h('button', {
              key: 'clear',
              className: 'dsh-tts-btn danger', type: 'button', disabled: busy,
              onClick: async () => {
                try {
                  const response = await fetch(CLEAR_PATH, { method: 'POST' })
                  const body = await response.json()
                  if (body && body.ok) { playedMessages.clear(); load(); setNotice(t('缓存已清空', 'Cache cleared')) }
                } catch (error) {
                  setFailure(error && error.message ? error.message : String(error))
                }
              },
              children: t('清空缓存', 'Clear cache'),
            }),
          ]),
        ),
        h('div', { className: 'dsh-tts-foot', key: 'foot' }, t('回车、失焦或松手后保存。', 'Saves on Enter, blur, or release.')),
        notice ? h('div', { className: 'dsh-tts-toast ok', key: 'notice' }, notice) : null,
        failure ? h('div', { className: 'dsh-tts-toast err', key: 'failure' }, failure) : null,
        h(InstallGuide, { key: 'guide', open: guideOpen, onClose: () => setGuideOpen(false) }),
      )
    }

    const CSS = [
      '.dsh-tts-bars{display:inline-flex;align-items:center;gap:2px;height:16px;width:16px;justify-content:center}',
      '.dsh-tts-bars i{display:block;width:2px;border-radius:1px;background:currentColor;height:30%;animation:dsh-tts-bar .9s ease-in-out infinite}',
      '.dsh-tts-bars.is-loading i{animation-duration:1.4s;opacity:.6}',
      '.dsh-tts-bars.is-paused i{animation-play-state:paused;opacity:.55}',
      '@keyframes dsh-tts-bar{0%,100%{height:25%}50%{height:100%}}',
      // ---- settings page ----
      // One rhythm: card head (title + status + one hint) over rows built from a
      // fixed label gutter and one control column that every control fills, so
      // the page keeps its shape per row type and per language.
      '.dsh-tts-settings{display:flex;flex-direction:column;gap:16px;font-size:13px;padding:8px 2px 20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dsh-tts-head{display:flex;flex-direction:column;gap:4px;padding:14px 16px 12px}',
      '.dsh-tts-headrow{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}',
      '.dsh-tts-h1{font-size:13px;font-weight:600;line-height:1.4}',
      '.dsh-tts-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-head .dsh-tts-hint{font-size:12px;white-space:normal;overflow:visible}',
      '.dsh-tts-row{box-sizing:border-box;display:grid;grid-template-columns:96px minmax(0,1fr);align-items:center;column-gap:12px;min-height:48px;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsh-tts-label{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-grow{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-tts-unit{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-input,.dsh-tts-select{box-sizing:border-box;height:30px;margin:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.2;font-family:inherit;outline:none}',
      '.dsh-tts-input:focus,.dsh-tts-select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}',
      '.dsh-tts-input.num{flex:0 0 auto;width:96px;text-align:right;font-variant-numeric:tabular-nums}',
      '.dsh-tts-input.wide{flex:1 1 auto;width:auto;min-width:0;text-align:left}',
      '.dsh-tts-area{box-sizing:border-box;flex:1 1 auto;width:100%;min-height:56px;max-height:180px;margin:0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;font-family:inherit;resize:vertical;outline:none}',
      '.dsh-tts-area:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}',
      '.dsh-tts-input[type=number]::-webkit-inner-spin-button,.dsh-tts-input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
      '.dsh-tts-select{flex:1 1 auto;width:auto;min-width:0;max-width:100%;cursor:pointer}',
      '.dsh-tts-range{flex:1 1 auto;min-width:80px;height:4px;margin:0;appearance:none;-webkit-appearance:none;border-radius:2px;background:var(--dsw-alias-bg-layer-3);outline:none;cursor:pointer}',
      '.dsh-tts-range::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-state-business-primary);border:2px solid var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dsh-tts-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-state-business-primary);border:2px solid var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dsh-tts-range:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}',
      '.dsh-tts-value{flex:0 0 46px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-btn{box-sizing:border-box;height:30px;margin:0;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;font-family:inherit;cursor:pointer}',
      '.dsh-tts-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
      '.dsh-tts-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-tts-btn.push{margin-left:auto}',
      '.dsh-tts-btn.danger:hover:not(:disabled){border-color:#e5484d;color:#e5484d}',
      '.dsh-tts-check{box-sizing:border-box;display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;column-gap:10px;min-height:48px;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2);font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dsh-tts-check input{box-sizing:border-box;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-tts-check-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-check .dsh-tts-hint{justify-self:end;max-width:220px}',
      '.dsh-tts-badge{box-sizing:border-box;display:inline-flex;align-items:center;flex:0 1 auto;max-width:100%;min-width:0;min-height:22px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:1.35;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-badge.ok{color:#30a46c;border-color:rgba(48,164,108,.5)}',
      '.dsh-tts-badge.warn{color:#e5484d;border-color:rgba(229,72,77,.5)}',
      '.dsh-tts-head .dsh-tts-meter{height:4px;margin-top:8px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.dsh-tts-meter i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary);transition:width .25s}',
      '.dsh-tts-foot{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);padding:0 2px}',
      '.dsh-tts-toast{font-size:12px;line-height:1.5;padding:0 2px}',
      '.dsh-tts-toast.ok{color:#30a46c}',
      '.dsh-tts-toast.err{color:#e5484d}',
      // ---- install guide dialog ----
      // A native <dialog> owns the top layer, the backdrop and Escape, so the
      // guide cannot be clipped by the settings pane's own scroll box.
      '.dsh-tts-dialog{box-sizing:border-box;width:min(560px,calc(100vw - 48px));max-height:min(82vh,720px);margin:auto;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;box-shadow:0 18px 48px rgba(0,0,0,.45);overflow:auto}',
      '.dsh-tts-dialog::backdrop{background:rgba(0,0,0,.45)}',
      '.dsh-tts-dialog-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-tts-dialog-title{font-size:14px;font-weight:600;line-height:1.4}',
      '.dsh-tts-close{box-sizing:border-box;height:26px;min-width:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;font-family:inherit;cursor:pointer}',
      '.dsh-tts-close:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-dialog-body{display:flex;flex-direction:column;gap:12px;padding:14px 16px 18px}',
      '.dsh-tts-dialog-body ol{display:flex;flex-direction:column;gap:8px;margin:0;padding-left:20px}',
      '.dsh-tts-dialog-body li{margin:0}',
      '.dsh-tts-kv{font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3)}',
      '.dsh-tts-dialog-foot{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-dialog a{color:var(--dsw-alias-state-business-primary);text-decoration:none}',
      '.dsh-tts-dialog a:hover{text-decoration:underline}',
    ].join('\n')

    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-tts-reader'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { try { style.remove() } catch {} }
    }

    // Settings navigation glyph for this plugin's own section id; same adapted
    // Lucide volume-2 paths as SpeakerIcon (ISC, see THIRD_PARTY.md).
    function SettingsIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const active = props && props.active === true
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 2 : 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { opacity: active ? 1 : 0.85 },
      },
        h('path', {
          d: 'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z',
          key: 'body',
        }),
        h('path', { d: 'M16 9a5 5 0 0 1 0 6', key: 'wave-1' }),
        h('path', { d: 'M19.4 18.4a9 9 0 0 0 0-12.8', key: 'wave-2' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => injectStyles(), 'dsh-tts-reader: styles')
        localeCtx = ctx.locale
        watchLocale(ctx)
        loadConfigOnce()
        ensureEvents(ctx)

        // Keep the feed alive: reconnect if it dropped, and re-check on focus.
        ctx.effect(() => {
          const timer = setInterval(() => {
            if (!eventSource) ensureEvents(ctx)
            else if (typeof EventSource !== 'undefined'
              && (eventSource.readyState === EventSource.CLOSED || eventSource.readyState === EventSource.CONNECTING)) {
              try { eventSource.close() } catch {}
              eventSource = null
              ensureEvents(ctx)
            }
          }, 5000)
          const onFocus = () => { if (!eventSource) ensureEvents(ctx) }
          const onVisible = () => {
            if (document.visibilityState !== 'visible') return
            if (!eventSource) ensureEvents(ctx)
            pollRecent()
          }
          try { window.addEventListener('focus', onFocus) } catch {}
          try { document.addEventListener('visibilitychange', onVisible) } catch {}
          return () => {
            clearInterval(timer)
            try { window.removeEventListener('focus', onFocus) } catch {}
            try { document.removeEventListener('visibilitychange', onVisible) } catch {}
          }
        }, 'dsh-tts-reader: watchdog')

        // The assistant feed also has a pull path, so a silently dropped
        // EventSource cannot stop auto-read.
        ctx.effect(() => {
          const timer = setInterval(pollRecent, 2500)
          pollRecent()
          return () => { clearInterval(timer) }
        }, 'dsh-tts-reader: recent poll')

        // Follows the visible session even before it has any assistant message,
        // so auto-read always compares against the right session id.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'tts-reader-session',
          order: 900,
        }, SessionTracker))

        // Mounted on document.body instead of a slot: request dialogs can cover
        // every slot-rendered surface.
        ctx.effect(() => mountPromptButton(), 'dsh-tts-reader: prompt button')

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'tts-reader',
          order: 40,
          // A thunk: the owner re-reads it per projection, so the label follows
          // the app language without re-registering.
          label: () => t('朗读', 'Read aloud'),
        }, ReadAloudAction))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'tts-reader',
          order: 26,
          label: () => t('语音朗读', 'Read aloud'),
        }, TtsSettings))

        // The settings navigation glyph for our own section id.
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'tts-reader',
        }, SettingsIcon))
      },
    }
  },
})

