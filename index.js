/**
 * Codex Bridge — a Host-only DSH plugin that exposes the local Session API over
 * a token-guarded HTTP endpoint so an external agent (Codex CLI) can list DSH
 * conversations, read their history, and send prompts that wait for a reply.
 *
 * Everything here runs inside the DSH Host process. It composes public Cordis
 * services (`webServer`, `sessionController`) instead of reaching into private
 * modules, so it survives DSH upgrades that keep those contracts.
 *
 * @module @local/dsh-codex-bridge
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'codex-bridge'

/** Services that must be present before this plugin can register its route. */
export const inject = ['webServer', 'sessionController']

const ROUTE_PREFIX = '/codex-bridge'
const MAX_BODY_BYTES = 1024 * 1024
const POLL_INTERVAL_MS = 700
const MAX_WAIT_SECONDS = 600

/** Directory that holds the shared bridge token; overridable for tests. */
const TOKEN_DIR = process.env.DSH_CODEX_BRIDGE_DIR ?? join(homedir(), '.dsh-codex-bridge')

/** Read the persisted token, creating one with owner-only permissions on first run. */
function loadToken() {
  const file = join(TOKEN_DIR, 'token')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length > 0) return existing
  }
  const token = randomBytes(24).toString('hex')
  mkdirSync(TOKEN_DIR, { recursive: true })
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}

/** Extract the last event sequence in a snapshot, or 0 when the log is empty. */
function lastSeq(events) {
  let max = 0
  for (const event of events) {
    if (typeof event?.seq === 'number' && event.seq > max) max = event.seq
  }
  return max
}

/** Split one message's content blocks into visible text, reasoning, and tool names. */
function textOfMessage(message) {
  const text = []
  const thinking = []
  const tools = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block?.type === 'reasoning' && typeof block.text === 'string') thinking.push(block.text)
    else if (block?.type === 'tool-call') tools.push(block.name ?? 'unknown')
  }
  return {
    text: text.join('\n').trim(),
    thinking: thinking.join('\n').trim(),
    tools,
  }
}

/**
 * Project a raw event log into the chat-shaped messages the Web UI shows, plus
 * the most recent title. Reasoning stays in its own field so a caller can choose
 * to ignore it; tool results and request headers are omitted entirely.
 */
function projectSession(events) {
  const messages = []
  let title = null
  const push = (event, role, message) => {
    const parts = textOfMessage(message)
    if (parts.text.length === 0 && parts.thinking.length === 0 && parts.tools.length === 0) return
    const entry = { seq: event.seq, time: event.time, role, text: parts.text }
    if (parts.thinking.length > 0) entry.thinking = parts.thinking
    if (parts.tools.length > 0) entry.tools = parts.tools
    messages.push(entry)
  }
  for (const event of events) {
    switch (event?.type) {
      case 'user/message':
        push(event, 'user', event.data)
        break
      case 'assistant/message':
        push(event, 'assistant', event.data?.message)
        break
      case 'session/title':
        if (typeof event.data?.title === 'string') title = event.data.title
        break
      default:
        break
    }
  }
  return { title, messages }
}

/** True when a turn finished after `afterSeq`, proving the prompt ran to completion. */
function turnEndedAfter(events, afterSeq) {
  return events.some((event) => event?.type === 'turn/end' && typeof event.seq === 'number' && event.seq > afterSeq)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, ...extra } })
}

/** Read and parse a JSON request body, enforcing a hard size ceiling. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Register the bridge route. The disposer returned by `ctx.effect` unregisters
 * the route when the plugin unloads, so repeated HMR reloads stay clean.
 *
 * @param ctx - Host plugin context with `webServer` and `sessionController`.
 */
export function apply(ctx) {
  const token = loadToken()
  const sessionQuery = ctx.get('sessionQuery')

  // Publish the live endpoint next to the token so the MCP server needs no port
  // configuration. Missing origin (listener not bound yet) is not fatal.
  try {
    const origin = ctx.webServer.getOrigin()
    mkdirSync(TOKEN_DIR, { recursive: true })
    writeFileSync(join(TOKEN_DIR, 'endpoint'), `${origin}${ROUTE_PREFIX}\n`, { mode: 0o600 })
  } catch {
    ctx.logger?.warn?.('codex-bridge: could not publish endpoint file')
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith(ROUTE_PREFIX)) return sendError(res, 404, 'unknown route')

      const provided =
        req.headers['x-bridge-token'] ??
        (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : undefined)
      if (provided !== token) return sendError(res, 401, 'missing or invalid bridge token')

      const rest = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = req.method ?? 'GET'

      if (method === 'GET' && (rest === '/' || rest === '/health')) {
        return sendJson(res, 200, { ok: true, bridge: 'codex-bridge', protocol: 1 })
      }

      if (method === 'GET' && rest === '/sessions') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 200)
        const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
        const { items } = await ctx.sessionController.list({}, AbortSignal.timeout(20_000))
        const sessions = items
          .map((item) => ({
            sessionId: item.sessionId,
            title: item.projections?.values?.title ?? null,
            cwd: item.cwd ?? null,
            updatedAt: item.updatedAt,
            running: item.running,
            blank: item.blank,
          }))
          .filter((item) => {
            if (query.length === 0) return true
            return `${item.title ?? ''} ${item.cwd ?? ''}`.toLowerCase().includes(query)
          })
          .slice(0, limit)

        // Rows without a projection hint still have a durable title event; fill
        // a bounded prefix so the list is readable without resuming any Agent.
        if (sessionQuery !== undefined) {
          const missing = sessions.filter((s) => s.title === null).map((s) => s.sessionId).slice(0, 20)
          if (missing.length > 0) {
            try {
              const results = await sessionQuery.readTitleSnapshots(missing, AbortSignal.timeout(20_000))
              const titles = new Map()
              results.forEach((result, index) => {
                const value = result?.status === 'fulfilled' ? result.value : undefined
                if (typeof value?.title === 'string' && value.title.length > 0) titles.set(missing[index], value.title)
              })
              for (const session of sessions) {
                if (session.title === null && titles.has(session.sessionId)) session.title = titles.get(session.sessionId)
              }
            } catch {
              // Title enrichment is best-effort; the session id remains usable.
            }
          }
        }

        return sendJson(res, 200, { sessions, total: items.length })
      }

      const sessionMatch = /^\/sessions\/([^/]+)(\/messages)?$/.exec(rest)
      if (sessionMatch && method === 'GET') {
        const sessionId = decodeURIComponent(sessionMatch[1])
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 40) || 40, 1), 500)
        const snapshot = await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(20_000))
        const projected = projectSession(snapshot.events)
        const messages = projected.messages.slice(-limit)
        return sendJson(res, 200, {
          sessionId,
          title: projected.title,
          cwd: snapshot.meta?.cwd ?? null,
          messageCount: projected.messages.length,
          messages,
        })
      }

      const promptMatch = /^\/sessions\/([^/]+)\/prompt$/.exec(rest)
      if (promptMatch && method === 'POST') {
        const sessionId = decodeURIComponent(promptMatch[1])
        const body = await readJsonBody(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text.length === 0) return sendError(res, 400, 'text must be a non-empty string')
        const mode = body.mode === 'steer' ? 'steer' : 'queue'
        const requestedWait = Number(body.waitSeconds ?? 120)
        const waitSeconds = Number.isFinite(requestedWait) ? Math.min(Math.max(requestedWait, 0), MAX_WAIT_SECONDS) : 120

        const before = await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(20_000))
        const beforeSeq = lastSeq(before.events)
        const requestId = randomUUID()

        await ctx.sessionController.prompt(
          { requestId, sessionId, mode, content: [{ type: 'text', text }] },
          AbortSignal.timeout(60_000),
        )

        // Queue-only delivery: DSH owns the turn from here, so report acceptance
        // and let the caller end its own turn immediately.
        if (waitSeconds === 0) {
          return sendJson(res, 200, {
            sessionId,
            requestId,
            accepted: true,
            completed: false,
            mode: 'queued',
            elapsedMs: 0,
            replies: [],
          })
        }

        const startedAt = Date.now()
        const deadline = startedAt + waitSeconds * 1000
        let replies = []
        let completed = false

        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS)
          const snapshot = await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(20_000))
          const projected = projectSession(snapshot.events)
          const fresh = projected.messages.filter((message) => message.seq > beforeSeq)
          replies = fresh.filter((message) => message.role === 'assistant')
          const lastReply = replies.at(-1)
          if (lastReply !== undefined && turnEndedAfter(snapshot.events, lastReply.seq)) {
            completed = true
            break
          }
        }

        return sendJson(res, 200, {
          sessionId,
          requestId,
          accepted: true,
          completed,
          elapsedMs: Date.now() - startedAt,
          replies,
        })
      }

      return sendError(res, 404, `unknown route: ${method} ${rest}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return sendError(res, 500, message)
    }
  }

  return ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
}
