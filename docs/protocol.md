本文件：agent-collab 各部件之间的字段级接口契约（桥接发现文件、桥接的 ACP 扩展、执行端适配器接口、统一事件、运行目录文件、CLI 的参数和输出）。实现或测试这些接口时读；字段变化时先改本文再改代码。设计意图和理由见 [PLAN.md](PLAN.md)，本文只定格式。

# 接口契约

> 状态：Claude 2026-10-23 起草，用户同日审阅原样通过【已确认】用户 2026-10-23。标【未验证】的字段依赖 dsh 内部事件的实际形态，S2 实现时按实测修正本文。2026-10-23 已按 S2 实测修正 §2.5、§2.7（dsh 0.2.1-rc.2），用户审阅 diff 后原样通过【已确认】用户 2026-10-23。2026-10-24 按 S3 验收的决定修改 §3 的 `attach`（本轮已结束时带回 `result`）、§5.5 的 `worker_lost`、§6 的 `run cancel`（可取消停下的任务）和 `run wait` 的接上说明【已确认】用户 2026-10-24。2026-10-24 按 S3 实现回填 §4、§5.2、§5.3、§5.5、§5.6、§6，用户审阅 diff 后原样通过【已确认】用户 2026-10-24。2026-10-24 按 S3 推送后 CI 暴露的缺陷修改 §5.3 的 `summary.json`、§5.5 的 `lastActivityAt` 和工作进程何时调用 `start`，用户审阅后通过【已确认】用户 2026-10-24。2026-10-24 按 S3 CI 修复的验收补充 §5.3 收尾后到达的事件、§5.5 `lastActivityAt` 的重置时机和不做卡死检查的时段、§6 `run wait` 返回前等待的对象，用户审阅后通过【已确认】用户 2026-10-24。

## 通用约定

- 协议版本：整数，当前为 `1`。桥接和运行时各自声明支持的范围，在 `initialize` 里协商（PLAN.md D22）。只有不兼容的改动才升版本；新增可选字段不升版本，读取方忽略不认识的字段。
- 所有 JSON 文件都是 UTF-8、对象顶层，带 `v`（本文件格式的版本，当前为 `1`）；由写入方原子写入（同目录临时文件再改名），权限只给本人（POSIX 上目录 0700、文件 0600）。
- 时间一律是 ISO 8601 的 UTC 字符串（`2026-10-23T08:00:00.000Z`）。
- 路径：文件里记录的绝对路径都是 `realpath` 之后的；仓库内的路径用相对仓库根目录、以 `/` 分隔的形式。
- 本文的 `run.mjs` 泛指运行时：`core/run.mjs` 和它启动的工作进程（`core/worker.mjs` 等辅助模块，见 PLAN.md §7.1）。
- 长文本截断：工具输入和输出每个字段最多 8 KiB，超出时截断并在同级加 `truncated: true`。回复文字（`text`）不截断，汇报要从里面提取。

## 1. 桥接发现文件

位置：`$DSH_HOME/agent-collab/bridge-<profile>.json`。由桥接在监听成功后写入，dsh Web 退出时删除。

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | 1 | |
| `host` | string | 固定 `127.0.0.1` |
| `port` | integer | 实际监听的端口 |
| `token` | string | 32 字节随机数的 base64url；每次启动重新生成 |
| `pid` | integer | dsh Web 进程的 PID；客户端发现它不存活时，当作桥接不在线 |
| `protocol` | integer | 桥接支持的最高协议版本 |
| `protocolMin` | integer | 桥接支持的最低协议版本 |
| `bridgeVersion` | string | 桥接包的版本 |
| `dshVersion` | string | 当前 dsh 的版本 |
| `profile` | string | dsh Web 用的 profile |
| `startedAt` | string | |
| `webUrl` | string，可选 | 拿得到时才写（PLAN.md §17 第 19 项） |
| `problem` | string，可选 | 桥接加载了但不能服务（例如 dsh 版本不在支持范围）时写明原因；此时客户端不连接，直接按“桥接不可用”处理 |

## 2. 桥接的 ACP（运行时 ⇄ 桥接）

传输：TCP 回环，换行分隔的 JSON-RPC 2.0。ACP 标准方法的参数和返回字段**以 dsh 依赖里 `@agentclientprotocol/sdk` 的类型定义为准**；本节固定的是 agent-collab 自己的部分（`_meta.agentCollab` 和 `_agentCollab/*` 扩展），以及桥接对标准字段的取值。

### 2.1 错误码

| 码 | 名称 | 什么时候 |
|---|---|---|
| `-32001` | `unauthorized` | `initialize` 的令牌不对或缺失。桥接回这个错误后立即断开 |
| `-32002` | `protocol_incompatible` | 双方协议版本没有交集；`error.data` 为 `{ protocol, protocolMin }` |
| `-32003` | `session_not_found` | `sessionId` 不存在，或不是桥接能接管的会话 |
| `-32004` | `session_busy` | 会话已有一个 `session/prompt` 在进行 |
| `-32005` | `preset_unavailable` | 调用方**明确指定**的工具预设不存在 |
| `-32602` | （标准）参数错误 | 如 `cwd` 不是存在的绝对路径、`env` 的键不以 `DSH_` 开头 |

`initialize` 之前收到任何其他请求，按 `unauthorized` 处理。

### 2.2 `initialize`

请求的 `_meta.agentCollab`：

| 字段 | 说明 |
|---|---|
| `token` | 发现文件里的令牌 |
| `protocol`、`protocolMin` | 客户端支持的协议版本范围 |
| `clientVersion` | 运行时版本 |

客户端在标准字段里声明不支持 `fs` 和 `terminal`。

返回的 `_meta.agentCollab`：

| 字段 | 说明 |
|---|---|
| `protocol` | 协商出的版本：双方上限的较小者 |
| `bridgeVersion`、`dshVersion`、`profile` | 同发现文件 |
| `agentPresets` | `{ available: string[], default: string, agentCollabInSync: boolean \| null }`。`default` 是 `agent-collab`，它不可用时是 `standard`；`agentCollabInSync` 是它和 dsh 自带 `standard`（去掉 `tool-ask-user`）的比对结果，比对不了时为 `null`（PLAN.md §9.5） |

标准字段：声明支持 `session/resume`、`session/close`；图片能力按当前模型声明，判断不了时声明为不支持。

### 2.3 `session/new`

请求：标准的 `cwd`（存在的绝对路径）、`mcpServers: []`，加 `_meta.agentCollab`：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `runId` | string | 必填 | 任务号，如 `T001`；只用于标题和日志 |
| `title` | string | 必填 | 会话标题，桥接原样使用（运行时已拼成 `[collab] T001 <任务名>`） |
| `agentPreset` | string \| null | `null` | `null` 表示用 `initialize` 返回的 `default`；明确指定而不存在时报 `preset_unavailable` |
| `permissionPreset` | `read-only` \| `workspace-write` \| `danger-full-access` | `workspace-write` | 抽象级别，桥接按 PLAN.md §11.9 翻译；桥接模式下审批策略为 `ask`（`danger-full-access` 时为 `never`） |
| `model` | `{ provider, model }` \| null | `null` | `null` 表示用 dsh 当前的默认模型 |
| `reasoningEffort` | string \| null | `null` | 已映射成 dsh 的档位；`null` 表示跟随 |
| `attachWorkspace` | boolean | `true` | 挂到 dsh Web 侧栏对应的工作区下 |
| `env` | `{ [DSH_*]: string }` | `{}` | 注入这个会话的 shell；运行时总会带上 `DSH_AGENT_COLLAB_ROLE: "executor"` |

返回：标准的 `sessionId`、`configOptions`，加 `_meta.agentCollab`：

| 字段 | 说明 |
|---|---|
| `agentPreset` | 实际挂上的预设 |
| `presetFallback` | 改用了别的预设时，`{ from, reason }`；否则 `null` |
| `permission` | `{ sandbox, approval, presetName }`，`presetName` 在表里找不到匹配组合时为 `null` |
| `workspaceId` | `attachWorkspace` 为 false 时为 `null` |
| `model` | 实际使用的 `{ provider, model, reasoningEffort }` |
| `seq` | 会话当前的事件序号 |

### 2.4 `session/resume`

请求：标准的 `sessionId`、`cwd`、`mcpServers: []`，加 `_meta.agentCollab.sinceSeq`（整数，可选）。

- 桥接先把序号大于 `sinceSeq` 的事件按原顺序重新转发一遍（格式同 2.7），**然后**才返回结果；之后继续实时转发。
- 客户端用 `(seq, sub)` 去重。重连时 `sinceSeq` 取已见到的最大 `seq` 减 1，这样即使最后一个事件只收到了一部分，也会完整重发。

返回的 `_meta.agentCollab`：

| 字段 | 说明 |
|---|---|
| `alreadyLoaded` | 会话在桥接进程里本来就活着（`agents.get` 拿到）为 true；新 `agents.resume` 的为 false |
| `running` | 当前有没有正在进行的轮次 |
| `seq` | 当前事件序号 |
| `pendingApprovals` | 等待中的审批，元素同 2.7 的 `approval_pending` |
| `pendingQuestions` | 等待中的提问，元素同 2.7 的 `question_pending` |

### 2.5 `session/prompt`、`session/cancel`、`session/set_config_option`、`session/close`

- `session/prompt`：prompt 只用 `text` 内容块（参考图由执行端按任务书自己用 `read_image` 读）。等根会话和所有子任务都结束才返回。返回标准的 `stopReason`，加 `_meta.agentCollab`：`{ endReason, stoppedBy }`，`endReason` 是 dsh `turn/end` 的 `reason.kind` 原值：`completed`、`aborted`、`blocked`、`error`、`max-tokens`（崩溃恢复和 fork 时还有 `interrupted`、`forked`，补发历史时可能出现）【已验证】2026-10-23，S2 实测并核对 dsh 类型定义。`stoppedBy` 是 `client`（因本连接的 `session/cancel` 结束）、`human`（在 dsh Web 里被停止）或 `null`（不是被停止的）。dsh 的事件分不清这两种停止，都是 `reason: { kind: "aborted", reason: { kind: "user" } }`，所以由桥接判断：本连接发过 `session/cancel` 后以 `aborted` 结束的为 `client`，否则以 `aborted` 结束的为 `human`。`stopReason` 按 `endReason` 换算：`max-tokens` → `max_tokens`，`aborted`、`interrupted` → `cancelled`，其余 → `end_turn`。
- `session/cancel`：标准通知。
- `session/set_config_option`：只支持 `model`、`reasoning_effort` 两个配置项。字段按 ACP SDK：`configId`（配置项名）、`value`（字符串），不是 `optionId`【已验证】2026-10-23，S1 核对 dsh 自带的 `@agentclientprotocol/sdk` 1.4.0。
- `session/close`：释放桥接持有的引用，不删除会话，返回 `{}`。

### 2.6 `_agentCollab/models`（扩展请求）

请求 `{}`；返回 `{ models: [{ provider, model, displayName }], current: { provider, model, reasoningEffort } }`。给 1b 的配置页用，1a 实现但不要求界面。

### 2.7 桥接发给客户端的通知

所有转发的通知都带 `_meta.agentCollab`（标准 `session/update` 放在 update 对象同级的 `_meta` 里）：

| 字段 | 说明 |
|---|---|
| `seq` | 来源 dsh 会话事件的序号；桥接自己产生、没有来源事件的通知为 `null`，不参与补发 |
| `sub` | 同一个来源事件拆出的第几条，从 0 开始 |
| `at` | 来源事件的时间 |

**标准 `session/update`**：

| dsh 事件 | `sessionUpdate` | 备注 |
|---|---|---|
| `assistant/message` 里 `type: "reasoning"` 的内容块 | `agent_thought_chunk` | 每块一条 |
| `assistant/message` 里 `type: "text"` 的内容块 | `agent_message_chunk` | 每块一条，不截断。dsh 0.2.1-rc.2 没有 `assistant/chunk` 事件；逐字增量只在 `agent/assistant-stream` 里，桥接不转发，所以文字按整条消息到达【已验证】2026-10-23，S2 实测 |
| `tool/call` | `tool_call` | `toolCallId` 用 dsh 的 `callId`，`rawInput` 截断 |
| `tool/result` | `tool_call_update` | `status` 为 `completed` 或 `failed`，输出截断 |
| `user/message` | `user_message_chunk` | **只转发人在 dsh Web 里发的消息**，即 `source.kind` 为 `user` 的；并带 `_meta.agentCollab.source: "dsh-web-human"`。经 `session/prompt` 发出的消息不回显；dsh 自己注入的运行时上下文、时间等也是 `user/message`，`source.kind` 不同，不转发【已验证】2026-10-23，S2 实测 |

**扩展通知 `_agentCollab/status`**，参数 `{ sessionId, kind, ...字段, _meta: { agentCollab: { seq, sub, at } } }`：

| `kind` | 字段 | 来源 |
|---|---|---|
| `turn_start` | — | `turn/start` |
| `usage` | `usage: { input, output, cacheRead, cacheWrite }`，拿不到的为 `null` | `assistant/message` 的 `data.usage`，每条助手消息（每一步）一次；dsh 字段 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 依次对应（另有 `totalTokens`、`reasoningTokens`，不转发）【已验证】2026-10-23，S2 实测 |
| `turn_end` | `endReason`、`stoppedBy` | `turn/end`；`stoppedBy` 同 2.5。PLAN.md §9.3 的 `stopped_by_human` 就是 `stoppedBy: "human"` |
| `approval_pending` | `approvalId`、`toolName`、`callId`、`reason` | `approval/asked` |
| `approval_resolved` | `approvalId`、`outcome`（dsh 原值，如 `allowed-once`、`rejected`） | `approval/decided` |
| `question_pending` | `callId`、`questions`（原样，截断） | `ask_user_question` 的 `tool/call` |
| `question_resolved` | `callId` | 同一 `callId` 的 `tool/result` |
| `error` | `message`、`code`（可选） | `agent/error` 或桥接自身的错误 |

桥接进程活着期间，它 `session/new` 或 `session/resume` 过的会话即使没有客户端连着也继续跟踪，补发的 `turn_end` 和实时通知的 `stoppedBy` 相同；只有 `session/close` 后才丢弃这些状态。限制：桥接重启后，补发的历史 `turn_end` 分不清是谁停止的，`stoppedBy` 为 `null`。

## 3. 执行端适配器接口（`core/adapters/*.mjs`）

每个适配器模块导出 `createAdapter({ config, onEvent, log })`，返回下面的对象。`onEvent(event)` 收到的是第 4 节的统一事件**去掉 `n`、`at`、`turn` 之后**的部分，由 `run.mjs` 补齐后写入 `events.jsonl`。

```
capabilities() → { images, structuredOutput, liveView, resume, humanApproval }
start({ cwd, runId, title, brief, images, options, env })
    → { sessionId, transport, model, turn }      turn: Promise<TurnResult>
resume({ sessionId, message }) → { turn }
attach({ sessionId, sinceCursor }) → { attached: boolean, running: boolean, turn?, result? }
                                                  running 为 true 时带 turn；为 false 时带 result: TurnResult
cancel({ sessionId }) → Promise<void>
close() → Promise<void>

TurnResult = { stopReason, endReason, stoppedBy, finalText }
```

- `options` 是 `config.mjs` 按执行端合并好的选项（`model`、`reasoningEffort`、`permissionPreset`、`unattendedApproval`、`agentPreset` 等）。
- `env` 是要注入执行端的变量；dsh 适配器在桥接模式下只传 `DSH_` 开头的键，其他键写一条 `warning` 事件后丢弃。
- `finalText`：本轮最后一步的回复文字，即最后一次工具调用之后的全部 `text` 事件拼起来；本轮没有工具调用时就是全部 `text`。
- `attach` 的 `running` 为 false 表示工作进程不在期间这一轮已经结束：适配器先通过 `onEvent` 补发 `sinceCursor` 之后的事件，再在 `result` 里给出这一轮的 `TurnResult`（`finalText` 按上一条从补发的事件算出）。运行时把它当作正常的一轮结束处理。拿不到结果时不带 `result`。
- 统一事件可以带 `cursor`（适配器自己定义的补发位置，dsh 桥接为 `{ seq, sub }`），`run.mjs` 把最后一个 `cursor` 存进 `state.json`，工作进程重启后传给 `attach`。

## 4. 统一事件（`events.jsonl`）

每行一个 JSON 对象：

| 公共字段 | 说明 |
|---|---|
| `v` | 1 |
| `n` | 本任务内从 1 递增的序号，由 `run.mjs` 分配，不重复、不跳号 |
| `at` | 时间 |
| `turn` | 第几次发给执行端的消息（见 5.4），运行时自己的事件在第一轮之前为 0 |
| `type` | 下表之一 |
| `cursor` | 可选，见第 3 节 |

`v`、`n`、`at`、`turn` 一律由 `run.mjs` 填写，适配器的事件里即使带了也会被覆盖。

| `type` | 字段 |
|---|---|
| `session` | `sessionId`、`executor`、`transport`（`bridge` / `acp` / 其他执行端自定）、`model`、`agentPreset`、`permission`：由 `run.mjs` 在 `start` 返回后写，适配器不发 |
| `thinking` | `text` |
| `text` | `text` |
| `tool_call` | `callId`、`name`、`input` |
| `tool_result` | `callId`、`ok`（布尔）、`output` |
| `usage` | `input`、`output`、`cacheRead`、`cacheWrite` |
| `human_message` | `text`、`source` |
| `approval` | `state`（`pending` / `resolved`）、`approvalId`、`toolName`、`callId`、`reason`、`outcome` |
| `question` | `state`（`pending` / `resolved`）、`callId`、`questions` |
| `turn_end` | `stopReason`、`endReason`、`stoppedBy`：适配器可以发；本轮没有发时，`run.mjs` 按 `TurnResult` 补写，同一轮只写一条 |
| `status` | `from`、`to`、`reason`：任务状态变化，由 `run.mjs` 写 |
| `warning` | `message`：适配器和运行时都可以写；运行时在 `state.json` 写入失败、超过空闲超时、收到 `cancel.request` 时各写一条 |
| `error` | `message`、`fatal`（布尔） |

## 5. 运行目录

### 5.1 位置和编号

- `<AGENT_COLLAB_HOME>/runs/<仓库标识>/<任务号>/`。
- 仓库标识：仓库根目录 `realpath` 的目录名（`[A-Za-z0-9._-]` 以外的字符换成 `_`）+ `-` + 该路径 SHA-256 的前 8 位十六进制。Windows 上先转小写再算哈希。
- 任务号：`T` 加三位以上数字，取已有最大号加 1；用 `mkdir` 建目录，目录已存在就再加 1，保证并发时不重号。

### 5.2 仓库锁 `runs/<仓库标识>/active.lock`

同一仓库同时只有一个运行中的任务（D23）。锁放在仓库这一级，不放在任务目录里，这样“看有没有任务在跑”只需看一个文件。

- 内容：`{ v, runId, pid, phase, createdAt }`，改写时加 `updatedAt`；`phase` 为 `starting`（`run start` 持有）或 `worker`（工作进程持有）。
- 获取：先把完整内容写进同目录的临时文件，再用硬链接（`link`）建成 `active.lock`，已存在即被占用。这样别的进程读到的锁要么不存在、要么内容完整。文件系统不支持硬链接时退回独占复制（`COPYFILE_EXCL`）。
- 被占用：锁里的 `pid` 存活，或锁里任务的 `state.json` 中工作进程的 `pid` 存活。内容读不出来的锁，修改时间在 5 秒内的按被占用处理。
- 打破旧锁：先以独占创建拿到互斥文件 `active.lock.break`（修改时间超过 5 秒的视为遗留，可以删除），重读锁，确认仍是刚才判定无人持有的那一份才删除，然后重新获取。获取总共最多重试 15 秒。
- `run start` 先以自己的 pid 拿锁，启动工作进程后改写为工作进程的 pid；工作进程在任务进入 5.5 节的“停下”或“结束”状态时释放锁。
- `run resume` 重新获取锁。

### 5.3 文件

| 文件 | 写入方 | 内容 |
|---|---|---|
| `state.json` | `run.mjs` | 见 5.5 |
| `baseline.json` | `run start` | `{ v, tree, head, branch, createdAt }`；`head` 在空仓库时为 `null`，`branch` 在分离 HEAD 时为 `null` |
| `brief.md` | `run start` | 任务书，即第 1 轮的消息 |
| `prompt-<n>.md` | `run resume` 或工作进程 | 第 n 轮（n ≥ 2）发给执行端的消息 |
| `report-<n>.json` | 工作进程 | 第 n 轮提取出的汇报；提取失败时为 `{ v, error: { kind, message } }` |
| `patch-<n>.diff` | 工作进程 | 第 n 轮结束时工作区相对基线的补丁（含新建的未跟踪文件）；`run cancel` 按 pid 结束工作进程时，这一轮不写 |
| `events.jsonl` | 工作进程 | 第 4 节 |
| `summary.json` | 工作进程 | 见 5.6；工作进程先写好 `summary.json`，再把终态写进 `state.json`，所以读到终态时它一定已经存在。工作进程开始收尾后到达的执行端事件只记进 `worker.log`，不再写 `events.jsonl` 和 `state.json` |
| `cancel.request` | `run cancel` | 存在即表示要求取消，内容 `{ v, at }`；工作进程定期检查。用文件而不是信号，各平台通用 |
| `worker.log` | 工作进程 | 纯文本日志 |

PLAN.md §8 的表格原先写的是 `correction-<轮次>.md` 和任务目录里的 `lock`，2026-10-23 已按本节改为 `prompt-<n>.md`、仓库级的 `active.lock`，并加上 `cancel.request`：续接的消息不只有问题单，还有对 `blocked` 的答复和重发汇报的要求。

### 5.4 轮次

- `turn`：每发给执行端一条消息算一轮，从 1 开始。`brief.md` 是第 1 轮。
- 每轮有一个 `kind`：`brief`、`correction`（问题单）、`answer`（答复 `blocked`）、`resend`（要求重发汇报，工作进程自动发出，每个汇报最多一次）。
- 上限：`correction` 的轮数不超过 `maxCorrectionRounds`，`answer` 的轮数也单独不超过 `maxCorrectionRounds`（PLAN.md §8 阶段 4）。超过时 `run resume` 拒绝。

### 5.5 `state.json` 和任务状态

| 字段 | 说明 |
|---|---|
| `v`、`runId`、`repoRoot`、`repoId` | |
| `status`、`statusReason` | 状态见下；`statusReason` 是一句说明，可为 `null` |
| `turn`、`turnKind` | 当前（或最后）一轮 |
| `counts` | `{ correction, answer, resend }` |
| `designer` | `{ name, model }`，`model` 可为 `null` |
| `executor` | `{ name, transport, sessionId, model, agentPreset }` |
| `worker` | `{ pid, startedAt }`，没有工作进程时为 `null` |
| `cursor` | 最后一个统一事件的 `cursor`，没有时为 `null` |
| `lastEventN` | `events.jsonl` 里最后一个 `n` |
| `lastActivityAt` | 最后一次收到执行端事件的时间；工作进程发出一轮消息（`start`、`resume`、重发汇报）之前和适配器返回之后、接上会话之后也重置为当时。卡死检测用；工作进程第一次 `start`、`resume` 或 `attach` 完成之前，以及一轮结束后计算补丁、写汇报期间，不做卡死检查 |
| `waiting` | `{ approvals: [approvalId], questions: [callId] }`；任一不空时不计卡死时间 |
| `protectedPaths` | 本任务的受保护路径（相对仓库根目录；以 `/` 结尾表示目录；按字面匹配，不是通配符） |
| `turnKinds` | `{ "<n>": kind }`，每一轮的 `kind`，`summary.turns[].kind` 取自这里 |
| `title` | `--title`，没有时为 `null` |
| `images` | `--image` 的绝对路径，传给适配器的 `start` |
| `taskConfig` | `--set` 解析出的任务级配置；工作进程重启时据此重建配置 |
| `createdAt`、`updatedAt`、`endedAt` | |

状态：

- **进行中**：`starting`、`running`、`waiting_approval`、`waiting_question`。
- **停下**（本轮结束，等设计端处理）：`done`、`partial`、`blocked`（取自汇报的 `status`）、`report_invalid`、`stalled`、`stopped_by_human`、`failed`。设计端可以对这些状态 `run resume`。
- **结束**：`cancelled`。不能再 `resume`。

工作进程只在任务为 `starting`、还没有 `sessionId` 时调用适配器的 `start`。任务已经进行中却找不到 `sessionId`（`state.json` 里没有，`events.jsonl` 里也没有 `session` 事件）时记为 `failed`（`worker_lost`），不再新开会话，避免同一任务出现两个执行端会话。

`failed` 的 `statusReason` 常见值：`worker_lost`（工作进程不在了，`attach` 失败，或接上时这一轮已结束但没有 `result`）、`executor_error`、`transport_unavailable`。

### 5.6 `summary.json`

| 字段 | 说明 |
|---|---|
| `v`、`runId`、`status`、`statusReason`、`repoRoot` | |
| `designer`、`executor` | 同 `state.json` |
| `createdAt`、`endedAt`、`durationMs` | |
| `counts` | 同 `state.json` |
| `turns[]` | `{ n, kind, startedAt, endedAt, stopReason, endReason, stoppedBy, report: "valid" \| "invalid" \| "missing", reportFile, patchFile, usage }` |
| `report` | 最近一次合法的汇报对象，没有时为 `null` |
| `reportError` | 最近一轮汇报提取失败的 `{ kind, message }`，否则为 `null` |
| `changes` | `{ files: [{ path, change: "A" \| "M" \| "D" \| "R", from?, added, deleted }], stat }`：最近一轮补丁的改动统计，`stat` 是类似 `git diff --stat` 的文字；工作进程被 `run cancel` 按 pid 结束时，由 `run cancel` 对基线重新计算 |
| `violations[]` | `{ kind, path?, detail }`，`kind` 为 `protected_path`、`head_moved`、`branch_changed` |
| `humanInputs[]` | `{ at, turn, text }` |
| `approvals[]` | `{ approvalId, turn, toolName, reason, outcome, askedAt, decidedAt }` |
| `questions[]` | `{ callId, turn, questions, askedAt, resolvedAt }` |
| `usage` | 所有轮次的合计，字段同统一事件的 `usage` |
| `warnings[]` | 字符串，如退回 acp 的提醒、同一工具担任两端的提示 |
| `lastActivityAt` | |

## 6. CLI（`bin/collab.mjs`）

- 调用方式：`node <插件目录>/bin/collab.mjs <命令> …`。1a 只有开发模式：启动器加载它自己所在仓库的 `core/`。
- 公共参数：`--repo <路径>`，默认当前目录；运行时用 `git rev-parse --show-toplevel` 求仓库根目录。
- `run` 子命令和 `doctor --json` 在标准输出打印**一个** JSON 对象（`watch` 例外），成功时 `ok: true`，失败时 `ok: false` 加 `error: { code, message }`。
- 退出码：`0` 成功；`1` 运行出错；`2` 用法错误；`3` 被拒绝（`error.code` 说明原因）；`4` 找不到任务。

| 命令 | 参数 | 成功时的输出 |
|---|---|---|
| `run start` | `--brief <文件>`、`--title <任务名>`、`--designer <名称>`（可选，skill 按设计端渲染时写死，如 `claude`；用来选默认执行端和记录 `designer`）、`--designer-model <模型>`（可选）、`--executor <名称>`（可选；没有它也没有 `--designer` 时报用法错误）、`--protected <路径>`（可重复，与配置里的 `protectedPaths` 合并）、`--image <文件>`（可重复）、`--set <键>=<JSON 值>`（可重复，单个任务级配置；键可以是点号路径，如 `executors.dsh.model`；值不是合法 JSON 时按字符串） | `{ ok, runId, runDir, status: "starting", workerPid }`，立即返回 |
| `run wait <任务号>` | `--timeout <秒>`（可选） | 任务进入“停下”或“结束”状态后，等工作进程退出（包括这次 `run wait` 自己启动的那个）、本任务的仓库锁释放（各最多再等 3 秒）再返回 `{ ok, runId, status, statusReason, summaryFile, patchFile, reportFile }`，`patchFile`、`reportFile` 指最后一轮的文件，不存在时为 `null`；超时返回 `{ ok, runId, status, timedOut: true }`，退出码 0 |
| `run status [任务号]` | `--all`（所有仓库） | 有任务号：`{ ok, run: <state.json>, workerAlive }`；没有：`{ ok, runs: [{ runId, repoRoot, status, turn, updatedAt, workerAlive }] }`，只列未“结束”的任务；不带 `--all` 且当前目录不是 git 仓库时 `runs` 为空 |
| `run resume <任务号>` | `--message <文件>`、`--kind correction \| answer` | `{ ok, runId, turn, status: "starting", workerPid }` |
| `run cancel <任务号>` | — | 进行中的任务：工作进程确认后返回 `{ ok, runId, status: "cancelled" }`；10 秒内没确认就结束该工作进程（按 `state.json` 里的 pid），状态记为 `cancelled`，`statusReason` 注明。停下的任务（含等待确认期间自己停下的）：不结束任何进程，直接记为 `cancelled`，`statusReason` 写明取消前的状态，`state.json` 和 `summary.json` 只改 `status`、`statusReason`、`endedAt`（`summary.json` 还没写出时，先按事件和基线补一份）。已是 `cancelled` 的直接返回成功 |
| `watch <任务号>` | `--from <n>`（从第 n 个事件开始，默认从头） | 逐行打印里程碑（格式见下），任务进入“停下”或“结束”状态后退出 |
| `doctor` | `--json`、`--deep` | 见下 |

拒绝的 `error.code`：

| `code` | 命令 | 情况 |
|---|---|---|
| `executor_role` | `run start`、`run resume` | `AGENT_COLLAB_ROLE` 或 `DSH_AGENT_COLLAB_ROLE` 为 `executor`（PLAN.md §11.4） |
| `not_git` | `run start` | 不是 git 仓库 |
| `lock_held` | `run start`、`run resume` | 本仓库已有进行中的任务；`error.data` 为 `{ runId, status, pid }`，锁的内容读不出来时为 `null` |
| `round_limit` | `run resume` | 该 `kind` 的轮数已到上限 |
| `not_resumable` | `run resume` | 任务处于“进行中”或“结束”状态 |

其他 `error.code`：

| `code` | 退出码 | 情况 |
|---|---|---|
| `usage` | 2 | 参数错误、未知命令 |
| `run_not_found` | 4 | 找不到任务（`run` 子命令和 `watch`） |
| `ambiguous_run` | 1 | 没有指定仓库，同一任务号在多个仓库下都存在；用 `--repo` 指定 |
| `brief_unreadable` | 1 | `run start` 读不到 `--brief` 文件 |
| `message_unreadable` | 1 | `run resume` 读不到 `--message` 文件 |
| `executor_unavailable` | 1 | 找不到或加载不了执行端适配器 |

意料之外的错误退出码为 1，`code` 可能是别的字符串（如 `GIT_FAILED`）。有任务号的命令先在当前仓库里找，找不到再在所有仓库里找。

`run wait` 发现任务处于“进行中”而工作进程不在了：先启动一个新的工作进程，用 `attach` 接上执行端会话；这一轮已经结束时按 `attach` 带回的 `result` 结束这一轮；接不上或没有 `result` 就把任务记为 `failed`（`worker_lost`）再返回。

`watch` 的行格式：`[T001 08:00:00] <内容>`，时间为本地时间。打印这些事件：`status` 变化、`tool_call`（工具名加一个简短的目标，如文件路径或命令的前 80 个字符）、`approval`、`question`、`human_message`、`turn_end`、`warning`、`error`；`thinking`、`text`、`usage` 不打印。

`doctor --json` 的输出：`{ ok, checks: [{ id, level, ok, message }], git, dsh, activeRun }`。

- `level` 为 `error`（跑不了任务）、`warn`、`info`；`ok` 为 false 且 `level` 为 `error` 的项存在时，顶层 `ok` 为 false。
- `git`：`{ isRepo, root, head, branch, dirty: [路径] }`，供设计端做 D10 的预检。
- `dsh`：`{ command, version, home, profile, webRunning, bridge: { online, discoveryFile, protocol, bridgeVersion, problem }, agentPresets }`。
- `activeRun`：本仓库进行中的任务 `{ runId, status }`，没有时为 `null`，供 D23 的预检。
- 1a 的检查项只有：Node 和 git 的版本、是否 git 仓库、工作区是否干净、dsh 的位置和版本、dsh Web 是否在运行、桥接是否在线和协议是否兼容、`agent-collab` 预设是否可用、本仓库有没有进行中的任务。
