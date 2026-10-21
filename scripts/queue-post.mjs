#!/usr/bin/env node
/**
 * DSH side of the relay: drop a message into the on-disk queue that Codex reads
 * with `dsh_inbox`. Returns immediately — the sender's turn can end here.
 *
 * usage:
 *   node queue-post.mjs --text "消息正文" [--topic DSH-007] [--expect-reply] [--from dsh]
 *
 * The queue lives next to the bridge token so both sides share one location:
 *   ~/.dsh-codex-bridge/queue/<id>.json
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BRIDGE_DIR = process.env.DSH_CODEX_BRIDGE_DIR ?? join(homedir(), '.dsh-codex-bridge')
const QUEUE_DIR = join(BRIDGE_DIR, 'queue')

const argv = process.argv.slice(2)
let text = ''
let topic = 'default'
let scope = 'default'
let expectReply = false
let from = 'dsh'
let filePath = null

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--text') {
    text = argv[index + 1] ?? ''
    index += 1
  } else if (arg === '--topic') {
    topic = argv[index + 1] ?? topic
    index += 1
  } else if (arg === '--scope') {
    scope = argv[index + 1] ?? scope
    index += 1
  } else if (arg === '--from') {
    from = argv[index + 1] ?? from
    index += 1
  } else if (arg === '--file') {
    filePath = argv[index + 1] ?? null
    index += 1
  } else if (arg === '--expect-reply') {
    expectReply = true
  } else if (arg === '--list') {
    listQueue()
    process.exit(0)
  } else if (text.length === 0 && !arg.startsWith('--')) {
    text = arg
  }
}

if (filePath !== null) text = readFileSync(filePath, 'utf8')

// 队列按 scope 分目录；listQueue 和写入都依赖它，必须先定义
const scopeDir = join(QUEUE_DIR, scope)

if (text.trim().length === 0) {
  console.error('queue-post: empty message. Pass --text "..." or --file <path>.')
  process.exit(2)
}

function listQueue() {
  let files = []
  try {
    files = readdirSync(scopeDir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    console.log(`queue is empty (scope=${scope})`)
    return
  }
  if (files.length === 0) {
    console.log(`queue is empty (scope=${scope})`)
    return
  }
  for (const file of files) {
    const message = JSON.parse(readFileSync(join(scopeDir, file), 'utf8'))
    console.log(`[${message.status}] ${message.id}  scope=${message.scope || scope}  topic=${message.topic}  from=${message.from}  reply=${message.replyExpected}`)
    console.log(`  ${message.text.split('\n')[0].slice(0, 160)}`)
  }
}

mkdirSync(scopeDir, { recursive: true })
const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const message = {
  id,
  topic,
  scope,
  from,
  to: from === 'dsh' ? 'codex' : 'dsh',
  at: Date.now(),
  text,
  replyExpected: expectReply,
  status: 'pending',
}
writeFileSync(join(scopeDir, `${id}.json`), `${JSON.stringify(message, null, 2)}\n`)

console.log(JSON.stringify({ queued: true, id, topic, replyExpected: expectReply, queueDir: QUEUE_DIR }))
