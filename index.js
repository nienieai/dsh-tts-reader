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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-tts-reader'
export const inject = []

const PREFIX = '/api/dsh-tts'
const CONFIG_PATH = PREFIX + '/config'
const READ_PATH = PREFIX + '/read'
const CLEAR_PATH = PREFIX + '/cache/clear'

const API_BASE = 'https://api.deepseek.com'
const KEY_REF = 'DEEPSEEK_API_KEY'
const VOICES = new Set(['stella', 'tide'])
const HARD_MAX_CHARS = 4000
const SAMPLE_RATE = 24000
const AUDIO_HEADERS = { 'cache-control': 'no-store' }

const DEFAULTS = { voice: 'stella', maxChars: 4000, cacheMaxMb: 200 }

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
  return { voice, maxChars, cacheMaxMb }
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

async function synthesize(ctx, text, voice) {
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
    signal: AbortSignal.timeout(90000),
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
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) {
    const error = new Error('TTS 上游返回了空音频')
    error.status = 502
    error.code = 'EMPTY_AUDIO'
    throw error
  }
  return pcmToWav(bytes)
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
          return writeJson(response, 200, { ok: true, value: { ...current, voices: [...VOICES], cache: cacheStats(), keyConfigured } })
        }
        if (method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object') return writeJson(response, 400, { ok: false, code: 'BAD_BODY', error: '请求体不是 JSON' })
        const current = readSettings()
        const next = normalizeSettings({ ...current, ...pick(body, ['voice', 'maxChars', 'cacheMaxMb']) }, null)
        if (body.clearCache === true) clearCache()
        if (!writeSettings(next)) return writeJson(response, 500, { ok: false, code: 'WRITE_FAILED', error: '写入设置失败' })
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

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: READ_PATH,
      handler: async (request, response) => {
        if (!guard(request, response)) return
        if ((request.method ?? '') !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
        if (!sessionId || !messageId) return writeJson(response, 400, { ok: false, code: 'BAD_REQUEST', error: '需要 sessionId 与 messageId' })

        const current = readSettings()
        let text = ''
        try {
          text = await readMessageText(scope.sessionQuery, sessionId, messageId)
        } catch (error) {
          return writeJson(response, 500, { ok: false, code: 'SESSION_READ_FAILED', error: '读取会话失败：' + (error?.message ?? String(error)) })
        }
        if (!text) return writeJson(response, 404, { ok: false, code: 'NO_TEXT', error: '这条消息里没有可朗读的文字' })
        const truncated = text.length > current.maxChars
        if (truncated) text = text.slice(0, current.maxChars)

        const hash = cacheKey(current.voice, text)
        const file = cacheFile(hash)
        try {
          const cached = fs.readFileSync(file)
          response.writeHead(200, {
            ...AUDIO_HEADERS,
            'content-type': 'audio/wav',
            'content-length': String(cached.length),
            'x-tts-cache': 'hit',
            'x-tts-voice': current.voice,
            'x-tts-truncated': truncated ? '1' : '0',
          })
          response.end(cached)
          return
        } catch {}

        try {
          const audio = await synthesize(scope, text, current.voice)
          try {
            fs.mkdirSync(cacheDir(), { recursive: true })
            const tmp = file + '.' + process.pid + '.tmp'
            fs.writeFileSync(tmp, audio)
            fs.renameSync(tmp, file)
            pruneCache(current.cacheMaxMb * 1024 * 1024)
          } catch (error) {
            log?.warn?.('cache write failed: ' + String(error?.message ?? error))
          }
          response.writeHead(200, {
            ...AUDIO_HEADERS,
            'content-type': 'audio/wav',
            'content-length': String(audio.length),
            'x-tts-cache': 'miss',
            'x-tts-voice': current.voice,
            'x-tts-truncated': truncated ? '1' : '0',
          })
          response.end(audio)
        } catch (error) {
          const code = error?.code === 'NO_KEY' ? 400 : (error?.status === 401 || error?.status === 403 ? 502 : 502)
          return writeJson(response, code, {
            ok: false,
            code: error?.code || 'TTS_FAILED',
            error: error?.message ?? String(error),
          })
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
