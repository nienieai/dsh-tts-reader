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
import { spawn } from 'node:child_process'
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
const RECENT_PATH = PREFIX + '/recent'

const API_BASE = 'https://api.deepseek.com'
const KEY_REF = 'DEEPSEEK_API_KEY'
const VOICES = new Set(['stella', 'tide'])
const HARD_MAX_CHARS = 4000
const SAMPLE_RATE = 24000
const MIN_SPEED = 0.5
const MAX_SPEED = 2

const DEFAULTS = {
  // Which synthesizer produces the audio: the DeepSeek API, or a local Piper
  // executable the user installed themselves.
  engine: 'deepseek',
  piperPath: '',
  piperModel: '',
  voice: 'stella',
  maxChars: 4000,
  cacheMaxMb: 200,
  // Playback rate for the page's pitch-preserving time-stretch; the TTS API
  // itself has no speed parameter, so this never reaches the request.
  speed: 1,
  autoRead: false,
  autoReadInterim: false,
  speakQuestions: true,
  speakApprovals: true,
}

const ENGINES = new Set(['deepseek', 'piper'])

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
  const engine = ENGINES.has(String(merged.engine)) ? String(merged.engine) : DEFAULTS.engine
  const piperPath = typeof merged.piperPath === 'string' ? merged.piperPath.trim() : ''
  const piperModel = typeof merged.piperModel === 'string' ? merged.piperModel.trim() : ''
  return { engine, piperPath, piperModel, voice, maxChars, cacheMaxMb, speed, autoRead, autoReadInterim, speakQuestions, speakApprovals }
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

function cacheKey(engine, voice, text) {
  const hash = crypto.createHash('sha256')
  // DeepSeek keeps the bare form, so audio cached before engines existed stays valid.
  if (engine !== 'deepseek') hash.update(String(engine)).update('\u0000')
  return hash.update(voice).update('\u0000').update(text, 'utf8').digest('hex')
}

function cacheFile(hash) {
  return path.join(cacheDir(), hash + '.wav')
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

/** Drop every row of a table: a spoken table is noise, not speech. */
function dropTables(text) {
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
  return lines.filter((line, index) => !drop[index]).join('\n')
}

export function stripMarkdown(markdown) {
  let text = String(markdown || '').replace(/\r\n?/g, '\n')
  // Fenced code is skipped: reading code aloud is noise, and this also covers
  // ```mermaid diagrams.
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
  // Inline code is short and often a word of the sentence, so it stays verbatim.
  const stash = []
  const keep = (value) => '\u0000' + (stash.push(value) - 1) + '\u0000'
  text = text.replace(/`([^`\n]+)`/g, (_, body) => keep(body))
  // Display math is not speech; inline $...$ stays, it may just be a price.
  text = text.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\\\[[\s\S]*?\\\]/g, '')
  // Footnote definitions disappear; the markers left in the prose go too.
  text = text.replace(/^[ \t]*\[\^[^\]]+\]:[^\n]*$/gm, '')
  text = text.replace(/\[\^[^\]]+\]/g, '')
  // Unescape markdown escapes before the markers themselves are stripped.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
  // Images render as pictures, so the alt text is not spoken.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
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
  text = dropTables(text)
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
export function planUnits(text, limit) {
  const units = []
  let truncated = false
  for (const paragraph of toParagraphs(text)) {
    let rest = paragraph
    while (rest.length > limit) {
      const cut = findBreak(rest, limit)
      if (cut <= 0) {
        units.push(rest.slice(0, limit))
        rest = rest.slice(limit).trim()
        truncated = true
        continue
      }
      units.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) units.push(rest)
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

/** What the settings page needs to know about the local engine. */
export function engineInfo(settings) {
  const exe = settings && typeof settings.piperPath === 'string' ? settings.piperPath : ''
  const model = settings && typeof settings.piperModel === 'string' ? settings.piperModel : ''
  return {
    piper: {
      exe: exe ? fs.existsSync(exe) : false,
      model: model ? fs.existsSync(model) : false,
      sampleRate: model && fs.existsSync(model) ? piperSampleRate(model) : 0,
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
// both and keep whichever the installed binary accepts.
const PIPER_FLAGS = ['--output-raw', '--output_raw']

async function* startPiper(settings, flag, text, signal) {
  const child = spawn(settings.piperPath, ['--model', settings.piperModel, flag], { windowsHide: true })
  let stderr = ''
  let spawnError = null
  const exited = new Promise((resolve) => {
    child.once('close', (code) => resolve(code ?? 0))
    child.once('error', () => resolve(0))
  })
  child.on('error', (error) => { spawnError = error })
  child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString() })
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

async function* piperChunks(settings, text, signal) {
  if (!settings.piperPath) throw engineError('本地引擎未配置：请先填写 piper 程序路径', 'NO_ENGINE')
  if (!fs.existsSync(settings.piperPath)) throw engineError('找不到 piper 程序：' + settings.piperPath, 'NO_ENGINE')
  if (!settings.piperModel) throw engineError('本地引擎未配置：请先填写模型路径', 'NO_ENGINE')
  let failure = null
  for (const flag of PIPER_FLAGS) {
    let produced = false
    try {
      for await (const chunk of startPiper(settings, flag, text, signal)) {
        if (chunk.length) produced = true
        yield chunk
      }
      return
    } catch (error) {
      if (produced || (signal && signal.aborted)) throw error
      failure = error
    }
  }
  throw failure || engineError('piper 没有输出音频', 'TTS_FAILED')
}

/** 24 kHz mono PCM for one paragraph, from whichever engine is configured. */
async function* engineChunks(scope, settings, text, signal) {
  if (settings.engine === 'piper') {
    const resampler = createResampler(piperSampleRate(settings.piperModel), SAMPLE_RATE)
    for await (const chunk of piperChunks(settings, text, signal)) {
      const pcm = resampler.push(chunk)
      if (pcm.length) yield pcm
    }
    const tail = resampler.flush()
    if (tail.length) yield tail
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
          return writeJson(response, 200, { ok: true, value: { ...current, ...engineInfo(current), voices: [...VOICES], cache: cacheStats(), keyConfigured, sseClients: listeners.size, sse: { ...sseStats, clients: listeners.size, recentSeq } } })
        }
        if (method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method not allowed' })
        const body = await readJsonBody(request)
        if (!body || typeof body !== 'object') return writeJson(response, 400, { ok: false, code: 'BAD_BODY', error: '请求体不是 JSON' })
        const current = readSettings()
        const next = normalizeSettings({ ...current, ...pick(body, ['engine', 'piperPath', 'piperModel', 'voice', 'maxChars', 'cacheMaxMb', 'speed', 'autoRead', 'autoReadInterim', 'speakQuestions', 'speakApprovals']) }, null)
        if (body.clearCache === true) clearCache()
        if (!writeSettings(next)) return writeJson(response, 500, { ok: false, code: 'WRITE_FAILED', error: '写入设置失败' })
        pruneCache(next.cacheMaxMb * 1024 * 1024)
        let keyConfigured = false
        try {
          const info = await scope.credentials.describe(KEY_REF)
          keyConfigured = !!(info && info.configured)
        } catch {}
        return writeJson(response, 200, { ok: true, value: { ...next, ...engineInfo(next), voices: [...VOICES], cache: cacheStats(), keyConfigured } })
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
          try { response.write(': ping\n\n') } catch {}
        }, 25000)
        const cleanup = () => {
          clearInterval(heartbeat)
          if (listeners.delete(response)) sseStats.closed += 1
        }
        request.on('close', cleanup)
        response.on('close', cleanup)
      },
    }), 'dsh-tts-reader: events')

    // Polling fallback for the same feed: `after=<seq>` returns what the page
    // has not seen yet, so auto-read survives a dead EventSource.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: RECENT_PATH,
      handler: (request, response) => {
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
      },
    }), 'dsh-tts-reader: recent')

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

        // The message is always re-read, even when the page sends a selection:
        // the cache key is a whole paragraph, so a selection has to be widened to
        // the paragraphs it sits in, or it would never match a full read.
        let messageText = ''
        let sessionError = null
        if (sessionId && messageId) {
          try {
            messageText = await readMessageText(scope.sessionQuery, sessionId, messageId)
          } catch (error) {
            sessionError = error
          }
        }
        if (!messageText && !explicitText) {
          if (sessionError) {
            return writeJson(response, 500, { ok: false, code: 'SESSION_READ_FAILED', error: '读取会话失败：' + (sessionError?.message ?? String(sessionError)) })
          }
          return writeJson(response, 404, { ok: false, code: 'NO_TEXT', error: '这条消息没有可朗读的文字（代码块、表格、公式会被跳过）' })
        }

        // One synthesis request (and one cache file) per paragraph, so reading a
        // single paragraph later reuses the file the whole message already made.
        const whole = messageText ? planUnits(messageText, current.maxChars) : { units: [], truncated: false }
        let unitTexts = whole.units
        let truncated = whole.truncated
        if (explicitText) {
          const covering = locateParagraphs(whole.units, explicitText)
          if (covering) {
            unitTexts = covering
            truncated = false
          } else {
            // Not part of the message text (a code block, say): synthesize the
            // selection itself, which is the old behaviour.
            const own = planUnits(explicitText, current.maxChars)
            unitTexts = own.units
            truncated = own.truncated
          }
        }
        const units = unitTexts.map((unit) => {
          const file = cacheFile(cacheKey(current.engine, current.voice, unit))
          return { unit, file, cached: hasCachedWav(file) }
        })
        if (units.length === 0) {
          return writeJson(response, 404, { ok: false, code: 'NO_TEXT', error: '这条消息没有可朗读的文字（代码块、表格、公式会被跳过）' })
        }
        const hits = units.filter((item) => item.cached).length
        const cacheState = hits === units.length ? 'hit' : hits === 0 ? 'miss' : 'mixed'

        const controller = new AbortController()
        const abort = () => { try { controller.abort() } catch {} }
        request.on('aborted', abort)
        response.on('close', () => { if (!response.writableEnded) abort() })

        let upstreams = 0

        /** PCM for one unit: the cached WAV body, or upstream bytes teed to disk. */
        async function* unitChunks(item) {
          if (item.cached) {
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
              fs.mkdirSync(cacheDir(), { recursive: true })
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
                  fs.renameSync(tmp, item.file)
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

        const writeBytes = async (bytes) => {
          if (!bytes || bytes.length === 0) return
          if (!response.write(bytes)) await once(response, 'drain')
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
          'x-tts-units': String(units.length),
          'x-tts-cache': cacheState,
          'x-tts-engine': current.engine,
        }))

        // The next paragraph is synthesized one ahead, so the join does not stall.
        let gen = firstGen
        let step = first
        let index = 0
        let pending = null
        if (units.length > 1) {
          const nextGen = unitChunks(units[1])
          pending = { gen: nextGen, first: nextGen.next() }
        }
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
              if (index + 1 < units.length) {
                const lookahead = unitChunks(units[index + 1])
                pending = { gen: lookahead, first: lookahead.next() }
              }
              continue
            }
            await writeBytes(step.value)
            step = await gen.next()
          }
          response.end()
        } catch (error) {
          if (controller.signal.aborted) return
          log?.warn?.('[dsh-tts-reader] 朗读失败：' + (error?.message ?? String(error)))
          try { response.end() } catch {}
        } finally {
          try { await gen.return() } catch {}
          if (pending) { try { await pending.gen.return() } catch {} }
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
