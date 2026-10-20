# DSH ⇄ Codex Bridge

Message relay between a running **DSH** session and **Codex CLI**, so the two agents can hand work to each other without a human copying text between chat windows.

## How it works

| Direction | Transport | Who picks it up |
| --- | --- | --- |
| Codex → DSH | Token-guarded HTTP endpoint on the DSH host | DSH starts a turn in its own process immediately |
| DSH → Codex | On-disk queue under `~/.dsh-codex-bridge/queue/` | Codex calls the MCP tool `dsh_inbox` on its next run |

**Fire-and-forget by design.** Each hop ends once the other side has accepted the message. There is no long polling and no "wait for the reply" loop — that is what keeps a two-agent relay from deadlocking or burning tokens in circles.

## Components

```
index.js                 DSH host plugin: registers /codex-bridge, token auth, session list/read/prompt
mcp/dsh-bridge-mcp.mjs   MCP server for Codex: dsh_inbox, dsh_ack, dsh_post_message,
                         dsh_list_sessions, dsh_read_session, dsh_wait_reply (blocking, avoid)
scripts/queue-post.mjs   DSH side: enqueue a message for Codex
scripts/notify-codex.mjs DSH side: enqueue + nudge an existing Codex session
scripts/ask-codex.mjs    Optional synchronous ask (spawns a one-shot Codex run)
cordis.patch.yml         DSH plugin mount
```

## Quick start

```bash
# Codex -> DSH: Codex calls the MCP tool
{ "sessionId": "session-...", "text": "done, please review", "replyExpected": false }

# DSH -> Codex (queue only)
node scripts/queue-post.mjs --topic TASK-1 --text "please pick this up"

# DSH -> Codex (queue + nudge the matching Codex session)
node scripts/notify-codex.mjs --cwd /path/to/project --topic TASK-2 --text "..."
```

Full setup, security notes and the Chinese guide: **[README.zh.md](README.zh.md)**.

## Security

- The bridge token and endpoint are generated at first run and stored in `~/.dsh-codex-bridge/`. They are **never** part of this repository and are excluded by `.gitignore`.
- The HTTP endpoint is meant for localhost use. Do not expose it to a network without adding your own authentication and TLS.
- `ask-codex.mjs` starts a separate Codex process. Prefer the queue path unless you genuinely need an answer in the same turn.

## Status

Early prototype. The relay works end to end (verified both directions), but the API surface and the DSH plugin packaging may change.
