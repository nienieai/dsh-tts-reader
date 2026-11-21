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

    const SAMPLE_RATE = 24000
    const START_DELAY = 0.1
    const MAX_CACHED_MESSAGES = 8

    const LANG = (() => {
      try {
        return String(navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    })()
    const t = (zh, en) => (LANG === 'zh' ? zh : en)

    // messageKey -> Float32Array[] (decoded PCM). LRU-ish by insertion order.
    const audioCache = new Map()
    let current = null // { key, controller, context }
    let playback = { key: null, phase: 'idle', error: '' }
    const listeners = new Set()

    // Auto-read state, kept in sync with the Host settings.
    let autoRead = false
    let speakQuestions = true
    let speakApprovals = true
    let activeSessionId = null
    const autoPlayed = new Set()
    let eventSource = null

    // The replay button polls the Host for the pending question / approval, so
    // it shows up even if a particular page instance missed the event.
    const PENDING_PATH = '/api/dsh-tts/pending'

    function applyRemoteConfig(value) {
      if (!value || typeof value !== 'object') return
      autoRead = value.autoRead === true
      speakQuestions = value.speakQuestions !== false
      speakApprovals = value.speakApprovals !== false
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
        if (payload.type === 'question' || payload.type === 'question-closed' || payload.type === 'approval-closed') {
          // Speech for these comes from the /pending probe below, so one page
          // instance owns it even when the feed reconnects.
          return
        }
        if (payload.type === 'approval') {
          return
        }
        if (payload.type !== 'assistant') return
        if (!autoRead) return
        const sessionId = String(payload.sessionId || '')
        const messageId = String(payload.messageId || '')
        if (!sessionId || !messageId) return
        if (!activeSessionId || sessionId !== activeSessionId) return
        const key = sessionId + ':' + messageId
        if (autoPlayed.has(key)) return
        autoPlayed.add(key)
        void startReadAloud(sessionId, messageId, key)
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

    function stopPlayback() {
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

    function finish(key) {
      if (!current || current.key !== key) return
      const context = current.context
      current = null
      try { context.close() } catch {}
      setPlayback({ key: null, phase: 'idle', error: '' })
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

    function playFromMemory(context, stateKey, chunks) {
      let nextTime = context.currentTime + START_DELAY
      let last = null
      for (const chunk of chunks) {
        const scheduled = schedule(context, chunk, nextTime)
        nextTime = scheduled.end
        last = scheduled.source
      }
      setPlayback({ key: stateKey, phase: 'playing', error: '' })
      if (!last) { finish(stateKey); return }
      last.onended = () => finish(stateKey)
    }

    function hashString(value) {
      let hash = 5381
      for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
      return (hash >>> 0).toString(36)
    }

    async function startReadAloud(sessionId, messageId, stateKey, options) {
      const text = options && options.text ? options.text : ''
      const cacheKey = text ? stateKey + '|s:' + hashString(text) : stateKey
      stopPlayback()
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
        if (text) payload.text = text
        else if (sessionId && messageId) { payload.sessionId = sessionId; payload.messageId = messageId }
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
        let nextTime = 0
        let last = null
        const collected = []

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (controller.signal.aborted) return
          const merged = concatBytes(rest, value)
          const samples = toFloat32(merged)
          rest = merged.slice(samples.length * 2)
          if (samples.length === 0) continue
          collected.push(samples)
          const startAt = last ? Math.max(nextTime, context.currentTime) : context.currentTime + START_DELAY
          const scheduled = schedule(context, samples, startAt)
          nextTime = scheduled.end
          last = scheduled.source
          if (playback.phase === 'loading') setPlayback({ phase: 'playing' })
        }

        if (controller.signal.aborted) return
        rememberAudio(cacheKey, collected)
        if (!last) { finish(stateKey); return }
        last.onended = () => finish(stateKey)
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
    }

    function SpeakerIcon() {
      // Rounded speaker + two arcs, matching the volume glyph used by the web
      // clients in the reference screenshots.
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

    // Imperative button mounted straight on document.body: request dialogs can
    // cover slot-rendered content, but a later sibling of the app root still
    // paints above them.
    function mountPromptButton() {
      if (typeof document === 'undefined' || !document.body) return () => {}
      const wrap = document.createElement('div')
      // A modal <dialog> lives in the browser's top layer, where no z-index can
      // reach. A manual popover is also top-layer; re-showing it while a request
      // is pending puts it above that dialog.
      try { wrap.setAttribute('popover', 'manual') } catch {}
      wrap.style.cssText = 'position:fixed;top:10px;right:14px;z-index:2147483647;display:none;'
        + 'margin:0;padding:0;border:0;background:transparent;overflow:visible'
      const button = document.createElement('button')
      button.type = 'button'
      button.style.cssText = 'display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;'
        + 'border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);'
        + 'background:var(--dsw-alias-bg-layer-2,#1c1c1c);color:var(--dsw-alias-label-primary,#eee);'
        + 'font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.32)'
      const iconEl = document.createElement('span')
      iconEl.textContent = '🔊'
      const labelEl = document.createElement('span')
      button.appendChild(iconEl)
      button.appendChild(labelEl)
      wrap.appendChild(button)
      document.body.appendChild(wrap)

      let pending = null
      let lastSpoken = null
      let raisedFor = null
      let removed = false

      const keyOf = (value) => 'prompt:' + (value.kind === 'approval' ? 'approval:' : '') + value.id
      const isPlaying = () => !!(current && pending && current.key === keyOf(pending))

      const raisePopover = () => {
        try {
          if (typeof wrap.hidePopover === 'function') wrap.hidePopover()
        } catch {}
        try {
          if (typeof wrap.showPopover === 'function') wrap.showPopover()
        } catch {}
      }
      const dropPopover = () => {
        try { if (typeof wrap.hidePopover === 'function') wrap.hidePopover() } catch {}
      }

      // A native modal <dialog> is inert-hostile: only its own subtree stays
      // interactive. Move the button into the open dialog when there is one.
      const adopt = () => {
        try {
          const dialog = document.querySelector('dialog[open]')
          const target = dialog || document.body
          if (wrap.parentNode !== target) target.appendChild(wrap)
        } catch {}
      }

      const render = () => {
        if (removed) return
        if (!pending || !pending.text) { wrap.style.display = 'none'; dropPopover(); return }
        wrap.style.display = 'flex'
        const playing = isPlaying()
        const label = pending.kind === 'approval' ? t('朗读授权', 'Read request') : t('朗读问题', 'Read question')
        iconEl.textContent = playing ? '⏹' : '🔊'
        labelEl.textContent = playing ? t('停止', 'Stop') : label
        button.title = playing ? t('点击停止', 'Click to stop') : label
      }

      const tick = () => {
        fetch(PENDING_PATH, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => {
            if (removed || !body || !body.ok) return
            pending = body.value || null
            adopt()
            if (pending && pending.text) {
              // Re-raise on every new request: the dialog may have opened since.
              if (pending.id !== raisedFor) { raisePopover(); raisedFor = pending.id }
              if (pending.id !== lastSpoken) {
                const enabled = pending.kind === 'approval' ? speakApprovals : speakQuestions
                if (enabled) {
                  lastSpoken = pending.id
                  void startReadAloud(null, null, keyOf(pending), { text: pending.text })
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
        if (isPlaying()) { stopPlayback(); render(); return }
        void startReadAloud(null, null, keyOf(pending), { text: pending.text })
        setTimeout(render, 60)
      })

      const timer = setInterval(tick, 2000)
      const off = subscribePlayback(render)
      tick()
      return () => {
        removed = true
        clearInterval(timer)
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
              : t('朗读这条回复（选中文字则只读选中部分）', 'Read this reply aloud (selected text only, if any)')

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
          void startReadAloud(sessionId, messageId, key, selected ? { text: selected } : undefined)
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

    function TtsSettings() {
      const [config, setConfig] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const [busy, setBusy] = React.useState(false)

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

      if (!config) return h('div', { style: { padding: '4px 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, t('加载中…', 'Loading…'))

      const cacheMb = (config.cache && config.cache.bytes ? config.cache.bytes / 1048576 : 0).toFixed(1)
      const card = {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', padding: '10px',
        display: 'flex', flexDirection: 'column', gap: '8px',
      }
      const row = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
      const sub = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
      const input = {
        padding: '5px 8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px', fontFamily: 'inherit',
      }
      const plain = {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', fontSize: '12px', padding: '3px 10px', cursor: 'pointer',
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px', padding: '4px 0' } },
        h('div', { style: card },
          h('div', { style: row },
            h('span', { style: { fontSize: '13px', fontWeight: 600 }, key: 't' }, t('语音朗读', 'Read aloud')),
            h('span', { style: sub, key: 's' }, t('用 DeepSeek 官方 TTS 流式朗读助手回复；音频缓存在本机', 'Streams replies with the DeepSeek TTS API; audio cached on this machine')),
          ),
          h('div', { style: row },
            h('span', { style: sub, key: 'k' }, 'API Key'),
            config.keyConfigured
              ? h('span', { style: { fontSize: '12px', color: '#30a46c' }, key: 'v' }, t('已配置（DEEPSEEK_API_KEY）', 'Configured (DEEPSEEK_API_KEY)'))
              : h('span', { style: { fontSize: '12px', color: '#e5484d' }, key: 'v' }, t('未配置，请先在 设置 → 模型 里填 DeepSeek Key', 'Not configured — set a DeepSeek key in Settings → Models')),
          ),
          h('div', { style: row },
            h('span', { style: sub, key: 'voice' }, t('音色', 'Voice')),
            h('select', {
              key: 'voice-select', style: input, value: config.voice, disabled: busy,
              onChange: (event) => save({ voice: event.target.value }),
              children: [
                h('option', { value: 'stella', key: 'stella' }, 'stella（女声）'),
                h('option', { value: 'tide', key: 'tide' }, 'tide（男声）'),
              ],
            }),
            h('span', { style: sub, key: 'chars-label' }, t('单次上限', 'Max chars')),
            h('input', {
              key: 'chars', type: 'number', min: 100, max: 4000, step: 100,
              style: { ...input, width: '90px' }, value: config.maxChars, disabled: busy,
              onChange: (event) => {
                const value = Number(event.target.value)
                if (Number.isFinite(value) && value >= 100) save({ maxChars: Math.min(4000, Math.floor(value)) })
              },
            }),
          ),
          h('div', { style: row },
            h('label', {
              key: 'auto',
              style: { ...sub, display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
            },
              h('input', {
                type: 'checkbox',
                checked: config.autoRead === true,
                disabled: busy,
                onChange: (event) => save({ autoRead: event.target.checked }),
              }),
              t('新回复自动朗读', 'Read new replies automatically'),
            ),
            h('label', {
              key: 'q',
              style: { ...sub, display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
            },
              h('input', {
                type: 'checkbox',
                checked: config.speakQuestions !== false,
                disabled: busy,
                onChange: (event) => save({ speakQuestions: event.target.checked }),
              }),
              t('提问时朗读', 'Read questions'),
            ),
            h('label', {
              key: 'ap',
              style: { ...sub, display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
            },
              h('input', {
                type: 'checkbox',
                checked: config.speakApprovals !== false,
                disabled: busy,
                onChange: (event) => save({ speakApprovals: event.target.checked }),
              }),
              t('授权时朗读', 'Read approval requests'),
            ),
          ),
          h('div', { style: row },
            h('span', { style: sub, key: 'cache' }, t('缓存：', 'Cache: ') + (config.cache ? config.cache.files : 0) + t(' 个文件 / ', ' files / ') + cacheMb + ' MB'),
            h('button', {
              key: 'clear', type: 'button', style: plain, disabled: busy,
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
            h('span', { style: sub, key: 'cap' }, t('上限', 'Limit')),
            h('input', {
              key: 'cap-input', type: 'number', min: 50, max: 4096, step: 50,
              style: { ...input, width: '90px' }, value: config.cacheMaxMb, disabled: busy,
              onChange: (event) => {
                const value = Number(event.target.value)
                if (Number.isFinite(value) && value >= 50) save({ cacheMaxMb: Math.min(4096, Math.floor(value)) })
              },
            }),
            h('span', { style: sub, key: 'cap-unit' }, 'MB'),
          ),
          notice ? h('span', { style: { fontSize: '12px', color: '#30a46c' } }, notice) : null,
          failure ? h('span', { style: { fontSize: '12px', color: '#e5484d' } }, failure) : null,
        ),
      )
    }

    const CSS = [
      '.dsh-tts-bars{display:inline-flex;align-items:center;gap:2px;height:16px;width:16px;justify-content:center}',
      '.dsh-tts-bars i{display:block;width:2px;border-radius:1px;background:currentColor;height:30%;animation:dsh-tts-bar .9s ease-in-out infinite}',
      '.dsh-tts-bars.is-loading i{animation-duration:1.4s;opacity:.6}',
      '@keyframes dsh-tts-bar{0%,100%{height:25%}50%{height:100%}}',
    ].join('\n')

    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-tts-reader'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { try { style.remove() } catch {} }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => injectStyles(), 'dsh-tts-reader: styles')
        loadConfigOnce()
        ensureEvents(ctx)

        // Keep the feed alive: reconnect if it dropped, and re-check on focus.
        ctx.effect(() => {
          const timer = setInterval(() => {
            if (!eventSource) ensureEvents(ctx)
            else if (typeof EventSource !== 'undefined' && eventSource.readyState === EventSource.CLOSED) {
              try { eventSource.close() } catch {}
              eventSource = null
              ensureEvents(ctx)
            }
          }, 30000)
          const onFocus = () => { if (!eventSource) ensureEvents(ctx) }
          try { window.addEventListener('focus', onFocus) } catch {}
          return () => {
            clearInterval(timer)
            try { window.removeEventListener('focus', onFocus) } catch {}
          }
        }, 'dsh-tts-reader: watchdog')

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
          label: t('朗读', 'Read aloud'),
        }, ReadAloudAction))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'tts-reader',
          order: 26,
          label: t('语音朗读', 'Read aloud'),
        }, TtsSettings))
      },
    }
  },
})

