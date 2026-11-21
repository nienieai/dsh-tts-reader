// dsh-tts-reader — Host half.
//
// Job: turn one finalized assistant message into spoken audio, with an on-disk
// cache so a second click plays the same bytes without calling the API again.
//
//   1. read the message text from the session log (`sessionQuery`), never from
//      the browser — the page only sends a session id and a message id;
//   2. call the DeepSeek TTS API (`POST /v1/tools/tts`) with the API key held in
//      the DSH credential store; the key never leaves this process;
//   3. cache the finished WAV under <DSH_HOME>/cache/dsh-tts/<sha256>.wav and
//      answer later requests from that file (`x-tts-cache: hit`).
//
// Every route is loopback-only and rejects cross-site browser requests.

import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

export const name = 'dsh-tts-reader'
export const inject = []

const PREFIX = '/api/dsh-tts'
const CONFIG_PATH = PREFIX + '/config'
const READ_PATH = PREFIX + '/read'
const CLEAR_PATH = PREFIX + '/cache/clear'
const EVENTS_PATH = PREFIX + '/events'
const PENDING_PATH = PREFIX + '/pending'

const API_BASE = 'https://api.deepseek.com'
const KEY_REF = 'DEEPSEEK_API_KEY'
const VOICES = new Set(['stella', 'tide'])
const HARD_MAX_CHARS = 4000
const SAMPLE_RATE = 24000

const DEFAULTS = {
  voice: 'stella',
  maxChars: 4000,
  cacheMaxMb: 200,
  autoRead: false,
  autoReadInterim: false,
  speakQuestions: true,
  speakApprovals: true,
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function storePath() {
  return path.join(dshHome(), 'storages', 'dsh-tts-reader', 'settings.json')
}

function cacheDir() {
  return path.join(dshHome(), 'cache', 'dsh-tts')
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    if (parsed && typeof parsed === 'object') return { ...DEFAULTS, ...parsed }
  } catch {}
  return { ...DEFAULTS }
}

function writeSettings(next) {
  try {
    const file = storePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function normalizeSettings(raw, seed) {
  const merged = { ...DEFAULTS, ...(seed && typeof seed === 'object' ? seed : {}), ...(raw && typeof raw === 'object' ? raw : {}) }
  const voice = VOICES.has(String(merged.voice)) ? String(merged.voice) : DEFAULTS.voice
  const maxChars = Number.isFinite(merged.maxChars) && merged.maxChars > 0
    ? Math.min(HARD_MAX_CHARS, Math.floor(merged.maxChars))
    : DEFAULTS.maxChars
  const cacheMaxMb = Number.isFinite(merged.cacheMaxMb) && merged.cacheMaxMb > 0
    ? Math.min(4096, Math.floor(merged.cacheMaxMb))
    : DEFAULTS.cacheMaxMb
  const autoRead = merged.autoRead === true
  const autoReadInterim = merged.autoReadInterim === true
  const speakQuestions = merged.speakQuestions !== false
  const speakApprovals = merged.speakApprovals !== false
  return { voice, maxChars, cacheMaxMb, autoRead, autoReadInterim, speakQuestions, speakApprovals }
}

// ---------------------------------------------------------------- HTTP helpers

function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Loopback alone does not stop a hostile page: a browser talks to 127.0.0.1 from
 * a loopback socket too. Reject any browser request that is not same-origin.
 */
function isSameOriginRequest(request) {
  try {
    const site = String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
    if (site && site !== 'same-origin' && site !== 'none') return false
    const origin = request?.headers?.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      const host = String(request?.headers?.host ?? '').toLowerCase()
      if (new URL(origin).host.toLowerCase() !== host) return false
    }
    return true
  } catch {
    return false
  }
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { finish(undefined); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { finish(undefined) }
    })
    request.on('error', () => finish(undefined))
  })
}

// ---------------------------------------------------------------- session text

/** Join the durable text blocks of one assistant message. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n').trim()
}

async function readMessageText(sessionQuery, sessionId, messageId) {
  let events = []
  try {
    const snapshot = await sessionQuery.readSession(sessionId)
    events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
  } catch {
    const observation = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    try {
      events = observation && Array.isArray(observation.events) ? observation.events : []
    } finally {
      try {
        if (typeof observation?.dispose === 'function') observation.dispose()
        else if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
      } catch {}
    }
  }
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue
    const message = event.data && event.data.message
    if (!message) continue
    if (messageId && message.id !== messageId) continue
    const text = textOfContent(message.content)
    if (text) return text
  }
  return ''
}

// ---------------------------------------------------------------- audio cache

function cacheKey(voice, text) {
  return crypto.createHash('sha256').update(voice).update('\u0000').update(text, 'utf8').digest('hex')
}

function cacheFile(hash) {
  return path.join(cacheDir(), hash + '.wav')
}

function cacheStats() {
  let files = 0
  let bytes = 0
  try {
    for (const entry of fs.readdirSync(cacheDir())) {
      if (!entry.endsWith('.wav')) continue
      try { bytes += fs.statSync(path.join(cacheDir(), entry)).size } catch {}
      files += 1
    }
  } catch {}
  return { files, bytes, dir: cacheDir() }
}

function pruneCache(maxBytes) {
  try {
    const rows = []
    let total = 0
    for (const entry of fs.readdirSync(cacheDir())) {
      if (!entry.endsWith('.wav')) continue
      const file = path.join(cacheDir(), entry)
      try {
        const stat = fs.statSync(file)
        rows.push({ file, size: stat.size, mtime: stat.mtimeMs })
        total += stat.size
      } catch {}
    }
    if (total <= maxBytes) return
    rows.sort((a, b) => a.mtime - b.mtime)
    for (const row of rows) {
      if (total <= maxBytes) break
      try { fs.unlinkSync(row.file); total -= row.size } catch {}
    }
  } catch {}
}

function clearCache() {
  let removed = 0
  try {
    for (const entry of fs.readdirSync(cacheDir())) {
      if (!entry.endsWith('.wav')) continue
      try { fs.unlinkSync(path.join(cacheDir(), entry)); removed += 1 } catch {}
    }
  } catch {}
  return removed
}

/** Wrap raw PCM (24 kHz, mono, 16-bit LE) as a WAV container the browser can play. */
export function pcmToWav(pcm) {
  const channels = 1
  const bits = 16
  const blockAlign = (channels * bits) / 8
  const byteRate = SAMPLE_RATE * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// ---------------------------------------------------------------- TTS upstream

async function resolveApiKey(ctx) {
  try {
    const credential = await ctx.credentials.resolve(KEY_REF)
    const value = credential && typeof credential.value === 'string' ? credential.value.trim() : ''
    return value
  } catch {
    return ''
  }
}

async function openTtsStream(ctx, text, voice, signal) {
  const key = await resolveApiKey(ctx)
  if (!key) {
    const error = new Error('没有在 DSH 凭据里找到 ' + KEY_REF + '，请先在 设置 → 模型 里配置 DeepSeek API Key')
    error.status = 400
    error.code = 'NO_KEY'
    throw error
  }
  const response = await fetch(API_BASE + '/v1/tools/tts', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
  })
  if (!response.ok) {
    let detail = ''
    try { detail = await response.text() } catch {}
    let message = detail.slice(0, 400)
    try {
      const parsed = JSON.parse(detail)
      message = (parsed && parsed.error && parsed.error.message) || parsed.message || message
    } catch {}
    const error = new Error(message || 'TTS 上游返回 HTTP ' + response.status)
    error.status = response.status
    error.code = 'TTS_FAILED'
    throw error
  }
  if (!response.body) {
    const error = new Error('TTS 上游没有返回音频流')
    error.status = 502
    error.code = 'EMPTY_AUDIO'
    throw error
  }
  return response
}

/** Raw PCM response headers; the browser converts Int16 → Float32 itself. */
function pcmHeaders(extra) {
  return {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'x-tts-sample-rate': String(SAMPLE_RATE),
    'x-tts-channels': '1',
    'x-tts-bits': '16',
    ...extra,
  }
}

const WAV_HEADER_BYTES = 44

function writeWavHeader(fd) {
  // No explicit position: the sequential writes below must continue after it.
  fs.writeSync(fd, pcmToWav(Buffer.alloc(0)))
}

function patchWavSizes(fd, dataBytes) {
  // RIFF chunk size lives at 4; the data chunk size lives at 40. Two separate
  // writes: they are not adjacent, and byte 8 starts "WAVE".
  const riff = Buffer.alloc(4)
  riff.writeUInt32LE(36 + dataBytes, 0)
  fs.writeSync(fd, riff, 0, 4, 4)
  const data = Buffer.alloc(4)
  data.writeUInt32LE(dataBytes, 0)
  fs.writeSync(fd, data, 0, 4, 40)
}

// ---------------------------------------------------------------- plugin entry

export function apply(ctx, config) {
  const log = (() => {
    try { return typeof ctx.logger === 'function' ? ctx.logger('dsh-tts-reader') : ctx.logger } catch { return undefined }
  })()

  const seed = normalizeSettings(config, null)
  const stored = readSettings()
  const settings = normalizeSettings(stored, seed)
  if (JSON.stringify(stored) !== JSON.stringify(settings)) writeSettings(settings)

  // Live feed for auto-read: one SSE line per finalized assistant message.
  const listeners = new Set()
  // The request the page may replay: a pending question or approval. Exposed by
  // GET /pending so the replay button does not depend on the event stream.
  let pendingPrompt = null
  // sessionId -> the turn's latest assistant message id, published on turn close.
  const lastAssistant = new Map()
  const broadcast = (payload) => {
    const line = 'data: ' + JSON.stringify(payload) + '\n\n'
    for (const response of listeners) {
      try { response.write(line) } catch {}
    }
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      if (event.type === 'approval/asked') {
        const data = event.data || {}
        const tool = typeof data.toolName === 'string' && data.toolName ? data.toolName : '工具'
        const reason = typeof data.reason === 'string' && data.reason.trim() ? '，' + data.reason.trim() : ''
        const text = '需要授权：' + tool + reason
        pendingPrompt = { kind: 'approval', id: String(data.id || ''), text, at: Date.now() }
        broadcast({ type: 'approval', id: String(data.id || ''), toolName: tool, text })
        return
      }
      if (event.type === 'approval/decided') {
        const data = event.data || {}
        const id = String(data.id || '')
        if (pendingPrompt && pendingPrompt.id === id) pendingPrompt = null
        broadcast({ type: 'approval-closed', id })
        return
      }
      if (event.type !== 'assistant/message') return
      const message = event.data && event.data.message
      if (!message || !message.id) return
      // The page reads mid-turn output only when the user opted in, so every
      // message goes out tagged as interim...
      const sessionId = String(session.id)
      const messageId = String(message.id)
      // ...and the turn's last output is remembered for the closing broadcast:
      // that is the one the official action row (and the replay button) hosts.
      lastAssistant.set(sessionId, messageId)
      broadcast({ type: 'assistant', sessionId, messageId, final: false })
    } catch {}
  }), 'dsh-tts-reader: session feed')

  // One turn closed: publish its last output as the final read. `agent/status`
  // idle is the moment no driver remains, so the tail message is durable.
  ctx.effect(() => ctx.on('agent/status', (payload) => {
    try {
      if (!payload || payload.status !== 'idle') return
      const sessionId = payload.agent && payload.agent.id ? String(payload.agent.id) : ''
      if (!sessionId) return
      const messageId = lastAssistant.get(sessionId)
      if (!messageId) return
      lastAssistant.delete(sessionId)
      broadcast({ type: 'assistant', sessionId, messageId, final: true })
    } catch {}
  }), 'dsh-tts-reader: turn close')

  // A disposed session leaves no tail to publish.
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    try {
      if (session && session.id) lastAssistant.delete(String(session.id))
    } catch {}
  }), 'dsh-tts-reader: session cleanup')

  // Questions and plan review: the tool call carries the text the user must
  // answer, so snoop the waterfall and hand it to the page.
  function questionSpeech(args) {
    try {
      const list = Array.isArray(args && args.questions) ? args.questions : []
      const parts = []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const head = typeof item.header === 'string' && item.header.trim() ? item.header.trim() + '：' : ''
        const body = typeof item.question === 'string' ? item.question.trim() : ''
        const options = Array.isArray(item.options)
          ? item.options.map((option) => (option && typeof option.label === 'string' ? option.label.trim() : '')).filter(Boolean)
          : []
        const endsWithPunctuation = /[。！？!?.,，；;:：]$/.test(body)
        const optionsText = options.length
          ? (endsWithPunctuation ? '选项：' : '。选项：') + options.join('、')
          : ''
        if (head || body) parts.push(head + body + optionsText)
      }
      return parts.join('\n').slice(0, 2000)
    } catch {
      return ''
    }
  }

  ctx.effect(() => ctx.on('tools/execute', (exec, next) => {
    try {
      if (exec && exec.name === 'ask_user_question' && exec.callId) {
        const text = questionSpeech(exec.arguments)
        if (text) {
          pendingPrompt = { kind: 'question', id: String(exec.callId), text, at: Date.now() }
          broadcast({ type: 'question', id: String(exec.callId), text })
        }
      }
    } catch {}
    return next()
  }), 'dsh-tts-reader: questions')

  ctx.effect(() => ctx.on('tools/result', (exec) => {
    try {
      if (exec && exec.name === 'ask_user_question' && exec.callId) {
        const id = String(exec.callId)
        if (pendingPrompt && pendingPrompt.id === id) pendingPrompt = null
        broadcast({ type: 'question-closed', id })
      }
    } catch {}
  }), 'dsh-tts-reader: question replies')

  ctx.inject(['webServer', 'credentials', 'sessionQuery'], (scope) => {
    const guard = (request, response) => {
      if (!isLoopbackRequest(request) || !isSameOriginRequest(request)) {
        writeJson(response, 403, { ok: false, code: 'FORBIDDEN', error: '只接受本机同源请求' })
        return false
      }
      return true
    }

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: async (request, response) => {
        if (!guard(request, response)) return
        const method = request.method ?? 'GET'
        if (method === 'GET') {
          const current = readSettings()
          let keyConfigured = false
          try {
            const info = await scope.credentials.describe(KEY_REF)
            keyConfigured = !!(info && info.configured)
          } catch {}
          return writeJson(response, 200, { ok: true, value: { ...current, voices: [...VOICES], cache: cacheStats(), keyConfigured, sseClients: listeners.size } })
        }
        if (method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object') return writeJson(response, 400, { ok: false, code: 'BAD_BODY', error: '请求体不是 JSON' })
        const current = readSettings()
        const next = normalizeSettings({ ...current, ...pick(body, ['voice', 'maxChars', 'cacheMaxMb', 'autoRead', 'speakQuestions', 'speakApprovals']) }, null)
        if (body.clearCache === true) clearCache()
        if (!writeSettings(next)) return writeJson(response, 500, { ok: false, code: 'WRITE_FAILED', error: '写入设置失败' })
        pruneCache(next.cacheMaxMb * 1024 * 1024)
        let keyConfigured = false
        try {
          const info = await scope.credentials.describe(KEY_REF)
          keyConfigured = !!(info && info.configured)
        } catch {}
        return writeJson(response, 200, { ok: true, value: { ...next, voices: [...VOICES], cache: cacheStats(), keyConfigured } })
      },
    }), 'dsh-tts-reader: config')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: CLEAR_PATH,
      handler: async (request, response) => {
        if (!guard(request, response)) return
        if ((request.method ?? '') !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const removed = clearCache()
        return writeJson(response, 200, { ok: true, value: { removed, cache: cacheStats() } })
      },
    }), 'dsh-tts-reader: cache')

    // Auto-read feed: the page opens one EventSource and replays new replies.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: EVENTS_PATH,
      handler: (request, response) => {
        if (!guard(request, response)) return
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        response.write(': connected\n\n')
        listeners.add(response)
        const heartbeat = setInterval(() => {
          try { response.write(': ping\n\n') } catch {}
        }, 25000)
        const cleanup = () => {
          clearInterval(heartbeat)
          listeners.delete(response)
        }
        request.on('close', cleanup)
        response.on('close', cleanup)
      },
    }), 'dsh-tts-reader: events')

    // The replay button reads this; it must not depend on a live event stream.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: PENDING_PATH,
      handler: (request, response) => {
        if (!guard(request, response)) return
        return writeJson(response, 200, { ok: true, value: pendingPrompt })
      },
    }), 'dsh-tts-reader: pending')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: READ_PATH,
      handler: async (request, response) => {
        if (!guard(request, response)) return
        if ((request.method ?? '') !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
        // An explicit text wins: it carries a selected paragraph the page already
        // has, so the Host does not have to re-read the whole message.
        const explicitText = typeof body?.text === 'string' ? body.text.trim() : ''
        if (!explicitText && (!sessionId || !messageId)) {
          return writeJson(response, 400, { ok: false, code: 'BAD_REQUEST', error: '需要 sessionId 与 messageId（或直接给 text）' })
        }

        const current = readSettings()
        let text = explicitText
        if (!text) {
          try {
            text = await readMessageText(scope.sessionQuery, sessionId, messageId)
          } catch (error) {
            return writeJson(response, 500, { ok: false, code: 'SESSION_READ_FAILED', error: '读取会话失败：' + (error?.message ?? String(error)) })
          }
          if (!text) return writeJson(response, 404, { ok: false, code: 'NO_TEXT', error: '这条消息里没有可朗读的文字' })
        }
        const truncated = text.length > current.maxChars
        if (truncated) text = text.slice(0, current.maxChars)

        const hash = cacheKey(current.voice, text)
        const file = cacheFile(hash)
        const meta = { 'x-tts-voice': current.voice, 'x-tts-truncated': truncated ? '1' : '0' }

        // 1) Cache hit: stream the PCM body after the WAV header.
        try {
          const stat = fs.statSync(file)
          if (stat.size > WAV_HEADER_BYTES) {
            const magic = Buffer.alloc(4)
            const head = fs.openSync(file, 'r')
            try { fs.readSync(head, magic, 0, 4, 0) } finally { fs.closeSync(head) }
            if (magic.toString('ascii') === 'RIFF') {
              response.writeHead(200, pcmHeaders({ ...meta, 'x-tts-cache': 'hit', 'content-length': String(stat.size - WAV_HEADER_BYTES) }))
              const stream = fs.createReadStream(file, { start: WAV_HEADER_BYTES })
              stream.on('error', () => { try { response.destroy() } catch {} })
              stream.pipe(response)
              return
            }
            // A damaged entry must not be served: drop it and synthesize again.
            try { fs.unlinkSync(file) } catch {}
          }
        } catch {}

        // 2) Miss: stream upstream PCM to the page while teeing it into the cache.
        const controller = new AbortController()
        const abort = () => { try { controller.abort() } catch {} }
        request.on('aborted', abort)
        response.on('close', () => { if (!response.writableEnded) abort() })

        let upstream
        try {
          upstream = await openTtsStream(scope, text, current.voice, controller.signal)
        } catch (error) {
          return writeJson(response, 502, {
            ok: false,
            code: error?.code || 'TTS_FAILED',
            error: error?.message ?? String(error),
          })
        }

        response.writeHead(200, pcmHeaders({ ...meta, 'x-tts-cache': 'miss' }))

        let tmp = null
        let fd = -1
        let written = 0
        let aborted = false
        try {
          fs.mkdirSync(cacheDir(), { recursive: true })
          tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
          fd = fs.openSync(tmp, 'w')
          writeWavHeader(fd)
        } catch {
          if (fd >= 0) { try { fs.closeSync(fd) } catch {} }
          fd = -1
          tmp = null
        }

        try {
          for await (const chunk of Readable.fromWeb(upstream.body)) {
            if (controller.signal.aborted) { aborted = true; break }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            written += buffer.length
            if (fd >= 0) {
              try { fs.writeSync(fd, buffer) } catch {
                try { fs.closeSync(fd) } catch {}
                fd = -1
              }
            }
            if (!response.write(buffer)) await once(response, 'drain')
          }
          if (!aborted) response.end()
        } catch {
          aborted = true
          try { response.destroy() } catch {}
        } finally {
          if (fd >= 0) {
            if (!aborted && written > 0) {
              try {
                patchWavSizes(fd, written)
                fs.closeSync(fd)
                fs.renameSync(tmp, file)
                pruneCache(current.cacheMaxMb * 1024 * 1024)
              } catch {
                try { fs.closeSync(fd) } catch {}
                try { fs.unlinkSync(tmp) } catch {}
              }
            } else {
              try { fs.closeSync(fd) } catch {}
              try { if (tmp) fs.unlinkSync(tmp) } catch {}
            }
            fd = -1
          } else if (tmp) {
            try { fs.unlinkSync(tmp) } catch {}
          }
        }
      },
    }), 'dsh-tts-reader: read')
  })

  log?.info?.('dsh-tts-reader 已加载，缓存目录：' + cacheDir())
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key]
  }
  return out
}
