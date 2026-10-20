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

/** Read every queued message, newest last. Missing directory means an empty queue. */
function readQueue(topic) {
  mkdirSync(QUEUE_DIR, { recursive: true })
  const files = readdirSync(QUEUE_DIR).filter((name) => name.endsWith('.json')).sort()
  const messages = []
  for (const file of files) {
    try {
      const message = JSON.parse(readFileSync(join(QUEUE_DIR, file), 'utf8'))
      if (topic !== undefined && topic !== '' && message.topic !== topic) continue
      messages.push({ ...message, file })
    } catch {
      // A corrupt entry must not hide the rest of the queue.
    }
  }
  return messages
}

/** Mark a message as picked up without removing it, so nothing is lost mid-turn. */
function markDelivered(message) {
  const next = { ...message, status: 'delivered', deliveredAt: Date.now() }
  delete next.file
  writeFileSync(join(QUEUE_DIR, message.file), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** Move finished messages out of the queue so the inbox stays small. */
function archive(id) {
  mkdirSync(DONE_DIR, { recursive: true })
  const file = `${id}.json`
  const source = join(QUEUE_DIR, file)
  if (!existsSync(source)) return false
  renameSync(source, join(DONE_DIR, file))
  return true
}

// -------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'dsh_inbox',
    description:
      'Read messages that DSH queued for Codex while no Codex session was running. Call this at the start of a session, before doing anything else. Returns pending messages (oldest first); each is marked delivered but stays in the queue until dsh_ack. An empty list means there is nothing waiting and you can stop.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Optional topic filter, e.g. "DSH-007". Omit for every topic.' },
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
      const pending = readQueue(args?.topic).filter((message) => message.status === 'pending')
      return textResult({
        count: pending.length,
        messages: pending.map(markDelivered),
        hint:
          pending.length === 0
            ? 'Queue is empty. Nothing to pick up.'
            : 'Act on these, then call dsh_ack with their ids.',
      })
    }
    case 'dsh_ack': {
      const ids = Array.isArray(args?.ids) ? args.ids : []
      const archived = ids.filter((id) => archive(id))
      return textResult({ acked: archived, missing: ids.filter((id) => !archived.includes(id)) })
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
