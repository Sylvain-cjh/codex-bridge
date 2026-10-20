#!/usr/bin/env node
/**
 * Reverse direction of the bridge: ask Codex CLI a one-shot question from inside
 * a DSH session and print the final assistant message.
 *
 * usage: node ask-codex.mjs "your prompt" [--cwd DIR] [--timeout SECONDS]
 *
 * Codex runs non-interactively (`codex exec --json`); the JSONL stream is parsed
 * so only the final agent_message reaches stdout. Diagnostics go to stderr.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
let prompt = ''
let cwd = process.cwd()
let timeoutSeconds = 300

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--cwd') {
    cwd = argv[index + 1]
    index += 1
  } else if (arg === '--timeout') {
    timeoutSeconds = Number(argv[index + 1]) || timeoutSeconds
    index += 1
  } else {
    prompt = prompt.length > 0 ? `${prompt} ${arg}` : arg
  }
}

if (prompt.length === 0) {
  console.error('usage: node ask-codex.mjs "your prompt" [--cwd DIR] [--timeout SECONDS]')
  process.exit(2)
}

/**
 * Resolve the Codex entry script. Launching `node codex.js` directly avoids the
 * Windows shell, which otherwise mangles quoted and non-ASCII prompts. Set
 * CODEX_JS to override the lookup.
 */
function resolveCodexEntry() {
  if (process.env.CODEX_JS) return process.env.CODEX_JS
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const entry = resolveCodexEntry()
const args = ['exec', '--skip-git-repo-check', '--json', prompt]
const child = entry
  ? spawn(process.execPath, [entry, ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
  : spawn('codex', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
const messages = []
let failure = null

createInterface({ input: child.stdout }).on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.startsWith('{')) {
    try {
      const event = JSON.parse(trimmed)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') messages.push(event.item.text)
      else if (event.type === 'error') failure = event.message
      return
    } catch {
      // fall through and keep the raw line for diagnostics
    }
  }
  if (trimmed.length > 0 && !trimmed.startsWith('Reading additional input')) console.error(trimmed)
})

const timer = setTimeout(() => {
  child.kill()
  console.error(`ask-codex: timed out after ${timeoutSeconds}s`)
  process.exit(124)
}, timeoutSeconds * 1000)

child.on('close', (code) => {
  clearTimeout(timer)
  const answer = messages.at(-1)
  if (answer !== undefined) {
    process.stdout.write(`${answer}\n`)
    process.exit(0)
  }
  console.error(`ask-codex: no agent message (exit ${code})${failure ? `: ${failure}` : ''}`)
  process.exit(code === 0 ? 1 : (code ?? 1))
})
