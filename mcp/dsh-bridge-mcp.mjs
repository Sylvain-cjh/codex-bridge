#!/usr/bin/env node
/**
 * MCP server that connects Codex CLI to the DSH Codex Bridge.
 *
 * Design rule: every tool here is fire-and-forget unless its name says
 * otherwise. Posting a message never blocks waiting for the other side, so a
 * turn can end the moment the message is accepted. The counterpart picks work
 * up from a durable on-disk queue the next time it runs.
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0 (the MCP stdio framing).
 * Configuration (first match wins):
 *   - DSH_BRIDGE_URL  / DSH_BRIDGE_TOKEN environment variables
 *   - ~/.dsh-codex-bridge/endpoint and ~/.dsh-codex-bridge/token files
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const BRIDGE_DIR = process.env.DSH_CODEX_BRIDGE_DIR ?? join(homedir(), '.dsh-codex-bridge')
const QUEUE_DIR = join(BRIDGE_DIR, 'queue')
const DONE_DIR = join(BRIDGE_DIR, 'done')
const DEFAULT_URL = 'http://127.0.0.1:53658/codex-bridge'

function readFileTrimmed(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

function resolveBaseUrl() {
  if (process.env.DSH_BRIDGE_URL) return process.env.DSH_BRIDGE_URL.replace(/\/$/, '')
  const fromFile = readFileTrimmed(join(BRIDGE_DIR, 'endpoint'))
  return (fromFile || DEFAULT_URL).replace(/\/$/, '')
}

function resolveToken() {
  if (process.env.DSH_BRIDGE_TOKEN) return process.env.DSH_BRIDGE_TOKEN.trim()
  return readFileTrimmed(join(BRIDGE_DIR, 'token'))
}

async function callBridge(pathname, init = {}) {
  const response = await fetch(`${resolveBaseUrl()}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-bridge-token': resolveToken(),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let payload
  try {
    payload = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new Error(`bridge returned non-JSON (${response.status}): ${text.slice(0, 300)}`)
  }
  if (!response.ok) throw new Error(`bridge error ${response.status}: ${payload?.error?.message ?? response.statusText}`)
  return payload
}

// ---------------------------------------------------------------- queue files
//
// 队列按 scope 分目录，实现硬隔离：backend 与 ui 两个 Codex 会话各读各的，
// 不会取到对方的任务。旧版无子目录的消息留在 queue/ 根下，归入 default。

const QUEUE_ROOT = QUEUE_DIR

/** 某个 scope 的队列目录；scope 为空表示 default。 */
function queueDir(scope) {
  const name = typeof scope === 'string' && scope.trim() ? scope.trim() : 'default'
  return join(QUEUE_ROOT, name)
}

/** 读出某 scope 下的消息；同时兼容根目录里的旧消息（default）。 */
function readQueue(scope, topic) {
  const dirs = [queueDir(scope)]
  const name = typeof scope === 'string' && scope.trim() ? scope.trim() : 'default'
  if (name === 'default') dirs.push(QUEUE_ROOT) // 旧版消息
  const messages = []
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }) } catch { /* 只读失败时按空队列处理 */ }
      continue
    }
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    for (const file of files) {
      try {
        const message = JSON.parse(readFileSync(join(dir, file), 'utf8'))
        if (topic !== undefined && topic !== '' && message.topic !== topic) continue
        if (dir !== queueDir(name)) message.legacy = true
        messages.push({ ...message, file, dir })
      } catch {
        // 单条损坏不影响其余消息
      }
    }
  }
  return messages
}

/** Mark a message as picked up without removing it, so nothing is lost mid-turn. */
function markDelivered(message) {
  const next = { ...message, status: 'delivered', deliveredAt: Date.now() }
  const dir = message.dir || queueDir('default')
  delete next.file
  delete next.dir
  writeFileSync(join(dir, message.file), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** Move finished messages out of the queue so the inbox stays small. */
function archive(id, scope) {
  const file = `${id}.json`
  const candidates = [
    join(queueDir(scope), file),
    join(queueDir('default'), file),
    join(QUEUE_ROOT, file), // 旧版位置
  ]
  const source = candidates.find((p) => existsSync(p))
  if (!source) return false
  const doneDir = join(DONE_DIR, typeof scope === 'string' && scope.trim() ? scope.trim() : 'default')
  mkdirSync(doneDir, { recursive: true })
  renameSync(source, join(doneDir, file))
  return true
}

// -------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'dsh_inbox',
    description:
      'Read messages that DSH queued for this Codex conversation. Call this at the start of a session, before doing anything else. The queue is isolated by scope: pass the scope this conversation owns ("backend" for the backend/contract line, "ui" for the API console line). Without scope it reads "default", which old messages may still use. Returns pending messages (oldest first); each is marked delivered but stays in the queue until dsh_ack. An empty list means nothing is waiting for this scope.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Queue scope owned by this conversation: "backend" or "ui". Omit only for legacy "default" messages.',
        },
        topic: { type: 'string', description: 'Optional topic filter, e.g. "B06-KICKOFF". Omit for every topic.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_ack',
    description:
      'Acknowledge queued messages you have finished handling. They move out of the inbox into an archive. Call this after acting on dsh_inbox results; do not call it for messages you are still working on.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message ids returned by dsh_inbox.',
        },
        scope: {
          type: 'string',
          description: 'Same scope used for dsh_inbox ("backend" or "ui"). Omit for legacy "default" messages.',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_post_message',
    description:
      'Deliver a message into a DSH conversation and return immediately. DSH runs the turn in its own process, so this call does not wait for a reply and the Codex turn can end right after it. Use this for hand-offs: state what you did, what you need, and whether a reply is expected.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'DSH session id from dsh_list_sessions.' },
        text: { type: 'string', description: 'Message text. Include a short title line so the receiving side can route it.' },
        replyExpected: {
          type: 'boolean',
          description: 'Whether DSH should write back. Default false, which ends the relay chain instead of restarting it.',
        },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_sessions',
    description:
      'List DSH conversations on this machine, newest first. Returns sessionId, title, cwd, updatedAt, and running state. Use the sessionId with dsh_post_message and dsh_read_session.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive filter over title and working directory.' },
        limit: { type: 'number', description: 'Maximum sessions to return (default 30).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read_session',
    description:
      'Read the chat history of one DSH conversation as {role, text} messages, oldest first. Read-only; use it to understand context before posting.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'DSH session id from dsh_list_sessions.' },
        limit: { type: 'number', description: 'Maximum trailing messages to return (default 40, max 500).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait_reply',
    description:
      'Block for a bounded time and return whatever DSH produces in that conversation. Only use this when you genuinely need the answer inside the same turn; prefer dsh_post_message plus ending the turn, which is how the relay is designed to work.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'DSH session id to watch.' },
        waitSeconds: { type: 'number', description: 'How long to wait (default 60, max 600).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
]

const INSTRUCTIONS = [
  'This machine runs a DSH session bridge.',
  'DSH may queue messages for Codex while no Codex session is running.',
  'At the very start of a session, call dsh_inbox (no arguments) before other work.',
  'If it returns messages, handle them; otherwise continue normally.',
  'When handing work back, use dsh_post_message with replyExpected=false unless you truly need an answer — that keeps the relay from looping forever.',
  'Never poll in a loop: there is no live channel to DSH, and repeated calls only burn context.',
].join(' ')

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

async function callTool(name, args) {
  switch (name) {
    case 'dsh_inbox': {
      const scope = typeof args?.scope === 'string' ? args.scope : ''
      const pending = readQueue(scope, args?.topic).filter((message) => message.status === 'pending')
      return textResult({
        scope: scope || 'default',
        count: pending.length,
        messages: pending.map(markDelivered),
        hint:
          pending.length === 0
            ? 'Queue is empty for this scope. Nothing to pick up.'
            : 'Act on these, then call dsh_ack with their ids and the same scope.',
      })
    }
    case 'dsh_ack': {
      const ids = Array.isArray(args?.ids) ? args.ids : []
      const scope = typeof args?.scope === 'string' ? args.scope : ''
      const archived = ids.filter((id) => archive(id, scope))
      return textResult({ scope: scope || 'default', acked: archived, missing: ids.filter((id) => !archived.includes(id)) })
    }
    case 'dsh_post_message': {
      if (!args?.sessionId) throw new Error('sessionId is required')
      if (!args?.text) throw new Error('text is required')
      const accepted = await callBridge(`/sessions/${encodeURIComponent(args.sessionId)}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text: String(args.text), mode: 'queue', waitSeconds: 0 }),
      })
      return textResult({
        ...accepted,
        note: 'Delivered. DSH runs it in its own process; this turn can end now.',
      })
    }
    case 'dsh_list_sessions': {
      const params = new URLSearchParams()
      if (args?.query) params.set('query', String(args.query))
      if (args?.limit) params.set('limit', String(args.limit))
      const suffix = params.toString() ? `?${params}` : ''
      return textResult(await callBridge(`/sessions${suffix}`))
    }
    case 'dsh_read_session': {
      if (!args?.sessionId) throw new Error('sessionId is required')
      const limit = args?.limit ? `?limit=${encodeURIComponent(args.limit)}` : ''
      return textResult(await callBridge(`/sessions/${encodeURIComponent(args.sessionId)}${limit}`))
    }
    case 'dsh_wait_reply': {
      if (!args?.sessionId) throw new Error('sessionId is required')
      const afterSeq = Number(args?.afterSeq ?? 0)
      const deadline = Date.now() + Math.min(Math.max(Number(args?.waitSeconds ?? 60) || 60, 1), 600) * 1000
      let latest = null
      while (Date.now() < deadline) {
        const snapshot = await callBridge(`/sessions/${encodeURIComponent(args.sessionId)}?limit=20`)
        const fresh = (snapshot.messages ?? []).filter(
          (message) => message.role === 'assistant' && typeof message.seq === 'number' && message.seq > afterSeq,
        )
        if (fresh.length > 0) {
          latest = fresh
          if (snapshot.running === false) break
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      return textResult({ sessionId: args.sessionId, found: latest !== null, replies: latest ?? [] })
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

async function handle(message) {
  const { id, method, params } = message
  if (method === undefined) return
  switch (method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-codex-bridge', version: '0.2.0' },
        instructions: INSTRUCTIONS,
      })
    case 'notifications/initialized':
    case 'initialized':
      return
    case 'ping':
      return respond(id, {})
    case 'tools/list':
      return respond(id, { tools: TOOLS })
    case 'tools/call': {
      try {
        return respond(id, await callTool(params?.name, params?.arguments ?? {}))
      } catch (error) {
        return respond(id, {
          content: [{ type: 'text', text: `Bridge call failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        })
      }
    }
    default:
      if (id !== undefined) respondError(id, -32601, `method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    process.stderr.write('dsh-codex-bridge: ignoring non-JSON line\n')
    return
  }
  void handle(message).catch((error) => {
    process.stderr.write(`dsh-codex-bridge: ${error instanceof Error ? error.message : String(error)}\n`)
  })
})
