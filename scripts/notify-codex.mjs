#!/usr/bin/env node
/**
 * DSH -> Codex 的「投递 + 提醒」脚本。
 *
 * 做两件事，都不启动新的 agent 进程（不使用 codex exec）：
 *   1. 把消息写进桥接队列 ~/.dsh-codex-bridge/queue/，Codex 下次启动时用 dsh_inbox 取；
 *   2. 用 `codex queue` 往既有 Codex 会话投一条「去取消息」的提示，
 *      Codex 正在运行时会被唤醒；不在运行时消息仍留在队列里，不会丢。
 *
 * usage:
 *   node notify-codex.mjs --text "消息" [--topic DSH-008] [--cwd DIR] [--session ID]
 *                         [--queue-only] [--dry-run]
 *
 * 目标 Codex 会话解析顺序：
 *   --session <id> → 与 --cwd（默认当前目录）匹配的最新 Codex 会话 → 不投提醒，只留队列
 */
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const BRIDGE_DIR = process.env.DSH_CODEX_BRIDGE_DIR ?? join(homedir(), '.dsh-codex-bridge')
const QUEUE_DIR = join(BRIDGE_DIR, 'queue')
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')

const argv = process.argv.slice(2)
let text = ''
let topic = 'default'
let cwd = process.cwd()
let session = null
let purpose = ''
let queueOnly = false
let dryRun = false

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--text') text = argv[++i] ?? ''
  else if (arg === '--topic') topic = argv[++i] ?? topic
  else if (arg === '--cwd') cwd = argv[++i] ?? cwd
  else if (arg === '--session') session = argv[++i] ?? null
  else if (arg === '--purpose') purpose = argv[++i] ?? ''
  else if (arg === '--queue-only') queueOnly = true
  else if (arg === '--dry-run') dryRun = true
  else if (!arg.startsWith('--') && text.length === 0) text = arg
}

if (text.trim().length === 0) {
  console.error('notify-codex: 需要 --text "消息" 或作为第一个参数传入正文。')
  process.exit(2)
}

cwd = resolve(cwd)

/** 读 rollout 文件的第一行，取出该会话的 cwd。只读一行，不加载整个文件。 */
function firstLineOf(file) {
  return new Promise((done) => {
    const stream = createReadStream(file, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    let settled = false
    rl.on('line', (line) => {
      if (settled) return
      settled = true
      rl.close()
      stream.destroy()
      done(line)
    })
    rl.on('close', () => { if (!settled) { settled = true; done('') } })
    rl.on('error', () => { if (!settled) { settled = true; done('') } })
  })
}

async function findSessionForCwd(targetCwd) {
  const root = join(CODEX_HOME, 'sessions')
  if (!existsSync(root)) return null
  const years = readdirSync(root).filter((n) => /^\d{4}$/.test(n)).sort().reverse()
  const files = []
  for (const year of years.slice(0, 1)) {
    const yearDir = join(root, year)
    for (const month of readdirSync(yearDir).sort().reverse()) {
      const monthDir = join(yearDir, month)
      for (const day of readdirSync(monthDir).sort().reverse()) {
        const dayDir = join(monthDir, day)
        for (const name of readdirSync(dayDir)) {
          if (!name.endsWith('.jsonl')) continue
          const full = join(dayDir, name)
          files.push({ full, mtime: statSync(full).mtimeMs, name })
        }
      }
      if (files.length > 200) break
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const file of files.slice(0, 40)) {
    const line = await firstLineOf(file.full)
    if (!line) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    const recorded = parsed?.payload?.cwd ?? parsed?.cwd ?? null
    if (recorded && resolve(recorded).toLowerCase() === targetCwd.toLowerCase()) {
      const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file.name)
      if (match) return match[1]
    }
  }
  return null
}

// 1) 写队列（按 scope 分目录，实现会话间硬隔离）
const scope = (purpose || 'backend').trim()
const scopeDir = join(QUEUE_DIR, scope)
mkdirSync(scopeDir, { recursive: true })
const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const message = { id, topic, scope, from: 'dsh', to: 'codex', at: Date.now(), text, replyExpected: false, status: 'pending' }
const file = join(scopeDir, `${id}.json`)

// 2) 解析目标会话并投递提醒
// 优先级：DSH_CODEX_SESSION 环境变量 > --session 参数 > 按用途固定的会话文件 > 默认固定会话 > 按 cwd 自动匹配。
// --purpose ui 会读 codex-session-ui，用于把测试控制台这类工作分到独立对话。
function readPinnedSession(name) {
  try {
    const p = join(BRIDGE_DIR, name ? `codex-session-${name}` : 'codex-session')
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : ''
  } catch {
    return ''
  }
}
const target = process.env.DSH_CODEX_SESSION
  || session
  || (purpose ? readPinnedSession(purpose) : '')
  || readPinnedSession('')
  || (await findSessionForCwd(cwd))
const notice = `【DSH 有新消息】主题 ${topic}，队列 scope=${scope}。请调用 MCP 工具 dsh_inbox({ scope: "${scope}" }) 取消息；处理完用 dsh_ack({ ids: [...], scope: "${scope}" }) 归档。只处理本 scope，勿读取其他 scope。`

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    wouldWrite: file,
    topic,
    targetSession: target ?? '(未找到，仅写队列)',
    wouldQueue: target && !queueOnly ? `codex queue --thread ${target} --message "<提醒>"` : null,
  }, null, 2))
  process.exit(0)
}

writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`)
console.log(JSON.stringify({ queued: true, id, topic, file }))

if (queueOnly) {
  console.log(JSON.stringify({ notified: false, reason: 'queue-only' }))
  process.exit(0)
}

if (!target) {
  console.log(JSON.stringify({ notified: false, reason: 'no matching Codex session for cwd', cwd }))
  process.exit(0)
}

/**
 * 解析 Codex 的 JS 入口，用 node 直接执行，参数以数组传递。
 * 这样能避开 Windows shell 对中文与引号的破坏（`codex queue` 曾因此报
 * "unexpected argument"）。
 */
function resolveCodexEntry() {
  if (process.env.CODEX_JS) return process.env.CODEX_JS
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const result = (() => {
  const entry = resolveCodexEntry()
  const args = ['queue', '--thread', target, '--message', notice]
  const options = { encoding: 'utf8', timeout: 60_000 }
  return entry
    ? spawnSync(process.execPath, [entry, ...args], options)
    : spawnSync('codex', args, { ...options, shell: process.platform === 'win32' })
})()

if (result.error) {
  console.log(JSON.stringify({ notified: false, reason: String(result.error.message), session: target }))
  process.exit(0)
}
if (result.status !== 0) {
  console.log(JSON.stringify({ notified: false, reason: (result.stderr || '').trim().slice(0, 300), session: target }))
  process.exit(0)
}

console.log(JSON.stringify({ notified: true, session: target, output: (result.stdout || '').trim().slice(0, 200) }))
