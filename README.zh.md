# DSH ⇄ Codex 消息接力

让 Codex 和 DSH 互相投递消息，**发完就结束，不保持等待**。

核心约定：每一跳都是单向投递。发送方写进对方能取到的地方就返回，自己的 turn 到此为止；接收方下次运行时来取。没有长轮询，没有「等回复」。

## 安装

1. 把本仓库放到任意目录，记为 `$BRIDGE`。
2. 在 DSH 的 profile（如 `~/.dsh/profiles/desktop/package.json`）里加入本地依赖并挂载：

   ```json
   {
     "dependencies": { "@local/dsh-codex-bridge": "link:$BRIDGE" },
     "dsh": { "profile": { "bundles": ["@local/dsh-codex-bridge"] } }
   }
   ```

3. 在 `~/.codex/config.toml` 注册 MCP：

   ```toml
   [mcp_servers.dsh]
   command = "node"
   args = ["$BRIDGE/mcp/dsh-bridge-mcp.mjs"]
   startup_timeout_sec = 20
   ```

4. 重启 DSH，让 Host 插件注册 `/codex-bridge` 路由；新建一个 Codex 会话，让它加载 MCP。

> 首次运行会在 `~/.dsh-codex-bridge/` 下生成 `token` 与 `endpoint`，两者都是本机凭据，**不要提交**。仓库已用 `.gitignore` 排除。

下文命令里的 `D:/deepseek-harness/default-workspace/codex-bridge` 是作者本机路径，请替换为你的 `$BRIDGE`。

## 两种投递方向

| 方向 | 通道 | 谁取 |
| --- | --- | --- |
| DSH → Codex | 本地队列文件 `~/.dsh-codex-bridge/queue/` | Codex 启动时调 `dsh_inbox` |
| Codex → DSH | HTTP 投递到 DSH 会话 | DSH 进程内自动开始跑 |

DSH 常驻，所以 Codex 投过去它会自己跑；Codex 是按需启动的，所以 DSH 投过去只是入队，等 Codex 下次来取。

## 用法

### DSH 发给 Codex（入队，立即返回）

```bash
node D:/deepseek-harness/default-workspace/codex-bridge/scripts/queue-post.mjs \
  --topic DSH-007 \
  --text "DSH-007 收尾已复核通过，共享 TODO 标记完成。六项修订均已核对。"
```

参数：

- `--topic`：主题，Codex 侧用来过滤（默认 `default`）
- `--expect-reply`：标记「这条需要对方回」，默认 false。**这是防死循环的开关**，没有它相方会互相唤醒到天亮
- `--file <path>`：从文件读正文，长文本用这个
- `--list`：查看队列里还有什么

### DSH 发给 Codex 并提醒（推荐，不启动新进程）

`queue-post.mjs` 只写文件，Codex 不启动就看不到。`notify-codex.mjs` 在此基础上
再往**既有 Codex 会话的输入队列**投一条「去取消息」的提醒：

```bash
node D:/deepseek-harness/default-workspace/codex-bridge/scripts/notify-codex.mjs \
  --topic DSH-008 \
  --text "公共商品样例已更新，请按最新字段实现 B03。" \
  --cwd D:/123/Food-Delivery-WeChat-Progrom
```

- `--cwd`：用来匹配该项目的 Codex 会话（默认当前目录）
- `--session <id>`：直接指定 Codex 会话，跳过匹配
- `--queue-only`：只入队，不发提醒（等同 `queue-post`）
- `--dry-run`：只显示会写哪个队列文件、会提醒哪个会话

它**不使用 `codex exec`**，不会拉起新的 agent 进程；`codex queue` 只是把消息放进
既有会话的待处理队列。Codex 正在运行时会被唤醒，不在运行时消息仍留在磁盘队列里。

> **前提**：目标 Codex 会话必须已经加载本插件的 MCP 工具 `dsh_inbox` / `dsh_ack`。
> 会话在 MCP 配置**之前**创建时不会自动加载，需要重启该 Codex 会话。
> 会话里看不到这两个工具时，提醒仍会送达，但 Codex 无法取队列。

脚本位置：`scripts/notify-codex.mjs`。

### 多会话隔离（scope）

同一台机器上可能有多个 Codex 会话各管一摊事。队列按 **scope** 分目录，互不可见：

```
~/.dsh-codex-bridge/queue/
  backend/   ← 后端业务会话
  ui/        ← 测试控制台会话
  default/   ← 旧版无 scope 的消息
```

发送时指定 scope 与目标会话：

```bash
# 发给后端会话（默认 scope=backend）
node scripts/notify-codex.mjs --topic B06 --text "..." --cwd /path/to/project

# 发给控制台会话（scope=ui，读 codex-session-ui 里的会话 id）
node scripts/notify-codex.mjs --purpose ui --topic CONSOLE-1 --text "..."
```

接收方必须带同一个 scope，否则读不到（读别的 scope 也是空）：

```json
{ "name": "dsh_inbox", "arguments": { "scope": "ui" } }
{ "name": "dsh_ack",   "arguments": { "ids": ["..."], "scope": "ui" } }
```

- `--purpose ui` 会读 `~/.dsh-codex-bridge/codex-session-ui` 作为目标会话，并写入 `queue/ui/`。
- 不传 `--purpose` 时 scope 为 `backend`，目标会话读 `codex-session`。
- 旧的无线程目录消息仍可按 `scope=default` 读取，不会丢。
- **scope 是硬隔离**：控制台会话拿不到后端任务，反之亦然。

### 会话固定文件

| 文件 | 用途 |
| --- | --- |
| `~/.dsh-codex-bridge/codex-session` | 默认会话（后端业务） |
| `~/.dsh-codex-bridge/codex-session-ui` | 控制台专用会话 |

优先级：`DSH_CODEX_SESSION` 环境变量 > `--session` 参数 > 对应 purpose 的文件 > 默认文件 > 按 cwd 自动匹配。

### Codex 取 DSH 投来的消息

Codex 一启动会先调 `dsh_inbox`（MCP 的 `initialize` 里已经写了这条指令）。取到的消息标记为 `delivered` 但留在队列里，处理完用 `dsh_ack` 归档，不会丢。

### Codex 发给 DSH（投递，立即返回）

工具 `dsh_post_message`：

```json
{ "sessionId": "session-...", "text": "【DSH-007 关闭通知｜Codex → DSH】...", "replyExpected": false }
```

HTTP 层实测 **142ms 返回** `mode: "queued"`，Codex 这个 turn 可以立刻结束。DSH 在它自己的进程里跑完这一轮。

## MCP 工具清单

| 工具 | 是否阻塞 | 用途 |
| --- | --- | --- |
| `dsh_inbox` | 否 | 取队列里的待处理消息 |
| `dsh_ack` | 否 | 处理完归档 |
| `dsh_post_message` | **否** | 投递给 DSH，立即返回 |
| `dsh_list_sessions` | 否 | 列 DSH 会话 |
| `dsh_read_session` | 否 | 读会话历史（只读） |
| `dsh_wait_reply` | 是（最多 600s） | 确实需要在同一轮拿到回答时才用 |

`dsh_wait_reply` 故意做得不显眼：默认流程里不该用它。用它就等于退回了「请求-响应」，接力链会卡住。

## 一次完整的接力的样子

```
DSH   ──queue-post──▶  queue/DSH-007.json          （DSH turn 结束）
Codex ──dsh_inbox────▶  取到消息，处理
Codex ──dsh_post_message──▶ DSH session             （Codex turn 结束）
DSH   ──跑完这一轮，必要时再 queue-post──▶ queue/   （DSH turn 结束）
```

每一跳结束的位置都是「对方已经拿到，或者已经进了队列」，没有人挂在等待里。

## 队列文件长什么样

`~/.dsh-codex-bridge/queue/<id>.json`：

```json
{
  "id": "q-1792499547644-qy23k9",
  "topic": "DSH-007",
  "from": "dsh",
  "to": "codex",
  "at": 1792499547644,
  "text": "消息正文",
  "replyExpected": false,
  "status": "pending"
}
```

`status`: `pending` → `delivered`（被 dsh_inbox 取过）→ 归档到 `done/`。

## 同步模式（备用）

确实需要「问一句、当场等一句」时用：

```bash
node D:/deepseek-harness/default-workspace/codex-bridge/scripts/ask-codex.mjs "问题" [--cwd DIR]
```

它会阻塞到 Codex 跑完并打印最终回答。**默认工作流不要用它**。

## 已知限制

1. **Codex 没有常驻进程。** 所以 DSH 投过去的消息不会「推」给 Codex，只能等 Codex 下次启动来取。想让它自动跑，就得用 `codex exec resume` 拉起一个新进程，那是另一种选择，当前没开。
2. **队列是全局的，不是按 Codex 会话隔离的。** 用 `--topic` 区分主题；同 topic 的多条消息按投递顺序排。
3. **插件改动要重启 DSH**（或者用 `plugin_manager` 把 `include:codex-bridge` 关掉再打开）。MCP server 是每次 Codex 启动新起的，改完立即生效。
4. Codex 侧的 `dsh_post_message` 如果 DSH 没在跑会直接报错，不会悄悄进队列——这是有意的，避免消息「消失在没人取的地方」。
