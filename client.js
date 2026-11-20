// dsh-tts-reader — Client half.
//
// Adds a "read aloud" action to every finalized assistant message. The page
// never talks to api.deepseek.com and never sees the API key: it posts the
// session/message identity to this plugin's own Host route, which resolves the
// text, synthesizes it through the official TTS API, and returns WAV bytes.
//
// Playback cache: the first click downloads and keeps a blob URL per message;
// clicking the same button again replays that local blob. On the Host side the
// audio itself is cached on disk, so a reload still answers without the API.

window.__ModuleLoader__.load({
  id: 'dsh-tts-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG_PATH = '/api/dsh-tts/config'
    const READ_PATH = '/api/dsh-tts/read'
    const CLEAR_PATH = '/api/dsh-tts/cache/clear'

    const LANG = (() => {
      try {
        return String(navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    })()
    const t = (zh, en) => (LANG === 'zh' ? zh : en)

    // messageKey -> object URL. Kept across clicks (and across remounts) so the
    // second click is a pure cache play.
    const urlCache = new Map()
    let currentAudio = null
    let currentKey = null

    const styles = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        height: '24px',
        minWidth: '24px',
        padding: '0 6px',
        border: '1px solid transparent',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '1',
        cursor: 'pointer',
      },
      active: {
        color: 'var(--dsw-alias-state-business-primary)',
        borderColor: 'var(--dsw-alias-state-business-primary)',
      },
      error: { color: '#e5484d' },
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px', padding: '4px 0' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '13px', fontWeight: 600 },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      input: {
        padding: '5px 8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      primary: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontSize: '12px',
        padding: '3px 10px',
        cursor: 'pointer',
      },
      plain: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        padding: '3px 10px',
        cursor: 'pointer',
      },
      ok: { fontSize: '12px', color: '#30a46c' },
    }

    function SpeakerIcon(props) {
      return h('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: props.style,
      },
        h('path', { d: 'M11 5 6 9H3v6h3l5 4V5z', key: 'body' }),
        props.playing
          ? h('path', { d: 'M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12', key: 'waves' })
          : h('path', { d: 'M15.5 8.5a5 5 0 0 1 0 7', key: 'wave' }),
      )
    }

    function stopCurrent() {
      if (currentAudio) {
        try { currentAudio.pause() } catch {}
        try { currentAudio.currentTime = 0 } catch {}
        currentAudio = null
        currentKey = null
      }
    }

    function playUrl(key, url, onEnd) {
      stopCurrent()
      const audio = new Audio(url)
      currentAudio = audio
      currentKey = key
      audio.onended = () => {
        if (currentAudio === audio) { currentAudio = null; currentKey = null }
        onEnd()
      }
      audio.onerror = () => {
        if (currentAudio === audio) { currentAudio = null; currentKey = null }
        onEnd(new Error(t('播放失败', 'Playback failed')))
      }
      audio.play().catch((error) => {
        if (currentAudio === audio) { currentAudio = null; currentKey = null }
        onEnd(error)
      })
    }

    async function fetchAudio(sessionId, messageId) {
      const response = await fetch(READ_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, messageId }),
      })
      const type = String(response.headers.get('content-type') || '')
      if (type.indexOf('application/json') !== -1) {
        let payload = null
        try { payload = await response.json() } catch {}
        const message = (payload && payload.error) || t('语音合成失败', 'Speech synthesis failed')
        const error = new Error(message)
        error.code = payload && payload.code
        throw error
      }
      if (!response.ok) throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')
      return response.blob()
    }

    function ReadAloudAction(props) {
      const messageId = props && props.messageId
      const sessionId = props && props.sessionId
      const key = String(sessionId) + ':' + String(messageId)
      const [phase, setPhase] = React.useState('idle') // idle | loading | playing
      const [error, setError] = React.useState('')
      const disposed = React.useRef(false)

      React.useEffect(() => () => { disposed.current = true }, [])

      const finishing = (failure) => {
        if (disposed.current) return
        setPhase('idle')
        if (failure) setError(failure.message || String(failure))
      }

      const onClick = async () => {
        setError('')
        if (phase === 'playing') {
          stopCurrent()
          setPhase('idle')
          return
        }
        if (phase === 'loading') return
        const cached = urlCache.get(key)
        if (cached) {
          setPhase('playing')
          playUrl(key, cached, finishing)
          return
        }
        setPhase('loading')
        try {
          const blob = await fetchAudio(sessionId, messageId)
          if (disposed.current) return
          const url = URL.createObjectURL(blob)
          urlCache.set(key, url)
          setPhase('playing')
          playUrl(key, url, finishing)
        } catch (failure) {
          finishing(failure)
        }
      }

      const title = error
        ? error
        : phase === 'loading'
          ? t('正在合成…', 'Synthesizing…')
          : phase === 'playing'
            ? t('点击停止', 'Click to stop')
            : urlCache.has(key)
              ? t('再次播放（本地缓存）', 'Play again (cached)')
              : t('朗读这条回复', 'Read this reply aloud')

      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        onClick,
        disabled: phase === 'loading',
        style: {
          ...styles.button,
          ...(phase === 'playing' ? styles.active : {}),
          ...(error ? styles.error : {}),
        },
        children: [
          h(SpeakerIcon, { playing: phase === 'playing', key: 'icon' }),
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
          .then((body) => { if (body && body.ok) setConfig(body.value) })
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
          urlCache.clear()
          setNotice(t('已保存', 'Saved'))
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      if (!config) return h('div', { style: styles.wrap }, h('span', { style: styles.sub }, t('加载中…', 'Loading…')))

      const cacheMb = (config.cache && config.cache.bytes ? config.cache.bytes / 1048576 : 0).toFixed(1)
      return h('div', { style: styles.wrap },
        h('div', { style: styles.card },
          h('div', { style: styles.row },
            h('span', { style: styles.title, key: 't' }, t('语音朗读', 'Read aloud')),
            h('span', { style: styles.sub, key: 's' }, t('用 DeepSeek 官方 TTS 朗读助手回复；音频缓存在本机', 'Speaks replies with the DeepSeek TTS API; audio cached on this machine')),
          ),
          h('div', { style: styles.row },
            h('span', { style: styles.sub, key: 'k' }, 'API Key'),
            config.keyConfigured
              ? h('span', { style: styles.ok, key: 'v' }, t('已配置（DEEPSEEK_API_KEY）', 'Configured (DEEPSEEK_API_KEY)'))
              : h('span', { style: styles.error, key: 'v' }, t('未配置，请先在 设置 → 模型 里填 DeepSeek Key', 'Not configured — set a DeepSeek key in Settings → Models')),
          ),
          h('div', { style: styles.row },
            h('span', { style: styles.sub, key: 'voice' }, t('音色', 'Voice')),
            h('select', {
              key: 'voice-select',
              style: styles.input,
              value: config.voice,
              onChange: (event) => save({ voice: event.target.value }),
              disabled: busy,
              children: [
                h('option', { value: 'stella', key: 'stella' }, 'stella（女声）'),
                h('option', { value: 'tide', key: 'tide' }, 'tide（男声）'),
              ],
            }),
            h('span', { style: styles.sub, key: 'chars-label' }, t('单次上限', 'Max chars')),
            h('input', {
              key: 'chars',
              type: 'number',
              min: 100,
              max: 4000,
              step: 100,
              style: { ...styles.input, width: '90px' },
              value: config.maxChars,
              disabled: busy,
              onChange: (event) => {
                const value = Number(event.target.value)
                if (Number.isFinite(value) && value >= 100) save({ maxChars: Math.min(4000, Math.floor(value)) })
              },
            }),
          ),
          h('div', { style: styles.row },
            h('span', { style: styles.sub, key: 'cache' },
              t('缓存：', 'Cache: ') + (config.cache ? config.cache.files : 0) + t(' 个文件 / ', ' files / ') + cacheMb + ' MB'),
            h('button', {
              key: 'clear',
              type: 'button',
              style: styles.plain,
              disabled: busy,
              onClick: async () => {
                try {
                  const response = await fetch(CLEAR_PATH, { method: 'POST' })
                  const body = await response.json()
                  if (body && body.ok) { urlCache.clear(); load(); setNotice(t('缓存已清空', 'Cache cleared')) }
                } catch (error) {
                  setFailure(error && error.message ? error.message : String(error))
                }
              },
              children: t('清空缓存', 'Clear cache'),
            }),
            h('span', { style: styles.sub, key: 'cap' }, t('上限 ', 'limit ') + config.cacheMaxMb + ' MB'),
          ),
          notice ? h('span', { style: styles.ok }, notice) : null,
          failure ? h('span', { style: styles.error }, failure) : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
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
