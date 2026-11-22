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
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

export const name = 'dsh-tts-reader'
export const inject = []

const PREFIX = '/api/dsh-tts'
const CONFIG_PATH = PREFIX + '/config'
const READ_PATH = PREFIX + '/read'
const PLAN_PATH = PREFIX + '/plan'
const CLEAR_PATH = PREFIX + '/cache/clear'
const EVENTS_PATH = PREFIX + '/events'
const PENDING_PATH = PREFIX + '/pending'
const RECENT_PATH = PREFIX + '/recent'
const BRIDGE_PATH = PREFIX + '/bridge'
const BRIDGE_STREAM_PATH = BRIDGE_PATH + '/stream'

const API_BASE = 'https://api.deepseek.com'
const KEY_REF = 'DEEPSEEK_API_KEY'
const VOICES = new Set(['stella', 'tide'])
const HARD_MAX_CHARS = 4000
const SAMPLE_RATE = 24000
const MIN_SPEED = 0.5
const MAX_SPEED = 2

const DEFAULTS = {
  // Which synthesizer produces the audio: the DeepSeek API, a local Piper
  // executable, the operating system's own voices, or an OpenAI-compatible
  // endpoint the user configures.
  engine: 'deepseek',
  piperPath: '',
  piperModel: '',
  // Optional second Piper model for mostly-Latin paragraphs: a Chinese voice
  // reads English as nonsense, so English text can be routed to its own voice.
  piperModelEn: '',
  // Operating-system voice: a name on Windows/macOS, a language/voice id on
  // Linux. Empty means the platform default.
  systemVoice: '',
  // OpenAI-compatible endpoint: base URL, model, voice, response format. The
  // key is kept out of this file, in secrets.json.
  customBaseUrl: '',
  customModel: '',
  customVoice: '',
  customFormat: 'wav',
  // Which wire protocol the custom endpoint speaks. Each preset decides the URL,
  // headers and body; the response is sniffed so wav and raw pcm both work.
  customProtocol: 'openai',
  // GPT-SoVITS api_v2 needs a reference clip plus its transcript.
  sovitsRefAudio: '',
  sovitsPromptText: '',
  sovitsTextLang: 'zh',
  sovitsPromptLang: 'zh',
  // Fully custom request: method, path, headers and body with {{placeholders}}.
  customMethod: 'POST',
  customPath: '',
  customHeaders: '',
  customBody: '',
  customAudioType: 'auto',
  voice: 'stella',
  maxChars: 4000,
  cacheMaxMb: 200,
  // Where synthesized audio is kept: `disk` survives restarts and is evicted by
  // size; `memory` never touches the disk and disappears with the process.
  cacheMode: 'disk',
  // Playback rate for the page's pitch-preserving time-stretch; the TTS API
  // itself has no speed parameter, so this never reaches the request.
  speed: 1,
  autoRead: false,
  autoReadInterim: false,
  speakQuestions: true,
  speakApprovals: true,
}

// `piper` stays in the set so an old settings.json still loads, but the UI no
// longer offers it: normalizeSettings turns it into `system` (see below).
const ENGINES = new Set(['deepseek', 'piper', 'system', 'custom', 'browser'])
const CUSTOM_FORMATS = new Set(['wav', 'pcm'])
const CUSTOM_PROTOCOLS = new Set(['openai', 'gpt-sovits', 'fish', 'template'])
const CUSTOM_AUDIO_TYPES = new Set(['auto', 'wav', 'pcm'])
const CUSTOM_METHODS = new Set(['POST', 'GET'])
const SOVITS_LANGS = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])

/** Languages GPT-SoVITS accepts for the text and the prompt transcript. */
export const SPEECH_LANGS = [...SOVITS_LANGS]

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function storePath() {
  return path.join(dshHome(), 'storages', 'dsh-tts-reader', 'settings.json')
}

/** Keys never live in settings.json: the settings API hands that file around. */
function secretsPath() {
  return path.join(dshHome(), 'storages', 'dsh-tts-reader', 'secrets.json')
}

function readSecrets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsPath(), 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch {}
  return {}
}

function writeSecrets(next) {
  try {
    const file = secretsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    // Windows ignores the mode, so tighten it explicitly where the API exists.
    try { fs.chmodSync(file, 0o600) } catch {}
    return true
  } catch {
    return false
  }
}

/** The custom endpoint's key, or '' when the user has not set one. */
function customApiKey() {
  const secrets = readSecrets()
  return typeof secrets.customApiKey === 'string' ? secrets.customApiKey.trim() : ''
}

function cacheDir() {
  return path.join(dshHome(), 'cache', 'dsh-tts')
}

/**
 * Pinned audio for the fixed spoken markers ("here is a code block" and so on).
 * They live in their own folder so the size-based eviction never touches them:
 * a marker is synthesized once per engine/voice and reused from then on.
 */
function fixedCacheDir() {
  return path.join(cacheDir(), 'fixed')
}

/** Only what the user actually saved; defaults and seeds are applied later. */
function readStoredSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch {}
  return {}
}

function readSettings() {
  return { ...DEFAULTS, ...readStoredSettings() }
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

/** A base URL as typed, without trailing slashes; '' when it is not http(s). */
function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return (url.origin + url.pathname).replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** The `/v1/audio/speech` URL an OpenAI-compatible base URL resolves to. */
export function speechEndpoint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return ''
  if (/\/audio\/speech$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return base + '/audio/speech'
  return base + '/v1/audio/speech'
}

/** Short identity of an endpoint, so two providers never share cache entries. */
export function endpointFingerprint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl).toLowerCase()
  if (!base) return 'none'
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 12)
}

/** True when an endpoint sits on this machine, where no key is expected. */
export function isLoopbackUrl(value) {
  try {
    const url = new URL(String(value))
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === '::1' || host === 'localhost'
  } catch {
    return false
  }
}

function fillTemplate(value, vars) {
  return String(value).replace(/\{\{\s*(text|voice|format|model|lang)\s*\}\}/g, (_match, name) => (vars[name] ?? ''))
}

/** Same as fillTemplate but URL-safe, for GET query strings. */
function fillTemplateEncoded(value, vars) {
  return String(value).replace(/\{\{\s*(text|voice|format|model|lang)\s*\}\}/g, (_match, name) => encodeURIComponent(vars[name] ?? ''))
}

/** A GET template becomes a query string: JSON values or a raw query line. */
export function buildTemplateQuery(raw, vars) {
  const source = String(raw || '')
  if (!source.trim()) return ''
  if (source.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(source)
      const params = new URLSearchParams()
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === 'string') params.set(name, fillTemplate(value, vars))
        else if (typeof value === 'number' || typeof value === 'boolean') params.set(name, String(value))
      }
      return params.toString()
    } catch {}
  }
  return fillTemplateEncoded(source, vars)
}

/**
 * Fill a custom request-body template. When the template is JSON, the values are
 * walked and replaced *after* parsing, so a quote in the spoken text cannot
 * break the request; anything else is plain text substitution.
 */
export function buildTemplateBody(raw, vars) {
  const source = String(raw || '')
  if (!source.trim()) return ''
  try {
    const parsed = JSON.parse(source)
    const walk = (node) => {
      if (typeof node === 'string') return fillTemplate(node, vars)
      if (Array.isArray(node)) return node.map(walk)
      if (node && typeof node === 'object') {
        const out = {}
        for (const [key, value] of Object.entries(node)) out[key] = walk(value)
        return out
      }
      return node
    }
    return JSON.stringify(walk(parsed))
  } catch {
    return fillTemplate(source, vars)
  }
}

/** URL, headers and body for the configured custom protocol. */
export function buildCustomRequest(settings, text, key) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const protocol = CUSTOM_PROTOCOLS.has(String(source.customProtocol)) ? String(source.customProtocol) : 'openai'
  const base = normalizeBaseUrl(source.customBaseUrl)
  const auth = key ? { authorization: 'Bearer ' + key } : {}
  if (protocol === 'gpt-sovits') {
    return {
      protocol,
      url: (base || 'http://127.0.0.1:9880') + '/tts',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        text,
        text_lang: source.sovitsTextLang || 'zh',
        ref_audio_path: source.sovitsRefAudio || '',
        prompt_text: source.sovitsPromptText || '',
        prompt_lang: source.sovitsPromptLang || 'zh',
        media_type: 'wav',
        streaming_mode: false,
      }),
      audioType: 'wav',
    }
  }
  if (protocol === 'fish') {
    return {
      protocol,
      url: (base || 'https://api.fish.audio') + '/v1/tts',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        text,
        ...(source.customModel ? { model: source.customModel } : {}),
        ...(source.customVoice ? { reference_id: source.customVoice } : {}),
        format: 'wav',
      }),
      audioType: 'wav',
    }
  }
  if (protocol === 'template') {
    const pathPart = String(source.customPath || '').trim()
    let url = base
    if (pathPart) {
      if (/^https?:\/\//i.test(pathPart)) url = pathPart
      else url = base + (pathPart.startsWith('/') ? pathPart : '/' + pathPart)
    }
    const vars = {
      text,
      voice: source.customVoice || '',
      format: source.customFormat || 'wav',
      model: source.customModel || '',
      lang: source.sovitsTextLang || 'zh',
    }
    let headers = { 'content-type': 'application/json' }
    try {
      const parsed = JSON.parse(source.customHeaders || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = { ...headers, ...parsed }
    } catch {}
    if (key && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
      headers.authorization = 'Bearer ' + key
    }
    const method = source.customMethod === 'GET' ? 'GET' : 'POST'
    const body = buildTemplateBody(source.customBody || '{"text":"{{text}}"}', vars)
    const audioType = CUSTOM_AUDIO_TYPES.has(String(source.customAudioType)) ? String(source.customAudioType) : 'auto'
    if (method === 'GET') {
      // For GET the template is a query string, or JSON whose string values
      // become encoded query parameters.
      const query = buildTemplateQuery(source.customBody || 'text={{text}}', vars)
      const full = query ? url + (url.includes('?') ? '&' : '?') + query : url
      return { protocol, url: full, method, headers, body: undefined, audioType }
    }
    return { protocol, url, method, headers, body, audioType }
  }
  const endpoint = speechEndpoint(base || source.customBaseUrl)
  return {
    protocol: 'openai',
    url: endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({
      model: source.customModel || 'tts-1',
      input: text,
      voice: source.customVoice || 'alloy',
      response_format: source.customFormat === 'pcm' ? 'pcm' : 'wav',
    }),
    audioType: 'auto',
  }
}

/** Everything that changes the audio of a custom endpoint, for the cache key. */
function customIdentity(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const protocol = CUSTOM_PROTOCOLS.has(String(source.customProtocol)) ? String(source.customProtocol) : 'openai'
  const parts = [protocol]
  if (protocol === 'gpt-sovits') {
    parts.push(source.sovitsRefAudio || '', source.sovitsPromptText || '', source.sovitsTextLang || '', source.sovitsPromptLang || '')
  } else if (protocol === 'fish') {
    parts.push(source.customModel || '', source.customVoice || '')
  } else if (protocol === 'template') {
    parts.push(source.customMethod || 'POST', source.customPath || '', source.customHeaders || '', source.customBody || '')
  } else {
    parts.push(source.customModel || '', source.customVoice || '', source.customFormat || 'wav')
  }
  return parts.join('\u0000')
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
  const rawSpeed = Number(merged.speed)
  const speed = Number.isFinite(rawSpeed) && rawSpeed > 0
    ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(rawSpeed * 100) / 100))
    : DEFAULTS.speed
  const requestedEngine = ENGINES.has(String(merged.engine)) ? String(merged.engine) : DEFAULTS.engine
  // Piper is hidden from the settings UI (browser speech replaces it). An old
  // saved value degrades to the system voices, which need no path or model.
  const engine = requestedEngine === 'piper' ? 'system' : requestedEngine
  const piperPath = typeof merged.piperPath === 'string' ? merged.piperPath.trim() : ''
  const piperModel = typeof merged.piperModel === 'string' ? merged.piperModel.trim() : ''
  const piperModelEn = typeof merged.piperModelEn === 'string' ? merged.piperModelEn.trim() : ''
  const systemVoice = typeof merged.systemVoice === 'string' ? merged.systemVoice.trim() : ''
  const customBaseUrl = normalizeBaseUrl(merged.customBaseUrl)
  const customModel = typeof merged.customModel === 'string' ? merged.customModel.trim() : ''
  const customVoice = typeof merged.customVoice === 'string' ? merged.customVoice.trim() : ''
  const customFormat = CUSTOM_FORMATS.has(String(merged.customFormat)) ? String(merged.customFormat) : DEFAULTS.customFormat
  const customProtocol = CUSTOM_PROTOCOLS.has(String(merged.customProtocol)) ? String(merged.customProtocol) : DEFAULTS.customProtocol
  const sovitsRefAudio = typeof merged.sovitsRefAudio === 'string' ? merged.sovitsRefAudio.trim() : ''
  const sovitsPromptText = typeof merged.sovitsPromptText === 'string' ? merged.sovitsPromptText.trim() : ''
  const sovitsTextLang = SOVITS_LANGS.has(String(merged.sovitsTextLang)) ? String(merged.sovitsTextLang) : DEFAULTS.sovitsTextLang
  const sovitsPromptLang = SOVITS_LANGS.has(String(merged.sovitsPromptLang)) ? String(merged.sovitsPromptLang) : DEFAULTS.sovitsPromptLang
  const customMethod = CUSTOM_METHODS.has(String(merged.customMethod)) ? String(merged.customMethod) : DEFAULTS.customMethod
  const customPath = typeof merged.customPath === 'string' ? merged.customPath.trim() : ''
  const customHeaders = typeof merged.customHeaders === 'string' ? merged.customHeaders : ''
  const customBody = typeof merged.customBody === 'string' ? merged.customBody : ''
  const customAudioType = CUSTOM_AUDIO_TYPES.has(String(merged.customAudioType)) ? String(merged.customAudioType) : DEFAULTS.customAudioType
  const cacheMode = merged.cacheMode === 'memory' ? 'memory' : 'disk'
  return {
    engine, piperPath, piperModel, piperModelEn, systemVoice,
    customBaseUrl, customModel, customVoice, customFormat, customProtocol,
    sovitsRefAudio, sovitsPromptText, sovitsTextLang, sovitsPromptLang,
    customMethod, customPath, customHeaders, customBody, customAudioType,
    voice, maxChars, cacheMaxMb, cacheMode, speed, autoRead, autoReadInterim, speakQuestions, speakApprovals,
  }
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
  // A response whose client already left must not be written to: on a wrapped
  // or destroyed stream that throws, and a throw here has no caller to catch it.
  if (!response || response.destroyed || response.writableEnded) return
  try {
    const body = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  } catch {}
}

/**
 * Every route runs through this. The Host reports a rejected request handler as
 * an unhandled rejection and turns it into a fatal error, so one escaping error
 * (an aborted stream, a client that disconnected mid-body) would take the whole
 * process down. Connections also get no-op error listeners: a socket that dies
 * while a response is streaming emits 'error', and an unhandled 'error' event is
 * an uncaught exception.
 */
function routeHandler(log, handler) {
  return async (request, response) => {
    const ignore = () => {}
    try { request.on('error', ignore) } catch {}
    try { response.on('error', ignore) } catch {}
    try {
      await handler(request, response)
    } catch (error) {
      try { log?.warn?.('[dsh-tts-reader] 请求处理失败：' + (error?.message ?? String(error))) } catch {}
      try {
        if (!response.headersSent) writeJson(response, 500, { ok: false, error: '内部错误' })
        else if (!response.writableEnded) response.end()
      } catch {}
    }
  }
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
    // A client that leaves mid-body closes the request without 'error' on some
    // versions; without this the handler would wait forever for a body.
    request.on('close', () => finish(undefined))
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

/** A short fingerprint of the local voice, so a model swap invalidates its audio. */
export function voiceFingerprint(modelPath) {
  if (!modelPath) return 'none'
  let size = 0
  try { size = fs.statSync(modelPath).size } catch {}
  return crypto.createHash('sha1')
    .update(path.basename(String(modelPath)))
    .update(':')
    .update(String(size))
    .digest('hex')
    .slice(0, 12)
}

function cacheKey(settings, text, modelPath) {
  const engine = settings.engine
  const voice = settings.voice
  const hash = crypto.createHash('sha256')
  // Each engine names its own identity, so two providers can never collide;
  // DeepSeek keeps the bare form so audio cached before engines existed stays valid.
  if (engine === 'piper') {
    // Local audio depends on the model file (and changed with the pause squasher).
    hash.update('piper:v2').update('\u0000').update(voiceFingerprint(modelPath || settings.piperModel)).update('\u0000')
  } else if (engine === 'system') {
    hash.update('system:v1').update('\u0000').update(process.platform).update('\u0000').update(settings.systemVoice || '').update('\u0000')
  } else if (engine === 'custom') {
    hash.update('custom:v2').update('\u0000').update(endpointFingerprint(settings.customBaseUrl)).update('\u0000')
    hash.update(customIdentity(settings)).update('\u0000')
  } else if (engine !== 'deepseek') {
    hash.update(String(engine)).update('\u0000')
  }
  return hash.update(voice).update('\u0000').update(text, 'utf8').digest('hex')
}

function cacheFile(hash, pinned = false) {
  return path.join(pinned ? fixedCacheDir() : cacheDir(), hash + '.wav')
}

/** True when the file is a WAV body we can stream; a damaged entry is dropped. */
function hasCachedWav(file) {
  try {
    const stat = fs.statSync(file)
    if (stat.size <= WAV_HEADER_BYTES) return false
    const magic = Buffer.alloc(4)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, magic, 0, 4, 0) } finally { fs.closeSync(fd) }
    if (magic.toString('ascii') === 'RIFF') return true
  } catch {
    return false
  }
  // A damaged entry must not be served: drop it and synthesize again.
  try { fs.unlinkSync(file) } catch {}
  return false
}

function countCache(dir) {
  let files = 0
  let bytes = 0
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.wav')) continue
      try { bytes += fs.statSync(path.join(dir, entry)).size } catch {}
      files += 1
    }
  } catch {}
  return { files, bytes }
}

function cacheStats() {
  const pinned = countCache(fixedCacheDir())
  const loose = countCache(cacheDir())
  return {
    files: loose.files + pinned.files,
    bytes: loose.bytes + pinned.bytes,
    dir: cacheDir(),
    pinned,
    memory: memoryCacheStats(),
  }
}

function pruneCache(maxBytes) {
  try {
    const rows = []
    let total = 0
    // Only the loose folder is subject to eviction: `fixed/` holds the spoken
    // markers, which are tiny and must stay available for every read.
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
  let removed = memoryCache.size
  memoryCache.clear()
  for (const dir of [cacheDir(), fixedCacheDir()]) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.wav')) continue
        try { fs.unlinkSync(path.join(dir, entry)); removed += 1 } catch {}
      }
    } catch {}
  }
  return removed
}

// ------------------------------------------------------------- memory cache
// `cacheMode: 'memory'` keeps the same audio in RAM: nothing is written to disk
// and nothing survives a restart. Fixed-size LRU, pinned marker audio exempt.
const MEMORY_CACHE_BYTES = 128 * 1024 * 1024
const memoryCache = new Map()

function memoryCacheGet(hash) {
  const entry = memoryCache.get(hash)
  if (!entry) return null
  // Map keeps insertion order, so re-inserting is the LRU touch.
  memoryCache.delete(hash)
  memoryCache.set(hash, entry)
  return entry.buffer
}

function memoryCacheSet(hash, buffer, pinned) {
  if (!buffer || buffer.length === 0) return
  memoryCache.delete(hash)
  memoryCache.set(hash, { buffer, pinned: !!pinned })
  let total = memoryCacheStats().bytes
  if (total <= MEMORY_CACHE_BYTES) return
  for (const [key, entry] of memoryCache) {
    if (total <= MEMORY_CACHE_BYTES) break
    if (entry.pinned) continue
    memoryCache.delete(key)
    total -= entry.buffer.length
  }
}

function memoryCacheStats() {
  let bytes = 0
  for (const entry of memoryCache.values()) bytes += entry.buffer.length
  return { files: memoryCache.size, bytes, limitBytes: MEMORY_CACHE_BYTES }
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

// ---------------------------------------------------------------- speech units

/**
 * Markdown → the plain text a reader actually sees. One cache file per
 * paragraph is only reusable for a selection if both sides go through this
 * same funnel: the session stores markdown, a selection is rendered text.
 */
/** Table separator row: pipes plus only spaces, colons and at least 3 dashes. */
function isTableSeparator(line) {
  if (!line || line.indexOf('|') === -1) return false
  if (!/^[\s|:-]+$/.test(line)) return false
  return (line.match(/-/g) || []).length >= 3
}

/**
 * Blocks that are not read aloud are still announced. Dropping them silently
 * makes the reader skip from one sentence into the next, which sounds like a
 * lost line; one short marker per block fixes that. Every marker is a fixed
 * string on its own paragraph, so it is synthesized once per voice and then
 * served from the pinned cache folder (`BLOCK_MARKER_TEXTS` keys that lookup).
 */
export const BLOCK_MARKERS = {
  code: '这里是代码块',
  mermaid: '这里是 Mermaid 图表',
  sequence: '这里是时序图',
  flowchart: '这里是流程图',
  classDiagram: '这里是类图',
  stateDiagram: '这里是状态图',
  erDiagram: '这里是 ER 图',
  requirementDiagram: '这里是需求图',
  gantt: '这里是甘特图',
  pie: '这里是饼图',
  mindmap: '这里是思维导图',
  timeline: '这里是时间线',
  gitGraph: '这里是 Git 分支图',
  journey: '这里是用户旅程图',
  quadrantChart: '这里是象限图',
  xychart: '这里是坐标图',
  sankey: '这里是桑基图',
  table: '这里是表格',
  math: '这里是公式',
  image: '这里是图片',
}

/** Every spoken stand-in, so their audio can be pinned instead of evicted. */
export const BLOCK_MARKER_TEXTS = new Set(Object.values(BLOCK_MARKERS))

/** Which marker a Mermaid diagram earns, judging by its first meaningful line. */
export function mermaidMarker(body) {
  const first = String(body || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%')) || ''
  const head = first.toLowerCase()
  const rules = [
    ['sequencediagram', BLOCK_MARKERS.sequence],
    ['flowchart', BLOCK_MARKERS.flowchart],
    ['graph', BLOCK_MARKERS.flowchart],
    ['classdiagram', BLOCK_MARKERS.classDiagram],
    ['statediagram', BLOCK_MARKERS.stateDiagram],
    ['erdiagram', BLOCK_MARKERS.erDiagram],
    ['requirementdiagram', BLOCK_MARKERS.requirementDiagram],
    ['gantt', BLOCK_MARKERS.gantt],
    ['pie', BLOCK_MARKERS.pie],
    ['mindmap', BLOCK_MARKERS.mindmap],
    ['timeline', BLOCK_MARKERS.timeline],
    ['gitgraph', BLOCK_MARKERS.gitGraph],
    ['journey', BLOCK_MARKERS.journey],
    ['quadrantchart', BLOCK_MARKERS.quadrantChart],
    ['xychart', BLOCK_MARKERS.xychart],
    ['sankey', BLOCK_MARKERS.sankey],
  ]
  for (const [prefix, marker] of rules) {
    if (head.startsWith(prefix)) return marker
  }
  return BLOCK_MARKERS.mermaid
}

/** Swap every table for one marker line: a spoken table is noise, not speech. */
function replaceTables(text, blockKeep) {
  const lines = text.split('\n')
  const drop = new Array(lines.length).fill(false)
  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableSeparator(lines[i])) continue
    // The header sits directly above the separator, the body directly below.
    let start = i - 1
    while (start >= 0 && lines[start].trim() !== '' && !isTableSeparator(lines[start]) && lines[start].includes('|')) start -= 1
    let end = i + 1
    while (end < lines.length && lines[end].trim() !== '' && lines[end].includes('|')) end += 1
    for (let k = start + 1; k < end; k += 1) drop[k] = true
  }
  const out = []
  let index = 0
  while (index < lines.length) {
    if (!drop[index]) {
      out.push(lines[index])
      index += 1
      continue
    }
    // One marker for the whole table, no matter how many rows it had.
    while (index < lines.length && drop[index]) index += 1
    out.push('', blockKeep(BLOCK_MARKERS.table), '')
  }
  return out.join('\n')
}

export function stripMarkdown(markdown) {
  let text = String(markdown || '').replace(/\r\n?/g, '\n')
  // Block stand-ins are stashed with their own token: they must survive the
  // inline cleanup below and come back as standalone paragraphs.
  const blocks = []
  const blockKeep = (marker) => '\u0001' + (blocks.push(marker) - 1) + '\u0001'
  // Fenced code (including ```mermaid diagrams) is not read aloud; it is
  // announced with the matching marker instead.
  text = text.replace(/^[ \t]*(```|~~~)([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm, (_full, _fence, info, body) => {
    const language = String(info || '').trim().split(/\s+/)[0].toLowerCase()
    return blockKeep(language === 'mermaid' ? mermaidMarker(body) : BLOCK_MARKERS.code)
  })
  // Inline code is short and often a word of the sentence, so it stays verbatim.
  const stash = []
  const keep = (value) => '\u0000' + (stash.push(value) - 1) + '\u0000'
  text = text.replace(/`([^`\n]+)`/g, (_, body) => keep(body))
  // Display math is not speech; inline $...$ stays, it may just be a price.
  text = text.replace(/\$\$[\s\S]*?\$\$/g, () => blockKeep(BLOCK_MARKERS.math))
  text = text.replace(/\\\[[\s\S]*?\\\]/g, () => blockKeep(BLOCK_MARKERS.math))
  // Footnote definitions disappear; the markers left in the prose go too.
  text = text.replace(/^[ \t]*\[\^[^\]]+\]:[^\n]*$/gm, '')
  text = text.replace(/\[\^[^\]]+\]/g, '')
  // Unescape markdown escapes before the markers themselves are stripped.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
  // Images render as pictures, so the alt text is not spoken; say a picture is
  // there and move on.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, () => blockKeep(BLOCK_MARKERS.image))
  // Links speak their label only.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // HTML: keep the words, drop the tags.
  text = text.replace(/<\/?[a-zA-Z][^>\n]*>/g, '')
  // Block markers at the start of a line.
  text = text.replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  text = text.replace(/^[ \t]*\d{1,3}[.)][ \t]+/gm, '')
  text = text.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')
  // Tables go before the pipe cleanup, or their cells become words.
  text = replaceTables(text, blockKeep)
  // Any remaining mid-line pipes become spaces.
  text = text.replace(/^[ \t]*\|/gm, ' ').replace(/\|[ \t]*$/gm, ' ').replace(/\|/g, ' ')
  // Emphasis: only paired markers that do not sit inside a word, so snake_case
  // identifiers survive.
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
  text = text.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
  text = text.replace(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, '$1')
  text = text.replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1')
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[index])
  // Give every marker its own paragraph, so it becomes its own speech unit.
  text = text.replace(/\u0001(\d+)\u0001/g, (_, index) => '\n\n' + blocks[Number(index)] + '\n\n')
  return text
}

/** Split text into speakable paragraphs; blank lines are the paragraph breaks. */
export function toParagraphs(text) {
  return stripMarkdown(text)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
}

/** Best break point for a paragraph longer than one request may hold. */
function findBreak(text, limit) {
  const window = text.slice(0, limit)
  let cut = -1
  const sentence = /[。！？!?；;…][”"』」）)]?\s*/g
  let match
  while ((match = sentence.exec(window))) cut = match.index + match[0].length
  if (cut > limit * 0.3) return cut
  const comma = Math.max(window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf(' '))
  return comma > limit * 0.3 ? comma + 1 : -1
}

/**
 * One synthesis request per unit. Paragraphs are the unit boundary; a paragraph
 * that is still too long is cut at sentence ends, then hard at the limit.
 */
export function planUnits(text, limit, splitScript = false) {
  const units = []
  let truncated = false
  const pushUnit = (piece) => {
    if (!piece) return
    // A mixed paragraph becomes one unit per script run, so a Chinese Piper
    // voice is never asked to read English (and vice versa).
    if (splitScript) {
      for (const run of splitByScript(piece)) units.push(run)
    } else {
      units.push(piece)
    }
  }
  for (const paragraph of toParagraphs(text)) {
    let rest = paragraph
    while (rest.length > limit) {
      const cut = findBreak(rest, limit)
      if (cut <= 0) {
        pushUnit(rest.slice(0, limit))
        rest = rest.slice(limit).trim()
        truncated = true
        continue
      }
      pushUnit(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    pushUnit(rest)
  }
  return { units: units.filter((unit) => unit.length > 0), truncated }
}

/** Whitespace and copy artefacts collapsed, so a DOM selection can be matched. */
export function normalizeForMatch(value) {
  return String(value || '')
    // Bullets and list glyphs the page may put into a copied selection.
    .replace(/[\u2022\u25e6\u25cf\u00b7]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The paragraphs a selection sits in. The cache key is a whole paragraph, so a
 * selection of a few words has to widen to its paragraph (or the run of
 * paragraphs it spans) before synthesis, or it could never be reused.
 */
export function locateParagraphs(units, selection) {
  const needle = normalizeForMatch(selection)
  if (!needle || units.length === 0) return null
  const haystack = units.map(normalizeForMatch)
  if (needle.length < 6) {
    if (needle.length < 3) return null
    const index = haystack.findIndex((unit) => unit.includes(needle))
    return index === -1 ? null : [units[index]]
  }
  // A selection crossing a paragraph break is not contained in any single unit,
  // so anchor on the longest prefix (and suffix) that still fits inside one.
  const anchor = (pick, from) => {
    let best = -1
    let lo = 6
    let hi = Math.min(needle.length, 240)
    while (lo <= hi) {
      const size = (lo + hi) >> 1
      // Trim: a probe that ends on a paragraph break carries a stray space.
      const probe = pick(needle, size).trim()
      const index = haystack.findIndex((unit, at) => at >= from && unit.includes(probe))
      if (index === -1) hi = size - 1
      else { best = index; lo = size + 1 }
    }
    return best
  }
  const start = anchor((value, size) => value.slice(0, size), 0)
  if (start === -1) return null
  const tail = anchor((value, size) => value.slice(value.length - size), start)
  return units.slice(start, tail >= start ? tail + 1 : start + 1)
}

/** 240 ms of silence between paragraphs, so the join does not sound cut off. */
export const PARAGRAPH_GAP_MS = 240
export function silenceBytes(ms = PARAGRAPH_GAP_MS) {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2)
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

// ---------------------------------------------------------------- local engine

/** Sample rate declared by a Piper voice config (`<model>.onnx.json`). */
export function piperSampleRate(modelPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(String(modelPath) + '.json', 'utf8'))
    const rate = parsed && parsed.audio ? Number(parsed.audio.sample_rate) : NaN
    if (Number.isFinite(rate) && rate >= 8000 && rate <= 96000) return rate
  } catch {}
  return 22050
}

/**
 * Streaming linear resampler. Piper voices are 16–24 kHz while the page, the
 * WSOLA stretcher and the cache all assume 24 kHz, so the bytes are rescaled
 * here instead of teaching the browser a second rate.
 */
export function createResampler(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0 || from === to) {
    return { push: (buffer) => buffer, flush: () => Buffer.alloc(0) }
  }
  const step = from / to
  let pool = new Int16Array(0)
  let pos = 0
  let odd = null
  return {
    push(buffer) {
      const bytes = odd ? Buffer.concat([odd, buffer]) : buffer
      const usable = bytes.length - (bytes.length % 2)
      odd = usable === bytes.length ? null : Buffer.from(bytes.subarray(usable))
      const incoming = new Int16Array(usable / 2)
      for (let i = 0; i < incoming.length; i += 1) incoming[i] = bytes.readInt16LE(i * 2)
      const merged = new Int16Array(pool.length + incoming.length)
      merged.set(pool, 0)
      merged.set(incoming, pool.length)
      pool = merged
      const out = []
      while (pos + 1 < pool.length) {
        const index = Math.floor(pos)
        const frac = pos - index
        const left = pool[index]
        out.push(Math.round(left + (pool[index + 1] - left) * frac))
        pos += step
      }
      const drop = Math.floor(pos)
      if (drop > 0) { pool = pool.slice(drop); pos -= drop }
      const samples = Int16Array.from(out)
      return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    },
    flush() {
      odd = null
      pool = new Int16Array(0)
      pos = 0
      return Buffer.alloc(0)
    },
  }
}

/** Every voice next to the configured one, so the settings page can offer a list. */
export function scanVoices(modelPath) {
  try {
    const dir = path.dirname(String(modelPath))
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.onnx'))
      .map((name) => {
        const file = path.join(dir, name)
        return { name: name.slice(0, -5), path: file, sampleRate: piperSampleRate(file) }
      })
      .filter((voice) => fs.existsSync(voice.path + '.json'))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** What the settings page needs to know about every engine. */
export function engineInfo(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const exe = typeof source.piperPath === 'string' ? source.piperPath : ''
  const model = typeof source.piperModel === 'string' ? source.piperModel : ''
  const modelEn = typeof source.piperModelEn === 'string' ? source.piperModelEn : ''
  const voices = model ? scanVoices(model) : []
  const systemList = systemSupported() ? systemVoices() : []
  return {
    platform: process.platform,
    piper: {
      exe: exe ? fs.existsSync(exe) : false,
      model: model ? fs.existsSync(model) : false,
      modelEn: modelEn ? fs.existsSync(modelEn) : false,
      sampleRate: model && fs.existsSync(model) ? piperSampleRate(model) : 0,
      voices,
    },
    system: {
      supported: systemSupported(),
      voices: systemList,
    },
    custom: {
      protocol: CUSTOM_PROTOCOLS.has(String(source.customProtocol)) ? String(source.customProtocol) : 'openai',
      baseUrl: typeof source.customBaseUrl === 'string' ? source.customBaseUrl : '',
      endpoint: speechEndpoint(source.customBaseUrl),
      effectiveUrl: buildCustomRequest(source, 'x', '').url,
      requiresKey: !isLoopbackUrl(buildCustomRequest(source, 'x', '').url),
      model: typeof source.customModel === 'string' ? source.customModel : '',
      voice: typeof source.customVoice === 'string' ? source.customVoice : '',
      format: source.customFormat === 'pcm' ? 'pcm' : 'wav',
      keyConfigured: customApiKey().length > 0,
      lang: SOVITS_LANGS.has(String(source.sovitsTextLang)) ? String(source.sovitsTextLang) : 'zh',
      promptLang: SOVITS_LANGS.has(String(source.sovitsPromptLang)) ? String(source.sovitsPromptLang) : 'zh',
      refAudio: typeof source.sovitsRefAudio === 'string' ? source.sovitsRefAudio : '',
      ready: (() => {
        const url = buildCustomRequest(source, 'x', '').url
        const protocol = CUSTOM_PROTOCOLS.has(String(source.customProtocol)) ? String(source.customProtocol) : 'openai'
        const needsKey = !isLoopbackUrl(url)
        const keyOk = !needsKey || customApiKey().length > 0
        const refOk = protocol !== 'gpt-sovits' || Boolean(String(source.sovitsRefAudio || '').trim())
        return Boolean(url) && keyOk && refOk
      })(),
    },
  }
}

/** Longest silence the local engine is allowed to keep, in ms. */
export const PIPER_PAUSE_CAP_MS = 140

/**
 * Piper's Chinese voice leaves 200–400 ms of dead air inside sentences, which
 * reads as broken phrasing. Squash every silent run to the cap; speech is
 * untouched and the cache stores exactly what was played.
 */
export function createSilenceSquasher(rate = SAMPLE_RATE, capMs = PIPER_PAUSE_CAP_MS, threshold = 0.02) {
  const frameSize = Math.max(1, Math.round(rate * 0.01))
  const frameBytes = frameSize * 2
  const capFrames = Math.max(1, Math.round(capMs / 10))
  let pending = Buffer.alloc(0)
  let silent = 0
  let peak = 0
  return {
    push(buffer) {
      const merged = pending.length ? Buffer.concat([pending, buffer]) : buffer
      const whole = Math.floor((merged.length >> 1) / frameSize) * frameBytes
      const out = []
      for (let offset = 0; offset + frameBytes <= whole; offset += frameBytes) {
        const frame = merged.subarray(offset, offset + frameBytes)
        let sum = 0
        for (let i = 0; i < frameSize; i += 1) {
          const value = frame.readInt16LE(i * 2) / 32768
          sum += value * value
        }
        const rms = Math.sqrt(sum / frameSize)
        if (rms > peak) peak = rms
        // Relative floor, with an absolute minimum so leading silence counts too.
        if (rms < Math.max(0.006, peak * threshold)) { silent += 1; continue }
        if (silent > 0) {
          out.push(Buffer.alloc(Math.min(silent, capFrames) * frameBytes))
          silent = 0
        }
        out.push(Buffer.from(frame))
      }
      pending = Buffer.from(merged.subarray(whole))
      return Buffer.concat(out)
    },
    flush() {
      const silence = Buffer.alloc(Math.min(silent, capFrames) * frameBytes)
      silent = 0
      const rest = pending
      pending = Buffer.alloc(0)
      return Buffer.concat([silence, rest])
    },
  }
}

function engineError(message, code) {
  const error = new Error(message)
  error.code = code
  error.status = 502
  return error
}

// The C++ builds use `--output_raw`, the newer Python CLI `--output-raw`; try
// both, then remember which one this install accepted.
const PIPER_FLAGS = ['--output-raw', '--output_raw']
let piperFlagUsed = ''

async function* startPiper(settings, flag, text, signal, model) {
  // The Python CLI decodes stdin with the locale codec; force UTF-8 so Chinese
  // text does not arrive as lone surrogates. It also looks for its g2pW resources
  // in `cwd/g2pW`, so the model folder is the working directory. HF_ENDPOINT is
  // only filled in when the user has none, so a mirror can serve the tokenizer.
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  if (!env.HF_ENDPOINT) env.HF_ENDPOINT = 'https://hf-mirror.com'
  // Models are local files, so the hub is only consulted for the Chinese
  // tokenizer; staying offline avoids a 40 s retry storm when that is missing.
  if (!env.HF_HUB_OFFLINE) env.HF_HUB_OFFLINE = '1'
  if (!env.TRANSFORMERS_OFFLINE) env.TRANSFORMERS_OFFLINE = '1'
  const cwd = model ? path.dirname(model) : undefined
  const child = spawn(settings.piperPath, ['--model', model, flag], { windowsHide: true, env, cwd })
  let stderr = ''
  let spawnError = null
  const exited = new Promise((resolve) => {
    child.once('close', (code) => resolve(code ?? 0))
    child.once('error', () => resolve(0))
  })
  child.on('error', (error) => { spawnError = error })
  child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString() })
  // Killing the child while its pipes are live surfaces as EPIPE / 'close' on
  // these streams; an unhandled 'error' event is an uncaught exception, and the
  // Host dies with it. Playback being stopped mid-sentence is normal, not fatal.
  child.stdin.on('error', () => {})
  child.stderr.on('error', () => {})
  child.stdout.on('error', () => {})
  const abort = () => { try { child.kill() } catch {} }
  if (signal) signal.addEventListener('abort', abort, { once: true })
  try { child.stdin.end(text + '\n') } catch {}
  try {
    for await (const chunk of child.stdout) {
      if (signal && signal.aborted) break
      yield chunk
    }
  } finally {
    if (signal) signal.removeEventListener('abort', abort)
  }
  const code = await exited
  if (spawnError) throw engineError('无法启动 piper：' + (spawnError.message || String(spawnError)), 'NO_ENGINE')
  if (code !== 0) throw engineError('piper 退出码 ' + code + (stderr.trim() ? '：' + stderr.trim().slice(0, 300) : ''), 'TTS_FAILED')
}

/**
 * Which Piper model reads one speech unit. A Chinese voice turns English into
 * nonsense syllables, but an English voice cannot read Chinese at all, so the
 * split happens per unit: units without any CJK go to the English model, every
 * other unit keeps the Chinese one.
 */
export function piperModelFor(settings, text) {
  const zhModel = settings && typeof settings.piperModel === 'string' ? settings.piperModel.trim() : ''
  const enModel = settings && typeof settings.piperModelEn === 'string' ? settings.piperModelEn.trim() : ''
  if (!enModel) return zhModel
  const source = String(text || '')
  let latin = 0
  let cjk = 0
  for (const char of source) {
    if (/[A-Za-z]/.test(char)) latin += 1
    else if (/[\u3400-\u9fff]/.test(char)) cjk += 1
  }
  if (latin === 0 || cjk > 0) return zhModel
  return enModel
}

/** Characters that belong to the Latin half of a mixed paragraph. */
function isLatinChar(char) {
  return /[A-Za-z]/.test(char)
}

/** Characters that belong to the Chinese half of a mixed paragraph. */
function isCjkChar(char) {
  return /[\u3400-\u9fff]/.test(char)
}

/**
 * Split one paragraph into script runs, so a Chinese voice never has to read
 * English and the English voice never has to read Chinese. Runs shorter than
 * two characters (stray punctuation, a single letter) stay with their neighbour:
 * each run costs one Piper process.
 */
export function splitByScript(text) {
  const source = String(text || '')
  if (!source) return []
  const runs = []
  let current = ''
  let script = '' // 'latin' | 'cjk' | ''
  const flush = () => {
    if (current) runs.push(current)
    current = ''
    script = ''
  }
  for (const char of source) {
    const next = isLatinChar(char) ? 'latin' : isCjkChar(char) ? 'cjk' : ''
    if (!next) {
      // Digits, spaces and punctuation belong to whatever run is open.
      current += char
      continue
    }
    if (script && script !== next) flush()
    current += char
    script = next
  }
  flush()

  const classOf = (run) => {
    for (const char of run) {
      if (isCjkChar(char)) return 'cjk'
      if (isLatinChar(char)) return 'latin'
    }
    return 'neutral'
  }
  // Fold fragments into a neighbour so short words do not spawn processes...
  const folded = []
  for (const run of runs) {
    const letters = (run.match(/[A-Za-z\u3400-\u9fff]/g) || []).length
    if (folded.length === 0 || letters >= 2 || classOf(run) === 'neutral') folded.push(run)
    else folded[folded.length - 1] += run
  }
  // ...then merge neighbours of the same class, which folding can create ("用 a "
  // followed by "标记" is still one Chinese run).
  const combined = []
  for (const run of folded) {
    const last = combined.length - 1
    if (last >= 0 && classOf(combined[last]) === classOf(run)) combined[last] += run
    else combined.push(run)
  }
  return combined
}

async function* piperChunks(settings, text, model, signal) {
  if (!settings.piperPath) throw engineError('本地引擎未配置：请先填写 piper 程序路径', 'NO_ENGINE')
  if (!fs.existsSync(settings.piperPath)) throw engineError('找不到 piper 程序：' + settings.piperPath, 'NO_ENGINE')
  if (!model) throw engineError('本地引擎未配置：请先填写模型路径', 'NO_ENGINE')
  if (!fs.existsSync(model)) throw engineError('找不到 piper 模型：' + model, 'NO_ENGINE')
  let failure = null
  const flags = piperFlagUsed ? [piperFlagUsed, ...PIPER_FLAGS.filter((flag) => flag !== piperFlagUsed)] : PIPER_FLAGS
  for (const flag of flags) {
    let produced = false
    try {
      for await (const chunk of startPiper(settings, flag, text, signal, model)) {
        if (chunk.length) produced = true
        yield chunk
      }
      piperFlagUsed = flag
      return
    } catch (error) {
      if (produced || (signal && signal.aborted)) throw error
      failure = error
    }
  }
  throw failure || engineError('piper 没有输出音频', 'TTS_FAILED')
}

/** Read a RIFF/WAVE buffer into its format and PCM body; null when it is not WAV. */
export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let format = null
  let pcm = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        encoding: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      pcm = buffer.subarray(body, Math.min(body + size, buffer.length))
    }
    offset = body + size + (size % 2)
  }
  if (!format || !pcm || pcm.length === 0) return null
  // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE, which SAPI and Windows voices use.
  if (format.encoding !== 1 && format.encoding !== 0xFFFE) return null
  if (format.bits !== 16) return null
  return { sampleRate: format.sampleRate, channels: format.channels, bits: format.bits, pcm }
}

/** Down-mix 16-bit PCM to mono by averaging the channels. */
export function toMono16(pcm, channels) {
  if (!channels || channels <= 1) return pcm
  const frames = Math.floor(pcm.length / (2 * channels))
  const out = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += pcm.readInt16LE((frame * channels + channel) * 2)
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), frame * 2)
  }
  return out
}

// ---------------------------------------------------------------- OS voices

/** Run a command to completion, collecting its output; resolves, never rejects. */
function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000
    const signal = options.signal
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      try { child.kill() } catch {}
      finish({ code: -1, stdout, stderr: 'aborted' })
    }
    let child
    try {
      child = spawn(file, args, { windowsHide: true, env: options.env || process.env })
    } catch (error) {
      finish({ code: -1, stdout: Buffer.alloc(0), stderr: String(error && error.message) })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: -1, stdout, stderr: stderr || String(error && error.message) })
    })
    child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]) })
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code: code ?? 0, stdout, stderr })
    })
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try { child.stdin.end(options.input === undefined ? '' : String(options.input), 'utf8') } catch {}
  })
}

/** The voice list of the running OS, cached: enumerating it spawns a process. */
let systemVoiceCache = { at: 0, voices: [] }

export function systemVoices(refresh = false) {
  if (!refresh && systemVoiceCache.voices.length > 0 && Date.now() - systemVoiceCache.at < 300000) {
    return systemVoiceCache.voices
  }
  const voices = listPlatformVoices()
  systemVoiceCache = { at: Date.now(), voices }
  return voices
}

export function systemSupported() {
  return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
}

function listPlatformVoices() {
  try {
    if (process.platform === 'win32') return listWindowsVoices()
    if (process.platform === 'darwin') return listDarwinVoices()
    if (process.platform === 'linux') return listLinuxVoices()
  } catch {}
  return []
}

function listWindowsVoices() {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$s.GetInstalledVoices() | ForEach-Object { $i = $_.VoiceInfo; '{0}|{1}|{2}' -f $i.Name, $i.Culture.Name, $i.Gender }",
    '$s.Dispose()',
  ].join('; ')
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    return output.split(/\r?\n/).map((line) => {
      const [name, language, gender] = line.split('|').map((part) => (part || '').trim())
      if (!name) return null
      return { id: name, name, language: language || '', gender: gender || '' }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function listDarwinVoices() {
  const output = syncCommand('say', ['-v', '?'], 20000)
  return output.split(/\r?\n/).map((line) => {
    const trimmed = line.split('#')[0].trim()
    const match = /^(.*?)\s+([a-z]{2,3}[-_][A-Za-z0-9]+)$/.exec(trimmed)
    if (!match) return null
    const name = match[1].trim()
    return { id: name, name, language: match[2].replace('_', '-'), gender: '' }
  }).filter(Boolean)
}

function listLinuxVoices() {
  const output = syncCommand('espeak-ng', ['--voices'], 20000)
  return output.split(/\r?\n/).slice(1).map((line) => {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) return null
    const language = parts[1]
    const voiceName = parts[3]
    return { id: language, name: voiceName + ' (' + language + ')', language, gender: parts[2] || '' }
  }).filter(Boolean)
}

function syncCommand(file, args, timeoutMs) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  } catch {
    return ''
  }
}

// ------------------------------------------------------------ system engine

const SYSTEM_TEMP_PREFIX = 'dsh-tts-'

function tempPath(suffix) {
  return path.join(os.tmpdir(), SYSTEM_TEMP_PREFIX + process.pid + '-' + crypto.randomBytes(6).toString('hex') + suffix)
}

/** 16-bit PCM + rate from the OS voice, via a temp WAV the platform wrote. */
async function synthesizeSystem(voice, text, signal) {
  const wavFile = tempPath('.wav')
  const txtFile = tempPath('.txt')
  try {
    let child
    if (process.platform === 'win32') {
      fs.writeFileSync(txtFile, text, 'utf8')
      const script = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        "$s.SelectVoice('" + String(voice.id).replace(/'/g, "''") + "')",
        "$s.SetOutputToWaveFile('" + wavFile.replace(/'/g, "''") + "')",
        "$s.Speak([IO.File]::ReadAllText('" + txtFile.replace(/'/g, "''") + "', [Text.Encoding]::UTF8))",
        '$s.Dispose()',
      ].join('; ')
      child = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 60000, signal })
    } else if (process.platform === 'darwin') {
      child = await runProcess('say', ['-v', voice.id, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', wavFile], { input: text, timeoutMs: 60000, signal })
    } else {
      child = await runProcess('espeak-ng', ['-v', voice.id, '--stdin', '-w', wavFile], { input: text, timeoutMs: 60000, signal })
    }
    if (signal && signal.aborted) throw engineError('已停止', 'ABORTED')
    if (child.code !== 0) {
      throw engineError('系统语音合成失败（退出码 ' + child.code + '）' + (child.stderr ? '：' + child.stderr.slice(0, 300) : ''), 'TTS_FAILED')
    }
    let buffer
    try { buffer = fs.readFileSync(wavFile) } catch { buffer = null }
    const wav = buffer ? parseWav(buffer) : null
    if (!wav) throw engineError('系统语音没有返回可用的 WAV（16-bit PCM）', 'EMPTY_AUDIO')
    return { sampleRate: wav.sampleRate, pcm: toMono16(wav.pcm, wav.channels) }
  } finally {
    try { fs.unlinkSync(wavFile) } catch {}
    try { fs.unlinkSync(txtFile) } catch {}
  }
}

async function* systemChunks(settings, text, signal) {
  if (!systemSupported()) throw engineError('当前系统没有可用的系统语音（仅支持 Windows / macOS / Linux）', 'NO_ENGINE')
  const voices = systemVoices()
  if (voices.length === 0) throw engineError('没有找到系统语音：请在系统设置里安装一个语音包', 'NO_ENGINE')
  const voice = voices.find((item) => item.id === settings.systemVoice) || voices[0]
  const { sampleRate, pcm } = await synthesizeSystem(voice, text, signal)
  const resampler = createResampler(sampleRate, SAMPLE_RATE)
  const converted = resampler.push(pcm)
  if (converted.length) yield converted
  const tail = resampler.flush()
  if (tail.length) yield tail
}

// ------------------------------------------------------------- custom engine

async function* customChunks(settings, text, signal) {
  const key = customApiKey()
  const request = buildCustomRequest(settings, text, key)
  if (!request.url) {
    throw engineError('自定义 API 未配置：请填写 Base URL（例如 https://api.openai.com/v1）', 'NO_ENGINE')
  }
  // A service on this machine is trusted without a key; anything else is not.
  if (!key && !isLoopbackUrl(request.url)) {
    throw engineError('自定义 API 缺少 Key：请在设置里填写并保存', 'NO_KEY')
  }
  const options = {
    method: request.method,
    headers: request.headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
  }
  if (request.body !== undefined) options.body = request.body
  let response
  try {
    response = await fetch(request.url, options)
  } catch (error) {
    if (signal && signal.aborted) throw engineError('已停止', 'ABORTED')
    throw engineError('自定义 API 请求失败：' + (error && error.message ? error.message : String(error)), 'TTS_FAILED')
  }
  if (!response.ok) {
    let detail = ''
    try { detail = await response.text() } catch {}
    let message = detail.slice(0, 300)
    try {
      const parsed = JSON.parse(detail)
      message = (parsed && parsed.error && parsed.error.message) || parsed.message || message
    } catch {}
    throw engineError('自定义 API 返回 HTTP ' + response.status + (message ? '：' + message : ''), 'TTS_FAILED')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw engineError('自定义 API 没有返回音频', 'EMPTY_AUDIO')
  const audioType = CUSTOM_AUDIO_TYPES.has(String(request.audioType)) ? String(request.audioType) : 'auto'
  const wav = audioType === 'pcm' ? null : parseWav(buffer)
  if (audioType === 'wav' && !wav) {
    throw engineError('该协议约定返回 WAV，但响应不是 16-bit PCM WAV', 'UNSUPPORTED_AUDIO')
  }
  if (wav) {
    const pcm = toMono16(wav.pcm, wav.channels)
    const resampler = createResampler(wav.sampleRate, SAMPLE_RATE)
    const converted = resampler.push(pcm)
    if (converted.length) yield converted
    const tail = resampler.flush()
    if (tail.length) yield tail
    return
  }
  // mp3/opus and friends cannot be decoded here; say so instead of playing noise.
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    throw engineError('自定义 API 返回的是 MP3，请让服务端返回 wav 或 pcm', 'UNSUPPORTED_AUDIO')
  }
  if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
    throw engineError('自定义 API 返回的是 MP3/ADTS 音频，请让服务端返回 wav 或 pcm', 'UNSUPPORTED_AUDIO')
  }
  // Raw PCM: OpenAI's `pcm` format is mono 24 kHz 16-bit little-endian already.
  yield buffer
}

/** Indices of the located units, in order; duplicate paragraphs match forward. */
function indicesOf(units, wanted) {
  const indices = []
  let cursor = 0
  for (const text of wanted) {
    for (let index = cursor; index < units.length; index += 1) {
      if (units[index] === text) {
        indices.push(index)
        cursor = index + 1
        break
      }
    }
  }
  return indices
}

/**
 * Reading a session is by far the most expensive local step (a long session can
 * take seconds), and every paragraph request used to pay it again. The resolved
 * message text is cached until the message changes.
 */
const messageTextCache = new Map()
const MESSAGE_TEXT_TTL_MS = 300000
const MESSAGE_TEXT_MAX = 64

async function readMessageTextCached(sessionQuery, sessionId, messageId) {
  const key = String(sessionId) + '\u0000' + String(messageId)
  const cached = messageTextCache.get(key)
  if (cached && Date.now() - cached.at < MESSAGE_TEXT_TTL_MS) return cached.text
  const text = await readMessageText(sessionQuery, sessionId, messageId)
  messageTextCache.set(key, { text, at: Date.now() })
  while (messageTextCache.size > MESSAGE_TEXT_MAX) {
    const oldest = messageTextCache.keys().next().value
    messageTextCache.delete(oldest)
  }
  return text
}

function forgetMessageText(sessionId, messageId) {
  messageTextCache.delete(String(sessionId) + '\u0000' + String(messageId))
}

/**
 * The paragraphs that make up one read: the message's own units, or the ones a
 * selection covers. Both /plan and /read go through this, so the `unit` index a
 * client sends always addresses the same list on both sides.
 */
async function resolveUnits(scope, settings, sessionId, messageId, explicitText) {
  let messageText = ''
  let sessionError = null
  if (sessionId && messageId) {
    try {
      messageText = await readMessageTextCached(scope.sessionQuery, sessionId, messageId)
    } catch (error) {
      sessionError = error
    }
  }
  if (!messageText && !explicitText) {
    if (sessionError) {
      const error = new Error('读取会话失败：' + (sessionError?.message ?? String(sessionError)))
      error.code = 'SESSION_READ_FAILED'
      error.status = 500
      throw error
    }
    const error = new Error('这条消息没有可朗读的文字（代码块、表格、公式会被跳过）')
    error.code = 'NO_TEXT'
    error.status = 404
    throw error
  }
  const splitScript = settings.engine === 'piper' && !!settings.piperModelEn
  const whole = messageText ? planUnits(messageText, settings.maxChars, splitScript) : { units: [], truncated: false }
  let items = whole.units.map((text, index) => ({ index, text, chars: text.length }))
  let truncated = whole.truncated
  let standalone = false
  if (explicitText) {
    const covering = locateParagraphs(whole.units, explicitText)
    if (covering && covering.length > 0) {
      items = indicesOf(whole.units, covering).map((index) => ({
        index,
        text: whole.units[index],
        chars: whole.units[index].length,
      }))
      truncated = false
    } else {
      // Not part of the message text (a code block, say): the selection itself.
      const own = planUnits(explicitText, settings.maxChars, splitScript)
      items = own.units.map((text, index) => ({ index, text, chars: text.length }))
      truncated = own.truncated
      standalone = true
    }
  }
  return { items, truncated, standalone }
}

/** 24 kHz mono PCM for one paragraph, from whichever engine is configured. */
export async function* engineChunks(scope, settings, text, signal) {
  // Browser speech happens in the page; the Host has no audio to give. Without
  // this the call would fall through to the DeepSeek branch.
  if (settings.engine === 'browser') {
    throw engineError('「浏览器朗读」由页面自己合成，Host 不提供音频', 'NO_ENGINE')
  }
  if (settings.engine === 'piper') {
    const model = piperModelFor(settings, text)
    const resampler = createResampler(piperSampleRate(model), SAMPLE_RATE)
    const squasher = createSilenceSquasher()
    for await (const chunk of piperChunks(settings, text, model, signal)) {
      const pcm = squasher.push(resampler.push(chunk))
      if (pcm.length) yield pcm
    }
    const tail = squasher.push(resampler.flush())
    if (tail.length) yield tail
    const end = squasher.flush()
    if (end.length) yield end
    return
  }
  if (settings.engine === 'system') {
    for await (const chunk of systemChunks(settings, text, signal)) yield chunk
    return
  }
  if (settings.engine === 'custom') {
    for await (const chunk of customChunks(settings, text, signal)) yield chunk
    return
  }
  const upstream = await openTtsStream(scope, text, settings.voice, signal)
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  }
}

/** Raw PCM response headers; the browser converts Int16 → Float32 itself. */
function pcmHeaders(extra) {
  return {
    'content-type': 'application/octet-stream',
    // `no-transform` keeps the Host's gzip middleware away from raw audio: it
    // gains nothing on PCM, and wrapping a long stream in a transform makes the
    // response's backpressure proxy pile up drain listeners on the Gzip stream.
    'cache-control': 'no-store, no-transform',
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
  const stored = readStoredSettings()
  // The patch config seeds the first run only; afterwards the file is authoritative.
  if (Object.keys(stored).length === 0) writeSettings(normalizeSettings(stored, seed))

  // Live feed for auto-read: one SSE line per assistant message.
  const listeners = new Set()
  // Feed diagnostics, surfaced on /config so a silent disconnect is visible.
  const sseStats = { opened: 0, closed: 0, rejected: 0 }
  // Bounded ring behind GET /recent: the page polls it as a fallback, so
  // auto-read keeps working when its EventSource is down.
  let recentSeq = 0
  const recent = []
  const noteAssistant = (sessionId, messageId, final) => {
    recentSeq += 1
    recent.push({ seq: recentSeq, sessionId, messageId, final })
    while (recent.length > 64) recent.shift()
    broadcast({ type: 'assistant', sessionId, messageId, final })
  }
  // The request the page may replay: a pending question or approval. Exposed by
  // GET /pending so the replay button does not depend on the event stream.
  let pendingPrompt = null
  // sessionId -> the turn's latest assistant message id, published on turn close.
  const lastAssistant = new Map()
  const broadcast = (payload) => {
    const line = 'data: ' + JSON.stringify(payload) + '\n\n'
    for (const response of listeners) {
      // A page that went away leaves its response behind; writing to it throws
      // (or on a wrapped stream rejects), so drop it here instead.
      if (response.destroyed || response.writableEnded) {
        if (listeners.delete(response)) sseStats.closed += 1
        continue
      }
      try { response.write(line) } catch {
        if (listeners.delete(response)) sseStats.closed += 1
      }
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
      // This message just changed, so the cached text for it is stale.
      forgetMessageText(sessionId, messageId)
      noteAssistant(sessionId, messageId, false)
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
      noteAssistant(sessionId, messageId, true)
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
      handler: routeHandler(log, async (request, response) => {
        if (!guard(request, response)) return
        const method = request.method ?? 'GET'
        if (method === 'GET') {
          const current = readSettings()
          let keyConfigured = false
          try {
            const info = await scope.credentials.describe(KEY_REF)
            keyConfigured = !!(info && info.configured)
          } catch {}
          return writeJson(response, 200, { ok: true, value: { ...current, ...engineInfo(current), voices: [...VOICES], cache: cacheStats(), keyConfigured, sseClients: listeners.size, sse: { ...sseStats, clients: listeners.size, recentSeq } } })
        }
        if (method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object') return writeJson(response, 400, { ok: false, code: 'BAD_BODY', error: '请求体不是 JSON' })
        const current = readSettings()
        // The custom endpoint's key is not a setting: it is written to
        // secrets.json and never read back out through this API.
        if (typeof body.customApiKey === 'string') {
          const secrets = { ...readSecrets() }
          const nextKey = body.customApiKey.trim()
          if (nextKey) secrets.customApiKey = nextKey
          else delete secrets.customApiKey
          writeSecrets(secrets)
        }
        const editable = [
          'engine', 'piperPath', 'piperModel', 'piperModelEn', 'systemVoice',
          'customBaseUrl', 'customModel', 'customVoice', 'customFormat', 'customProtocol',
          'sovitsRefAudio', 'sovitsPromptText', 'sovitsTextLang', 'sovitsPromptLang',
          'customMethod', 'customPath', 'customHeaders', 'customBody', 'customAudioType',
          'voice', 'maxChars', 'cacheMaxMb', 'cacheMode', 'speed', 'autoRead', 'autoReadInterim', 'speakQuestions', 'speakApprovals',
        ]
        const next = normalizeSettings({ ...current, ...pick(body, editable) }, null)
        if (body.clearCache === true) clearCache()
        if (!writeSettings(next)) return writeJson(response, 500, { ok: false, code: 'WRITE_FAILED', error: '写入设置失败' })
        pruneCache(next.cacheMaxMb * 1024 * 1024)
        let keyConfigured = false
        try {
          const info = await scope.credentials.describe(KEY_REF)
          keyConfigured = !!(info && info.configured)
        } catch {}
        return writeJson(response, 200, { ok: true, value: { ...next, ...engineInfo(next), voices: [...VOICES], cache: cacheStats(), keyConfigured } })
      }),
    }), 'dsh-tts-reader: config')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: CLEAR_PATH,
      handler: routeHandler(log, async (request, response) => {
        if (!guard(request, response)) return
        if ((request.method ?? '') !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const removed = clearCache()
        return writeJson(response, 200, { ok: true, value: { removed, cache: cacheStats() } })
      }),
    }), 'dsh-tts-reader: cache')

    // Auto-read feed: the page opens one EventSource and replays new replies.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: EVENTS_PATH,
      handler: routeHandler(log, (request, response) => {
        if (!guard(request, response)) { sseStats.rejected += 1; return }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        response.write(': connected\n\n')
        listeners.add(response)
        sseStats.opened += 1
        const heartbeat = setInterval(() => {
          if (response.destroyed || response.writableEnded) { cleanup(); return }
          try { response.write(': ping\n\n') } catch { cleanup() }
        }, 25000)
        const cleanup = () => {
          clearInterval(heartbeat)
          if (listeners.delete(response)) sseStats.closed += 1
        }
        request.on('close', cleanup)
        response.on('close', cleanup)
        response.on('error', cleanup)
      }),
    }), 'dsh-tts-reader: events')

    // Polling fallback for the same feed: `after=<seq>` returns what the page
    // has not seen yet, so auto-read survives a dead EventSource.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: RECENT_PATH,
      handler: routeHandler(log, (request, response) => {
        if (!guard(request, response)) return
        let after = 0
        try {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const raw = Number(url.searchParams.get('after'))
          if (Number.isFinite(raw) && raw > 0) after = Math.floor(raw)
        } catch {}
        return writeJson(response, 200, {
          ok: true,
          value: { seq: recentSeq, items: recent.filter(item => item.seq > after) },
        })
      }),
    }), 'dsh-tts-reader: recent')

    // The replay button reads this; it must not depend on a live event stream.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: PENDING_PATH,
      handler: routeHandler(log, (request, response) => {
        if (!guard(request, response)) return
        return writeJson(response, 200, { ok: true, value: pendingPrompt })
      }),
    }), 'dsh-tts-reader: pending')

    // ------------------------------------------------------------ 朗读桥
    // A desktop shell (Electron) has no Web Speech voices; a real browser does.
    // The bridge hands the paragraphs to the default browser: the page is served
    // from here, the text lives in memory for five minutes, and the URL carries
    // only a random id.
    const bridgeEntries = new Map()
    const BRIDGE_TTL_MS = 5 * 60 * 1000
    const BRIDGE_MAX = 8
    // Read on demand (with a short cache) instead of once at startup, so editing
    // the page does not require restarting the Host to see the change.
    let bridgeSourceCache = { text: '', at: 0 }
    const bridgeSource = () => {
      const now = Date.now()
      if (bridgeSourceCache.text && now - bridgeSourceCache.at < 5000) return bridgeSourceCache.text
      try {
        const text = fs.readFileSync(new URL('./bridge.html', import.meta.url), 'utf8')
        bridgeSourceCache = { text, at: now }
        return text
      } catch (error) {
        if (!bridgeSourceCache.text) {
          log?.warn?.('[dsh-tts-reader] 朗读桥页面缺失：' + (error?.message ?? String(error)))
        }
        return bridgeSourceCache.text
      }
    }

    const pruneBridges = () => {
      const now = Date.now()
      for (const [id, entry] of bridgeEntries) {
        if (now - entry.at > BRIDGE_TTL_MS) bridgeEntries.delete(id)
      }
      while (bridgeEntries.size > BRIDGE_MAX) bridgeEntries.delete(bridgeEntries.keys().next().value)
    }

    const addBridge = (payload) => {
      pruneBridges()
      const id = crypto.randomUUID()
      bridgeEntries.set(id, { at: Date.now(), title: payload.title, units: payload.units, speed: payload.speed })
      return id
    }

    const renderBridge = (entry) => {
      const payload = JSON.stringify({ title: entry.title, units: entry.units, speed: entry.speed }).replace(/</g, '\\u003c')
      return bridgeSource().replace('__BRIDGE_DATA__', payload)
    }

    // Pages currently listening for text. One long-lived bridge tab is the point:
    // the plugin pushes the next reply into it instead of opening a new tab.
    const bridgeClients = new Set()

    const deliverToBridge = (payload) => {
      if (bridgeClients.size === 0) return 0
      const line = 'data: ' + JSON.stringify({ type: 'read', ...payload }) + '\n\n'
      // Newest tab only: several listening pages would read the same text twice.
      const all = [...bridgeClients]
      for (let i = all.length - 1; i >= 0; i--) {
        const response = all[i]
        if (response.destroyed || response.writableEnded) { bridgeClients.delete(response); continue }
        try { response.write(line); return 1 } catch { bridgeClients.delete(response) }
      }
      return 0
    }

    /** Launch the OS default browser on a loopback URL. */
    const openExternal = (url) => {
      if (!url) return false
      const win32 = process.platform === 'win32'
      const command = win32 ? (process.env.ComSpec || 'cmd.exe') : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const args = win32 ? ['/c', 'start', '', url] : [url]
      try {
        const child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' })
        // A spawn failure arrives asynchronously; the URL is returned either way
        // so the page can still show it for a manual click.
        child.on('error', (error) => {
          log?.warn?.('[dsh-tts-reader] 唤起浏览器失败：' + (error?.message ?? String(error)))
        })
        child.unref()
        return true
      } catch (error) {
        log?.warn?.('[dsh-tts-reader] 唤起浏览器失败：' + (error?.message ?? String(error)))
        return false
      }
    }

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: BRIDGE_PATH,
      handler: routeHandler(log, async (request, response) => {
        if (!guard(request, response)) return
        const method = request.method ?? 'GET'
        if (method === 'GET') {
          let id = ''
          try { id = String(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '') } catch {}
          pruneBridges()
          const entry = bridgeEntries.get(id)
          if (!entry || !bridgeSource()) {
            response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            response.end('<!doctype html><meta charset="utf-8"><title>朗读桥</title>'
              + '<p style="font:14px system-ui;padding:24px">这个朗读链接已过期，请回到对话里重新点一次「在浏览器中朗读」。</p>')
            return
          }
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          response.end(renderBridge(entry))
          return
        }
        if (method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        if (!bridgeSource()) return writeJson(response, 500, { ok: false, code: 'NO_PAGE', error: '朗读桥页面缺失，请重装插件' })
        const body = await readJsonBody(request)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
        const explicitText = typeof body?.text === 'string' ? body.text.trim() : ''
        if (!explicitText && (!sessionId || !messageId)) {
          return writeJson(response, 400, { ok: false, code: 'BAD_REQUEST', error: '需要 sessionId 与 messageId（或直接给 text）' })
        }
        const current = readSettings()
        let plan
        try {
          plan = await resolveUnits(scope, current, sessionId, messageId, explicitText)
        } catch (error) {
          return writeJson(response, error.status || 500, { ok: false, code: error.code || 'FAILED', error: error.message })
        }
        if (plan.items.length === 0) {
          return writeJson(response, 404, { ok: false, code: 'NO_TEXT', error: '这条消息没有可朗读的文字（代码块、表格、公式会被跳过）' })
        }
        const units = plan.items.map((item, index) => ({ index, text: String(item.text ?? '') }))
        const first = units.length > 0 ? units[0].text.replace(/\s+/g, ' ').trim() : ''
        const title = first.length > 24 ? first.slice(0, 24) + '…' : first
        // The settings page speed travels with the text, so the bridge reads at
        // the same rate as the in-app player.
        const requestedSpeed = Number(body?.speed)
        const bridgeSpeed = Number.isFinite(requestedSpeed) && requestedSpeed > 0
          ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(requestedSpeed * 100) / 100))
          : current.speed
        const payload = { title, units, speed: bridgeSpeed }
        // A bridge tab that is still open — possibly from hours ago — gets the
        // text directly. Opening another tab every time would pile them up.
        const delivered = deliverToBridge(payload)
        if (delivered > 0) {
          return writeJson(response, 200, {
            ok: true,
            value: { delivered, launched: false, reclaimed: true, url: '', units: units.length },
          })
        }
        const id = addBridge(payload)
        const host = String(request.headers?.host ?? '')
        const link = /^[A-Za-z0-9.\-\[\]:]+$/.test(host) ? 'http://' + host + BRIDGE_PATH + '?id=' + id : ''
        return writeJson(response, 200, {
          ok: true,
          value: { url: link, launched: link ? openExternal(link) : false, delivered: 0, units: units.length },
        })
      }),
    }), 'dsh-tts-reader: bridge')

    // The bridge page keeps this open. While at least one listener is attached,
    // POST /bridge delivers the text over this stream instead of launching a tab.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: BRIDGE_STREAM_PATH,
      handler: routeHandler(log, (request, response) => {
        if (!guard(request, response)) return
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        response.write(': bridge connected\n\n')
        bridgeClients.add(response)
        const cleanup = () => {
          clearInterval(heartbeat)
          bridgeClients.delete(response)
        }
        const heartbeat = setInterval(() => {
          if (response.destroyed || response.writableEnded) { cleanup(); return }
          try { response.write(': ping\n\n') } catch { cleanup() }
        }, 25000)
        request.on('close', cleanup)
        response.on('close', cleanup)
        response.on('error', cleanup)
      }),
    }), 'dsh-tts-reader: bridge stream')

    // The floating player asks for the paragraph list first: it needs the count
    // and each paragraph's opening words, and `unit` on /read addresses this list.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: PLAN_PATH,
      handler: routeHandler(log, async (request, response) => {
        if (!guard(request, response)) return
        if ((request.method ?? '') !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
        const explicitText = typeof body?.text === 'string' ? body.text.trim() : ''
        if (!explicitText && (!sessionId || !messageId)) {
          return writeJson(response, 400, { ok: false, code: 'BAD_REQUEST', error: '需要 sessionId 与 messageId（或直接给 text）' })
        }
        const current = readSettings()
        let plan
        try {
          plan = await resolveUnits(scope, current, sessionId, messageId, explicitText)
        } catch (error) {
          return writeJson(response, error.status || 500, { ok: false, code: error.code || 'FAILED', error: error.message })
        }
        if (plan.items.length === 0) {
          return writeJson(response, 404, { ok: false, code: 'NO_TEXT', error: '这条消息没有可朗读的文字（代码块、表格、公式会被跳过）' })
        }
        return writeJson(response, 200, {
          ok: true,
          value: {
            units: plan.items,
            total: plan.items.length,
            truncated: plan.truncated,
            standalone: plan.standalone,
            engine: current.engine,
          },
        })
      }),
    }), 'dsh-tts-reader: plan')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: READ_PATH,
      handler: routeHandler(log, async (request, response) => {
        if (!guard(request, response)) return
        if ((request.method ?? '') !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
        // An explicit text wins: it carries a selected paragraph the page already
        // has, so the Host does not have to re-read the whole message.
        const explicitText = typeof body?.text === 'string' ? body.text.trim() : ''
        // The floating player sends the paragraph itself, which needs no session
        // read at all.
        const incomingUnitText = typeof body?.unitText === 'string' ? body.unitText.trim() : ''
        if (!explicitText && !incomingUnitText && (!sessionId || !messageId)) {
          return writeJson(response, 400, { ok: false, code: 'BAD_REQUEST', error: '需要 sessionId 与 messageId（或直接给 text）' })
        }

        const current = readSettings()

        // A unit request from the floating player carries the paragraph text it
        // already has, so no session read is needed before synthesizing it.
        const unitText = typeof body?.unitText === 'string' ? body.unitText.trim() : ''
        let served
        let unitIndex = -1
        let totalUnits = 0
        let truncated = false
        if (unitText) {
          if (unitText.length > HARD_MAX_CHARS * 2) {
            return writeJson(response, 400, { ok: false, code: 'TOO_LONG', error: '段落文本过长' })
          }
          const requestedUnit = Number(body?.unit)
          unitIndex = Number.isFinite(requestedUnit) && requestedUnit >= 0 ? Math.floor(requestedUnit) : 0
          const requestedTotal = Number(body?.unitTotal)
          totalUnits = Number.isFinite(requestedTotal) && requestedTotal > 0
            ? Math.min(1000, Math.floor(requestedTotal))
            : unitIndex + 1
          served = [{ index: unitIndex, text: unitText, chars: unitText.length }]
        } else {
          // The message is always re-read, even when the page sends a selection:
          // the cache key is a whole paragraph, so a selection has to be widened
          // to the paragraphs it sits in, or it would never match a full read.
          let plan
          try {
            plan = await resolveUnits(scope, current, sessionId, messageId, explicitText)
          } catch (error) {
            return writeJson(response, error.status || 500, { ok: false, code: error.code || 'FAILED', error: error.message })
          }
          if (plan.items.length === 0) {
            return writeJson(response, 404, { ok: false, code: 'NO_TEXT', error: '这条消息没有可朗读的文字（代码块、表格、公式会被跳过）' })
          }
          // `unit` addresses one paragraph of the plan, so the floating player can
          // step forward and back without re-streaming the whole reply.
          const requestedUnit = Number(body?.unit)
          unitIndex = Number.isFinite(requestedUnit) && requestedUnit >= 0
            ? Math.min(Math.floor(requestedUnit), plan.items.length - 1)
            : -1
          totalUnits = plan.items.length
          truncated = plan.truncated
          served = unitIndex >= 0 ? [plan.items[unitIndex]] : plan.items
        }
        const diskCache = current.cacheMode !== 'memory'
        const units = served.map((item) => {
          // Markers are fixed strings: pin their audio so eviction never costs
          // the user a re-synthesis of "here is a table".
          const pinned = BLOCK_MARKER_TEXTS.has(item.text)
          const hash = cacheKey(current, item.text, piperModelFor(current, item.text))
          const file = cacheFile(hash, pinned)
          return {
            unit: item.text,
            hash,
            file,
            pinned,
            cached: diskCache ? hasCachedWav(file) : !!memoryCacheGet(hash),
          }
        })
        const hits = units.filter((item) => item.cached).length
        const cacheState = hits === units.length ? 'hit' : hits === 0 ? 'miss' : 'mixed'

        const controller = new AbortController()
        const abort = () => { try { controller.abort() } catch {} }
        request.on('aborted', abort)
        response.on('close', () => { if (!response.writableEnded) abort() })

        let upstreams = 0

        /** PCM for one unit: the cached WAV body, or upstream bytes teed to disk. */
        async function* unitChunks(item) {
          if (!diskCache) {
            // RAM-only: no temp file, no rename, nothing on disk.
            const hit = memoryCacheGet(item.hash)
            if (hit) { yield hit; return }
            upstreams += 1
            const collected = []
            try {
              for await (const chunk of engineChunks(scope, current, item.unit, controller.signal)) {
                if (controller.signal.aborted) break
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                collected.push(buffer)
                yield buffer
              }
              if (!controller.signal.aborted && collected.length > 0) {
                memoryCacheSet(item.hash, Buffer.concat(collected), item.pinned)
              }
            } finally {
              collected.length = 0
            }
            return
          }
          // Hit testing here, not only when the plan was built: a message with
          // several tables repeats the same marker text, and the first occurrence
          // writes the file this one must stream instead of synthesizing again.
          if (item.cached || hasCachedWav(item.file)) {
            const stream = fs.createReadStream(item.file, { start: WAV_HEADER_BYTES })
            try {
              for await (const chunk of stream) yield chunk
            } finally {
              stream.destroy()
            }
            return
          }
          upstreams += 1
          let fd = -1
          let tmp = null
          let written = 0
          let completed = false
          try {
            try {
              fs.mkdirSync(path.dirname(item.file), { recursive: true })
              tmp = item.file + '.' + process.pid + '.' + upstreams + '.' + Date.now() + '.tmp'
              fd = fs.openSync(tmp, 'w')
              writeWavHeader(fd)
            } catch {
              if (fd >= 0) { try { fs.closeSync(fd) } catch {} }
              fd = -1
              tmp = null
            }
            for await (const chunk of engineChunks(scope, current, item.unit, controller.signal)) {
              if (controller.signal.aborted) break
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              written += buffer.length
              if (fd >= 0) {
                try { fs.writeSync(fd, buffer) } catch {
                  try { fs.closeSync(fd) } catch {}
                  fd = -1
                }
              }
              yield buffer
            }
            completed = true
          } finally {
            if (fd >= 0) {
              if (completed && written > 0 && !controller.signal.aborted) {
                try {
                  patchWavSizes(fd, written)
                  fs.closeSync(fd)
                  // Never overwrite an existing entry: the same text and voice is
                  // the same audio, so a concurrent writer already stored it.
                  if (fs.existsSync(item.file)) {
                    try { fs.unlinkSync(tmp) } catch {}
                  } else {
                    fs.renameSync(tmp, item.file)
                  }
                  pruneCache(current.cacheMaxMb * 1024 * 1024)
                } catch {
                  try { fs.closeSync(fd) } catch {}
                  try { fs.unlinkSync(tmp) } catch {}
                }
              } else {
                try { fs.closeSync(fd) } catch {}
                try { fs.unlinkSync(tmp) } catch {}
              }
              fd = -1
            } else if (tmp) {
              try { fs.unlinkSync(tmp) } catch {}
            }
          }
        }

        /** True while the response can still take bytes. */
        const alive = () => !response.destroyed && !response.writableEnded

        /**
         * Wait until the socket takes more bytes. Listening only for 'drain'
         * would hang forever when the client disconnects mid-stream (no drain is
         * ever emitted), and the listeners would stay on the underlying stream;
         * every listener added here is removed on the first of drain / close /
         * error.
         */
        const waitForDrain = () => new Promise((resolve) => {
          const socket = response.socket
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            response.off('drain', finish)
            response.off('close', finish)
            response.off('error', finish)
            if (socket) {
              socket.off('drain', finish)
              socket.off('close', finish)
              socket.off('error', finish)
            }
            resolve()
          }
          response.once('drain', finish)
          response.once('close', finish)
          response.once('error', finish)
          if (socket) {
            socket.once('drain', finish)
            socket.once('close', finish)
            socket.once('error', finish)
          }
        })

        const writeBytes = async (bytes) => {
          if (!bytes || bytes.length === 0 || !alive()) return
          let drained = false
          try { drained = response.write(bytes) } catch { return }
          if (!drained && alive()) await waitForDrain()
        }

        /**
         * Synthesize one paragraph ahead. The promise is handled as soon as it
         * exists: when playback stops, the prefetch may reject (killed child,
         * aborted upstream) and an unhandled rejection is a fatal Host error.
         */
        const prefetch = (generator) => {
          const first = generator.next()
          first.catch(() => {})
          return { gen: generator, first }
        }

        // Headers wait for the first chunk, so a failure can still answer JSON.
        let first
        const firstGen = unitChunks(units[0])
        try {
          first = await firstGen.next()
          if (first.done) {
            try { await firstGen.return() } catch {}
            return writeJson(response, 502, { ok: false, code: 'EMPTY_AUDIO', error: 'TTS 上游没有返回音频流' })
          }
        } catch (error) {
          try { await firstGen.return() } catch {}
          return writeJson(response, 502, { ok: false, code: error?.code || 'TTS_FAILED', error: error?.message ?? String(error) })
        }

        response.writeHead(200, pcmHeaders({
          'x-tts-voice': current.voice,
          'x-tts-truncated': truncated ? '1' : '0',
          // The plan's total, so a unit request still reports how many there are.
          'x-tts-units': String(totalUnits),
          'x-tts-cache': cacheState,
          'x-tts-engine': current.engine,
          ...(unitIndex >= 0 ? { 'x-tts-unit-index': String(unitIndex) } : {}),
        }))

        // The next paragraph is synthesized one ahead, so the join does not stall.
        let gen = firstGen
        let step = first
        let index = 0
        let pending = null
        if (units.length > 1) pending = prefetch(unitChunks(units[1]))
        try {
          for (;;) {
            // A closed tab must stop the prefetch chain too, not just this write.
            if (controller.signal.aborted) break
            if (step.done) {
              index += 1
              if (index >= units.length) break
              await writeBytes(silenceBytes())
              const next = pending
              pending = null
              if (next) {
                gen = next.gen
                step = await next.first
              } else {
                gen = unitChunks(units[index])
                step = await gen.next()
              }
              if (index + 1 < units.length) pending = prefetch(unitChunks(units[index + 1]))
              continue
            }
            await writeBytes(step.value)
            step = await gen.next()
          }
          if (alive()) response.end()
        } catch (error) {
          if (controller.signal.aborted) return
          log?.warn?.('[dsh-tts-reader] 朗读失败：' + (error?.message ?? String(error)))
          try { if (alive()) response.end() } catch {}
        } finally {
          try { await gen.return() } catch {}
          if (pending) {
            try { await pending.gen.return() } catch {}
            // Already handled above; awaiting again only keeps the rejection
            // from being reported as unhandled if it settles after return().
            try { await pending.first } catch {}
          }
        }
      }),
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
