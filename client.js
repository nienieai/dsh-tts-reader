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
    const CLEAR_PATH = '/api/dsh-tts/cache/clear'
    const EVENTS_PATH = '/api/dsh-tts/events'
    const RECENT_PATH = '/api/dsh-tts/recent'

    const SAMPLE_RATE = 24000
    const START_DELAY = 0.1
    const MAX_CACHED_MESSAGES = 8

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

    // messageKey -> Float32Array[] (decoded PCM). LRU-ish by insertion order.
    const audioCache = new Map()
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
    let activeSessionId = null
    const autoPlayed = new Set()
    let eventSource = null

    // The replay button polls the Host for the pending question / approval, so
    // it shows up even if a particular page instance missed the event.
    const PENDING_PATH = '/api/dsh-tts/pending'

    function applyRemoteConfig(value) {
      if (!value || typeof value !== 'object') return
      autoRead = value.autoRead === true
      autoReadInterim = value.autoReadInterim === true
      speakQuestions = value.speakQuestions !== false
      speakApprovals = value.speakApprovals !== false
      const nextSpeed = Number(value.speed)
      speed = Number.isFinite(nextSpeed) && nextSpeed > 0 ? Math.min(2, Math.max(0.5, nextSpeed)) : 1
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

    function rememberAudio(key, chunks) {
      audioCache.set(key, chunks)
      while (audioCache.size > MAX_CACHED_MESSAGES) {
        const oldest = audioCache.keys().next().value
        audioCache.delete(oldest)
      }
    }

    // Abort only what is audible; the waiting queue is untouched. Starting the
    // next queued item uses this, so draining never discards the rest.
    function stopCurrentOnly() {
      if (!current) {
        setPlayback({ key: null, phase: 'idle', error: '' })
        return
      }
      const { controller, context } = current
      current = null
      try { controller.abort() } catch {}
      try { context.close() } catch {}
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

    function finish(key) {
      if (!current || current.key !== key) return
      const context = current.context
      current = null
      try { context.close() } catch {}
      setPlayback({ key: null, phase: 'idle', error: '' })
      drainQueue()
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

    // One scheduler for both the cache path and the streaming path, applying
    // the speed stretch and chaining Web Audio buffers gaplessly.
    function createScheduler(context, stateKey) {
      const durationRatio = speed > 0 ? 1 / speed : 1
      const stretcher = Math.abs(durationRatio - 1) > 0.01 ? new Stretcher(durationRatio) : null
      let nextTime = 0
      let last = null
      const emit = (samples) => {
        if (!samples || samples.length === 0) return
        const startAt = last ? Math.max(nextTime, context.currentTime) : context.currentTime + START_DELAY
        const scheduled = schedule(context, samples, startAt)
        nextTime = scheduled.end
        last = scheduled.source
        if (playback.phase === 'loading') setPlayback({ phase: 'playing' })
      }
      return {
        feed(samples) {
          if (stretcher) emit(stretcher.push(samples))
          else emit(samples)
        },
        done() {
          if (stretcher) {
            const tail = stretcher.flush()
            if (tail.length > 0) emit(tail)
          }
          if (!last) { finish(stateKey); return }
          last.onended = () => finish(stateKey)
        },
      }
    }

    function playFromMemory(context, stateKey, chunks) {
      setPlayback({ key: stateKey, phase: 'playing', error: '' })
      const scheduler = createScheduler(context, stateKey)
      for (const chunk of chunks) scheduler.feed(chunk)
      scheduler.done()
    }

    function hashString(value) {
      let hash = 5381
      for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
      return (hash >>> 0).toString(36)
    }

    async function startReadAloud(sessionId, messageId, stateKey, options) {
      const text = options && options.text ? options.text : ''
      const cacheKey = text ? stateKey + '|s:' + hashString(text) : stateKey
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
      current = { key: stateKey, cacheKey, controller, context }
      setPlayback({ key: stateKey, phase: 'loading', error: '' })

      const cached = audioCache.get(cacheKey)
      if (cached && cached.length) {
        try { playFromMemory(context, stateKey, cached) } catch (error) { fail(stateKey, error) }
        return
      }

      try {
        const payload = {}
        // Both ids travel even with an explicit text: the Host widens the
        // selection to the whole paragraph(s) it sits in, and needs the message.
        if (sessionId && messageId) { payload.sessionId = sessionId; payload.messageId = messageId }
        if (text) payload.text = text
        const response = await fetch(READ_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        const type = String(response.headers.get('content-type') || '')
        if (type.indexOf('application/json') !== -1) {
          let payload = null
          try { payload = await response.json() } catch {}
          const failure = new Error((payload && payload.error) || t('语音合成失败', 'Speech synthesis failed'))
          failure.code = payload && payload.code
          throw failure
        }
        if (!response.ok || !response.body) throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')

        const reader = response.body.getReader()
        controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) })

        let rest = new Uint8Array(0)
        const collected = []
        const scheduler = createScheduler(context, stateKey)

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (controller.signal.aborted) return
          const merged = concatBytes(rest, value)
          const samples = toFloat32(merged)
          rest = merged.slice(samples.length * 2)
          if (samples.length === 0) continue
          // The cache keeps the original recording, so changing the speed later
          // replays from disk without synthesizing again.
          collected.push(samples)
          scheduler.feed(samples)
        }

        if (controller.signal.aborted) return
        rememberAudio(cacheKey, collected)
        scheduler.done()
      } catch (error) {
        if (controller.signal.aborted) return
        fail(stateKey, error)
      }
    }

    function fail(key, error) {
      if (!current || current.key !== key) return
      const context = current.context
      current = null
      try { context.close() } catch {}
      setPlayback({ key, phase: 'idle', error: (error && error.message) || String(error) })
      drainQueue()
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
        className: 'dsh-tts-bars' + (mode === 'loading' ? ' is-loading' : ''),
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
      const cached = audioCache.has(key)

      const title = error
        ? error
        : phase === 'loading'
          ? t('正在合成…', 'Synthesizing…')
          : phase === 'playing'
            ? t('点击停止', 'Click to stop')
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
          if (phase === 'loading' || phase === 'playing') { stopPlayback(); return }
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

    function TtsSettings() {
      const [config, setConfig] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // The speed slider previews while dragging and only saves on release, so
      // one drag is one write instead of dozens.
      const [speedDraft, setSpeedDraft] = React.useState(null)
      useLocaleTick()

      const load = React.useCallback(() => {
        fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => { if (body && body.ok) { setConfig(body.value); applyRemoteConfig(body.value) } })
          .catch(() => {})
      }, [])

      React.useEffect(() => { load() }, [load])

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
          audioCache.clear()
          setNotice(t('已保存', 'Saved'))
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

      const row = (key, label, control, meta) => h('div', { className: 'dsh-tts-row', key },
        h('span', { className: 'dsh-tts-label' }, label),
        control,
        meta ? (typeof meta === 'string' ? h('span', { className: 'dsh-tts-meta' }, meta) : meta) : null,
      )

      const check = (key, field, text, hint, checked) => h('label', { className: 'dsh-tts-check', key },
        h('input', {
          type: 'checkbox', checked: checked, disabled: busy,
          onChange: (event) => save({ [field]: event.target.checked }),
        }),
        h('span', { className: 'dsh-tts-check-text' }, text),
        hint ? h('span', { className: 'dsh-tts-hint' }, hint) : null,
      )

      return h('div', { className: 'dsh-tts-settings' },
        h('div', { className: 'dsh-tts-card', key: 'sound' },
          h('div', { className: 'dsh-tts-head', key: 'head' },
            h('div', { className: 'dsh-tts-h1', key: 'h' }, t('语音朗读', 'Read aloud')),
            h('div', { className: 'dsh-tts-hint', key: 'd' }, t('用 DeepSeek 官方 TTS 朗读助手回复，音频缓存在本机；页面只发消息 id，Key 不出 Host。', 'Speaks replies with the DeepSeek TTS API. The page only sends a message id; the key never leaves the Host.')),
          ),
          row('key', 'API Key',
            h('span', { className: 'dsh-tts-grow' },
              config.keyConfigured
                ? h('span', { className: 'dsh-tts-badge ok' }, t('已配置（DEEPSEEK_API_KEY）', 'Configured · DEEPSEEK_API_KEY'))
                : h('span', { className: 'dsh-tts-badge warn' }, t('未配置，请到 设置 → 模型 填 Key', 'Not configured — set a key in Settings → Models')),
            ),
          ),
          row('voice', t('音色', 'Voice'),
            h('span', { className: 'dsh-tts-grow' },
              h('select', {
                className: 'dsh-tts-select', value: config.voice, disabled: busy,
                onChange: (event) => save({ voice: event.target.value }),
                children: [
                  h('option', { value: 'stella', key: 'stella' }, 'stella · ' + t('女声', 'female')),
                  h('option', { value: 'tide', key: 'tide' }, 'tide · ' + t('男声', 'male')),
                ],
              }),
            ),
          ),
          row('chars', t('每段上限', 'Max per part'),
            h('span', { className: 'dsh-tts-grow' },
              h(NumberInput, {
                className: 'dsh-tts-input num', min: 100, max: 4000, step: 100,
                value: config.maxChars, disabled: busy,
                onCommit: (value) => void save({ maxChars: value }),
              }),
              h('span', { className: 'dsh-tts-unit' }, t('字', 'chars')),
            ),
          ),
          row('speed', t('速度', 'Speed'),
            h('span', { className: 'dsh-tts-grow' },
              h('input', {
                className: 'dsh-tts-range', type: 'range', min: 0.5, max: 2, step: 0.05,
                value: speedDraft === null ? config.speed : speedDraft,
                disabled: busy,
                'aria-label': t('朗读速度', 'Playback speed'),
                onChange: (event) => setSpeedDraft(event.target.value),
                onPointerUp: commitSpeed,
                onKeyUp: commitSpeed,
                onBlur: commitSpeed,
              }),
              h('span', { className: 'dsh-tts-value' }, (Number(speedDraft === null ? config.speed : speedDraft) || 1).toFixed(2) + '×'),
            ),
            t('无变调', 'pitch kept'),
          ),
        ),
        h('div', { className: 'dsh-tts-card', key: 'when' },
          h('div', { className: 'dsh-tts-head' },
            h('div', { className: 'dsh-tts-h1' }, t('自动朗读', 'Auto-read')),
          ),
          // Every switch here is auto-reading; the label only names the source,
          // so the old "when to speak" framing is gone.
          check('auto', 'autoRead', t('读回复', 'Read replies'), t('回合结束的整条回复', "the turn's final reply"), config.autoRead === true),
          check('interim', 'autoReadInterim', t('读中途输出', 'Read mid-turn output'), t('需先开启「读回复」', 'needs "Read replies"'), config.autoReadInterim === true),
          check('q', 'speakQuestions', t('读提问', 'Read questions'), t('需要你作答的问题', 'prompts that need your answer'), config.speakQuestions !== false),
          check('ap', 'speakApprovals', t('读授权', 'Read approvals'), t('需要你确认的授权请求', 'requests that need your confirmation'), config.speakApprovals !== false),
        ),
        h('div', { className: 'dsh-tts-card', key: 'cache' },
          h('div', { className: 'dsh-tts-head' },
            h('div', { className: 'dsh-tts-h1' }, t('音频缓存', 'Audio cache')),
            h('div', { className: 'dsh-tts-hint' }, (config.cache ? config.cache.files : 0) + t(' 个文件 · ', ' files · ') + cacheMb + ' MB / ' + cacheLimit + ' MB'),
            h('div', { className: 'dsh-tts-meter', key: 'meter' }, h('i', { style: { width: cachePct + '%' } })),
          ),
          row('limit', t('上限', 'Limit'),
            h('span', { className: 'dsh-tts-grow' },
              h(NumberInput, {
                className: 'dsh-tts-input num', min: MIN_CACHE_MB, max: MAX_CACHE_MB, step: 50,
                value: config.cacheMaxMb, disabled: busy,
                onCommit: (value) => void save({ cacheMaxMb: value }),
              }),
              h('span', { className: 'dsh-tts-unit' }, 'MB'),
            ),
            h('button', {
              className: 'dsh-tts-btn danger', type: 'button', disabled: busy,
              onClick: async () => {
                try {
                  const response = await fetch(CLEAR_PATH, { method: 'POST' })
                  const body = await response.json()
                  if (body && body.ok) { audioCache.clear(); load(); setNotice(t('缓存已清空', 'Cache cleared')) }
                } catch (error) {
                  setFailure(error && error.message ? error.message : String(error))
                }
              },
              children: t('清空缓存', 'Clear cache'),
            }),
          ),
        ),
        h('div', { className: 'dsh-tts-foot', key: 'foot' }, t('回车、失焦或松手后保存。', 'Saves on Enter, blur, or release.')),
        notice ? h('div', { className: 'dsh-tts-toast ok', key: 'notice' }, notice) : null,
        failure ? h('div', { className: 'dsh-tts-toast err', key: 'failure' }, failure) : null,
      )
    }

    const CSS = [
      '.dsh-tts-bars{display:inline-flex;align-items:center;gap:2px;height:16px;width:16px;justify-content:center}',
      '.dsh-tts-bars i{display:block;width:2px;border-radius:1px;background:currentColor;height:30%;animation:dsh-tts-bar .9s ease-in-out infinite}',
      '.dsh-tts-bars.is-loading i{animation-duration:1.4s;opacity:.6}',
      '@keyframes dsh-tts-bar{0%,100%{height:25%}50%{height:100%}}',
      // ---- settings page ----
      // One rhythm: every row is a 48px three-column grid (label / control / meta),
      // and every control is 30px tall with an explicit box model, so the page no
      // longer changes shape per row type or per language.
      '.dsh-tts-settings{display:flex;flex-direction:column;gap:16px;font-size:13px;padding:8px 2px 20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dsh-tts-head{display:flex;flex-direction:column;gap:4px;padding:14px 16px 12px}',
      '.dsh-tts-h1{font-size:13px;font-weight:600;line-height:1.4}',
      '.dsh-tts-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-head .dsh-tts-hint{font-size:12px;white-space:normal;overflow:visible}',
      '.dsh-tts-row{box-sizing:border-box;display:grid;grid-template-columns:96px minmax(0,1fr) auto;align-items:center;column-gap:12px;min-height:48px;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsh-tts-label{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-grow{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-tts-meta{justify-self:end;max-width:170px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-unit{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-row > .dsh-tts-btn{justify-self:end}',
      '.dsh-tts-input,.dsh-tts-select{box-sizing:border-box;height:30px;margin:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.2;font-family:inherit;outline:none}',
      '.dsh-tts-input:focus,.dsh-tts-select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}',
      '.dsh-tts-input.num{flex:0 0 auto;width:96px;text-align:right;font-variant-numeric:tabular-nums}',
      '.dsh-tts-input[type=number]::-webkit-inner-spin-button,.dsh-tts-input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
      '.dsh-tts-select{flex:0 1 auto;width:200px;max-width:100%;cursor:pointer}',
      '.dsh-tts-range{flex:1 1 auto;min-width:80px;height:4px;margin:0;appearance:none;-webkit-appearance:none;border-radius:2px;background:var(--dsw-alias-bg-layer-3);outline:none;cursor:pointer}',
      '.dsh-tts-range::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-state-business-primary);border:2px solid var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dsh-tts-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-state-business-primary);border:2px solid var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dsh-tts-range:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}',
      '.dsh-tts-value{flex:0 0 46px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-btn{box-sizing:border-box;height:30px;margin:0;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;font-family:inherit;cursor:pointer}',
      '.dsh-tts-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
      '.dsh-tts-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-tts-btn.danger:hover:not(:disabled){border-color:#e5484d;color:#e5484d}',
      '.dsh-tts-check{box-sizing:border-box;display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;column-gap:10px;min-height:48px;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2);font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dsh-tts-check input{box-sizing:border-box;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-tts-check-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-check .dsh-tts-hint{justify-self:end;max-width:220px}',
      '.dsh-tts-badge{box-sizing:border-box;display:inline-flex;align-items:center;max-width:100%;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-badge.ok{color:#30a46c;border-color:rgba(48,164,108,.5)}',
      '.dsh-tts-badge.warn{color:#e5484d;border-color:rgba(229,72,77,.5)}',
      '.dsh-tts-head .dsh-tts-meter{height:4px;margin-top:8px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.dsh-tts-meter i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary);transition:width .25s}',
      '.dsh-tts-foot{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);padding:0 2px}',
      '.dsh-tts-toast{font-size:12px;line-height:1.5;padding:0 2px}',
      '.dsh-tts-toast.ok{color:#30a46c}',
      '.dsh-tts-toast.err{color:#e5484d}',
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

