# agent-collab 方案

> 状态：设计已定稿，尚未实现。2026-10-23 完成第 0 阶段；同日确定了 1a 实现的 7 个决定（自写 ACP、覆盖层的 YAML 解析、接口契约单列为 `docs/protocol.md`、测试用假 LLM 服务、辅助模块、项目级配置的限制等，见 7.1、9.4、11.5、12.2、附录 B）；第 1a 阶段技术验证第 1 批（第 17 节第 1、2、3、6、7、12、18 项）的结论已回填本文；Claude 侧（第 8、16、17 项）和第 2 批（第 4 项）的结论也已回填，1a 的技术验证完成（Desktop 里插件相关的验证并入 T20，Windows 的验证放到第 2 阶段）。
> 来源：2026-10-23 的设计讨论。同日复查时对照 dsh 源码更正了两处事实（权限预设、提问工具），并补充了 D20–D23 和相关细节（D20–D23 已经用户确认）。
> 本文描述的是**通用产品**的设计，不针对某一台机器。所有和环境有关的信息（工具装在哪、用哪家模型服务商、端口、磁盘类型等）都靠运行时探测和配置获得。
> 关于 dsh 行为的事实，依据是 dsh 0.2.1-rc.2 的源码、文档和一台 Linux 开发机上的实测（实测记录见附录 A）。实现时如果发现 dsh 新版本的行为不同，以实际情况为准，并回头更新本文。

## 1. 目标

让多个编程代理分工协作，分成两种角色：

| 角色 | 职责 | 谁能担任 |
|---|---|---|
| **设计端**（主控） | 读代码、写任务书、派发、审查改动、自己重跑检查、写问题单、最终汇报 | 第 1 阶段只有 Claude（Claude Code）；第 3 阶段加上 dsh、codex |
| **执行端** | 按任务书改代码、跑测试、按格式汇报 | 第 1 阶段是 dsh（DeepSeek Harness）；第 2 阶段加上 codex、claude |

硬性要求：

1. 做成 **Claude Code 插件**，参数可以**可视化调整**。
2. **通用、跨平台**：在任何人的 Linux、Windows 机器上都能用（macOS 尽量支持），也能在其他工具上复用。
3. 执行端保留 **dsh、codex、claude** 三种，可在配置中切换。
4. 能**实时查看两边的进度和对话**：dsh 的会话要能在 dsh Web 里原生实时显示。
5. **一次安装，各处可用**：在 Claude 里装好插件后，本机已有的 dsh、codex 等需要的部件一并装好，不用每个工具分别安装。
6. **角色可互换**：设计端和执行端可以任意搭配，按需要选择。

不做的事：

- 不支持跨机器：设计端、执行端、dsh Web 必须在同一台机器、同一个系统环境里（WSL 和 Windows 算两个环境）。
- 不做多用户共享，也不做托管服务。
- 不替代 dsh Web 的对话界面：看板只显示任务层面的信息。
- 不自动推送、合并或发布代码。
- 不写入任何模型服务商配置（D19）。
- 不收集使用数据。

## 2. 设计原则

1. **探测，而不是假设**。工具装在哪、什么版本、用哪个 profile、端口多少，全部在运行时探测；探测不到或用户想改的，都可以在配置里指定。代码里不写死任何路径、端口或机器相关的值。
2. **跟随各工具自己的配置**。用哪家模型服务商（官方 API、自建网关、第三方网关……）、API key 放在哪，都由用户在各工具里自己配置；agent-collab 只读不写。
3. **部件可选**。本机只有部分工具也能用：比如没装 dsh 就不装桥接，只用 codex 或 claude 当执行端。
4. **对其他工具最小侵入**。只安装自己的插件或 skill，不改用户和其他工具的配置；装过的东西全部记录在案，可以一键卸载。
5. **跨平台用同一套代码**。核心代码只用 Node.js 内置模块；平台差异（路径、进程管理、沙箱、命令包装）集中在少数几个地方处理。
6. **出问题能看清**。`doctor` 和配置页显示每个部件的实际状态，包括每个执行端实际会用的端点和模型。

## 3. 已定的决策

| # | 问题 | 决定 |
|---|---|---|
| D1 | 形态 | 共享运行时 `~/.agent-collab/` 存放所有实际代码；各工具里只放一层很薄的入口：Claude Code 插件、dsh 桥接插件，以后还有 dsh 和 codex 的 skill |
| D2 | 流程蓝本 | 参考 [ozankasikci/sol-skill](https://github.com/ozankasikci/sol-skill)（MIT）的流程、任务书模板和汇报格式，执行端换成可插拔的适配器 |
| D3 | 脚本语言 | Node.js（≥ 20）。不需要 `npm install`：只用内置模块；确实需要第三方代码时随仓库附带（目前没有：ACP 是自写的精简实现，见 9.4）。Windows 上没有原生 bash，Python 也不一定有；dsh 本身就依赖 Node。Node 不在时，安装流程会说明怎么装 |
| D4 | dsh 的实时查看 | 写 dsh 桥接插件，任务在 dsh Web 进程里跑，会话原生显示在 dsh Web 侧栏对应工作区下 |
| D5 | 桥接协议 | **ACP 兼容**（Agent Client Protocol v1），DSH 特有信息走 ACP 的 `_meta` 字段和带下划线前缀的扩展方法 |
| D6 | 权限 | 可配置。默认"只能写工作区 + 越权操作由人批准"。只有 dsh 走桥接时有人能批准（在 dsh Web 里）；其他情况都是无人值守，默认拒绝（见 11.9） |
| D7 | dsh Web 没开时 | 自动后台启动 dsh Web（是否同时打开浏览器可配置） |
| D8 | pnpm | 只有安装 dsh 桥接时才需要。优先用 Node 自带的 corepack：`corepack enable pnpm`；不可用时改用 `npm i -g pnpm` |
| D9 | 配置的可视化 | 一份 schema 描述所有配置项，界面从 schema 自动生成。本地配置页在第 1b 阶段提供（1a 阶段手动编辑配置文件），dsh Web 里的入口放到后面 |
| D10 | 非 git 目录 | 停下来问用户是否 `git init`。工作区有未提交改动时，让用户选：提交、暂存（stash）或取消 |
| D11 | 执行端遇到问题 | 执行端不直接问人，按任务书停下来汇报 `blocked`。设计端能答的就答，涉及产品决策的再问用户 |
| D12 | 用户在 dsh Web 里插话 | 一律视为补充需求：桥接转给设计端，设计端据此更新验收标准，并在汇报中注明 |
| D13 | 成本 | 思考强度默认覆盖为 `high`（也可以设为"跟随工具自己的设置"）；当前模型不支持调思考强度时自动改为跟随，并在 `doctor` 里注明。单个任务的 token 上限默认不设，但显示用量 |
| D14 | 并行 | 第 1 阶段同一仓库一次只跑一个任务（D23）；多任务并行（每个任务一个 git worktree）放到后面 |
| D15 | 发布方式 | 源码托管在 Git 仓库，通过 Claude Code 插件市场分发（GitHub 或本地目录都可以作为市场）。产品对安装位置没有要求；开发期的仓库位置见附录 B |
| D16 | 一次安装 | 从任意一个工具触发安装，自动检测本机装了哪些工具，把各工具需要的部件一并装好 |
| D17 | 安装确认 | **首次安装确认一次**（列出每个工具要装什么），之后插件升级时**自动同步**。只有出现新的部件类型、或检测到新装的工具时，才再确认一次 |
| D18 | 角色可互换 | 设计端和执行端可以任意组合，包括同一个工具同时担任两端（另开会话）。每个设计端有默认执行端，单个任务可以临时指定 |
| D19 | 模型服务商 | **不假设任何特定的服务商或网关**。各执行端默认沿用它自己的模型配置；agent-collab 只在用户明确指定时覆盖模型，思考强度按 D13 处理，**从不写入服务商配置** |
| D20 | 任务进程 | `collab run start` 启动一个独立的后台工作进程，由它连接执行端、写运行目录，然后立即返回任务号。设计端用 `collab run wait` 等结束，用 `watch.mjs` 看进度。设计端会话关闭或重启，任务照常进行，新会话用 `collab run status` 找回。已实测：用 `detached` 加 `unref` 启动的进程，在终端 `claude -p` 退出、Desktop 删除会话后都继续运行（Linux）；Bash 工具的 `run_in_background` 会让 `claude -p` 等它结束，不能用来跑工作进程 |
| D21 | 改动基线 | 派发时给工作区拍一个快照作为基线，包括未跟踪文件，不包括被忽略的文件。做法是用临时 index 生成 git tree 对象：不改分支、不写 ref、不动用户的 index。补丁就是当前工作区相对快照的差异，所以设计端预先写的验收测试、用户原有的未跟踪文件，都不会算成执行端的改动 |
| D22 | 版本 | 插件、运行时、桥接用同一个版本号；另设一个整数的协议版本，在 `initialize` 里协商。运行时已升级、桥接还没更新时（比如任务正在跑，同步被推迟），只要协议版本兼容就照常用；不兼容就退回 acp 并提示 |
| D23 | 并发和原子性 | 同一仓库同时只允许一个运行中的任务：运行目录里加锁，持锁进程不在了锁自动失效。安装和同步加全局锁，先装到临时目录再改名，中途失败不会留下半套运行时 |

## 4. 适用环境和前提

### 4.1 平台

| 平台 | 支持程度 | 说明 |
|---|---|---|
| Linux | 完整支持 | 开发和第 1 阶段验收都在这里做 |
| Windows | 完整支持 | 第 2 阶段验收；注意事项见 14.7 |
| macOS | 尽量支持 | dsh 用 Seatbelt 做沙箱；不单独设阶段，有条件时验证 |

### 4.2 前提

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| Node.js ≥ 20 | 必需 | 共享运行时用。Claude Code、codex 可能是原生二进制，不自带 Node，所以不能假设一定有；`/collab-setup` 检测不到时会说明怎么装 |
| git | 必需 | 验收靠它看改动和回滚 |
| 至少一个执行端 | 必需 | dsh、codex、claude 任意一个 |
| dsh Web | 用 dsh 当执行端时建议有 | 没开时自动启动；不可用时退回 acp 模式，但看不到实时会话（11.5） |
| pnpm | 只有安装 dsh 桥接时需要 | 见 D8 |

### 4.3 要在运行时探测的东西

| 探测项 | 方法 | 可在配置里覆盖 |
|---|---|---|
| 各执行端 CLI 的位置和版本 | 在 PATH 上查找，执行 `--version` | `executors.<名称>.command` |
| dsh 的安装目录 | 从 PATH 上的 `dsh` 解析出入口文件，再推出包目录（不同机器可能在全局 npm、nvm、Volta 等不同位置） | — |
| `DSH_HOME` | 依次看：配置、设计端环境里的 `DSH_HOME`、登录 shell 环境里的 `DSH_HOME`；都没有就用 dsh 的默认值 `~/.dsh`。设计端（比如 Desktop）的环境不一定带着用户在 shell 里设的变量，所以要查登录 shell | `dsh.home` |
| dsh 用哪个 profile 跑 Web | 默认 `web` | `dsh.profile` |
| 工作区根目录 | `git rev-parse --show-toplevel`。从子目录发起时，执行端的工作区仍是仓库根目录 | — |
| dsh Web 是否在运行、桥接是否在线 | 读桥接写出的发现文件，并检查进程 | — |
| 各执行端实际会用的端点和模型 | 读各工具自己的配置；必要时做一次很小的试调用 | `model`、`env` |
| 平台和 shell | `process.platform` 等 | — |

## 5. dsh 关键事实

下面的路径里，`<dsh包目录>` 指 dsh 安装目录下的 `node_modules/@deepseek-ai/`，由 4.3 的方法探测得到。各包都有 `README.zh.md`。

### 5.1 headless 模式（`dsh-headless`）

- 命令：`dsh --profile headless [--json] [--session-id <id>] <任务 | ->`，用 `-` 时从 stdin 读任务。
- `--json` 的事件：
  - 开头一行 `session`（带 `sessionId`、`cwd`）。
  - 中间有 `status`（`phase` 取 `turn_start` / `step_start` / `step_end`（带 `usage`）/ `turn_end`（带 `reason.kind`））、`thinking`、`text`、`tool_call`（`callId`、`tool`、`input`）、`tool_result`（`callId`、`status`、`result`）。
  - 正常结束是一行 `final`（`text`）；出错是 `error`，没有 `final`。
  - 除 `final` 外，单个字符串最长 8KiB；`text` 和 `thinking` 按步提交，不是逐字推送。
- 退出码：0 表示完成，1 表示中止或出错。
- `--session-id` 要求在同一工作目录下，而且不能被其他进程占用。
- **实测发现的问题**（详见附录 A）：
  - headless 创建的会话在 dsh Web 里不会实时刷新，运行中还会被误显示为"已停止"。
  - **在 dsh Web 里打开这个会话后，Web 会占住它的写锁，之后 `--session-id` 续接失败**。
  - 这就是 D4 要写桥接插件、不用 headless 的原因。
- 运行器源码 `dsh-headless/lib/index.js` 是"在插件里驱动会话"的最好参考（见 5.4）。

### 5.2 沙箱、审批和工具

- 权限模式由环境变量 `DSH_PERMISSION_MODE` 控制，可选 `read-only`、`workspace-write`（默认）、`danger-full-access`。前两种模式下，超出范围的操作需要人批准；最后一种不做限制，也不弹审批。
- 会话的权限由两个开关组成：沙箱（`read-only` / `workspace-write` / `danger-full-access`）和审批策略（`ask` 交给人或其他应答者，`never` 直接拒绝）。
  - dsh 的"权限预设"（`dsh-permission-presets`）只是给开关组合起名字的一张表，0.2.1-rc.2 的默认表（`dsh-base` 的 bundle 补丁）有三项：`read-only`（沙箱 read-only + 审批 ask）、`workspace-write`（沙箱 workspace-write + 审批 ask）和 `danger-full-access`（沙箱 danger-full-access + 审批 never）。【已验证】2026-10-23，S2 集成测试在临时 profile 里拿到 `read-only`，Claude 核对 dsh 源码。
  - 用户可以改这张表，所以不能假定哪个名字存在。开关组合不匹配任何预设时，Web 里显示为 `custom`。
- 每次审批都会在会话日志里记两条事件：`approval/asked`（发出请求）和 `approval/decided`（结果）。
- `workspace-write`：只能写工作区和临时目录；**网络不受限**；家目录只读，所以写 `~/.npm`、`~/.cache` 这类缓存会失败。可以通过环境变量把缓存重定向到临时目录或工作区内。
- 各平台的隔离方式：
  - Linux：优先用 bwrap，Landlock 作为后备。
  - macOS：Seatbelt。
  - Windows：用文件权限（ACL）做沙箱，限制写和删，不限制读、网络和进程。隔离只是部分生效，并且会在工作区目录上**长期留下一个低完整性标记**（之后其他低完整性进程也能写这个目录），要写进用户文档。
  - 没有可用的隔离手段时，命令直接失败，不会在不受限的情况下运行。
- **没有人能回答审批时（比如 headless），需要审批的操作直接拒绝**，不会卡住。
- bash 工具：前台命令超时后会自动转为后台任务，不会被杀。
- `read_image` 工具（`dsh-tool-fs`）支持 PNG、JPEG、WebP、GIF。它需要附件存储（`dsh-base` 已包含）和支持图片输入的模型。**服务商或网关是否真的把图片转发给模型，取决于用户的配置**，要按执行端检测（见 T11）。

### 5.3 dsh 会读哪些规则文件和 skill

- 规则文件：`$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）、`~/.agents/AGENTS.md`，以及项目根目录到工作目录之间每一层的 `AGENTS.md`、`CLAUDE.md`（外加 `.local` 变体）。**它读不到设计端的记忆，也看不到对话内容**，所以安全规则仍要抄进任务书。
- skill 扫描目录：`<项目>/.dsh/skills`、`<项目>/.agents/skills`、自定义目录、`$DSH_HOME/skills`、`~/.agents/skills`。
- SKILL.md 的 frontmatter 字段 `name`、`description`、`disable-model-invocation`、`user-invocable` 与 Claude Code 兼容。

### 5.4 在 dsh 插件里驱动会话

依据是 headless 运行器源码和 ccteam 的 `dsh-plugins/ccteam-ui/src/transport.ts`。dsh 插件是 cordis 插件，导出 `name`、`inject`、`Config`、`apply(ctx, config)`。

| 服务 | 用法 |
|---|---|
| `agents` | `create({ sessionId, meta: { cwd, agentPreset? }, agentOptions, setup })`、`resume({ resumeSessionId, agentOptions, setup })`、`get(id)` |
| agent | `followup(createUserMessage(...))` 发消息，`whenIdle()` 等空闲，`cancel({ kind: 'user' })` 取消，`status`，`session.seq` / `session.eventAt(seq)`。dsh 的 dsh-session 文档把 `eventAt`、`snapshotEvents` 标为“新的生产代码禁止调用”，桥接目前仍用 `eventAt` 补发（风险见 [RISKS.md](context/RISKS.md) R8） |
| 事件 | `ctx.on('session/event', (session, event) => …)`，事件类型有 `turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`；`ctx.on('agent/assistant-stream', …)` 推送逐字的增量（`frame.chunk.type` 为 `text-delta`、`reasoning-delta`）；`ctx.on('agent/error', …)`。实测（S2，0.2.1-rc.2）：没有 `assistant/chunk` 事件（旧格式，只在迁移代码里出现），回复文字和思考是 `assistant/message` 的 `data.message.content` 里 `type` 为 `text`、`reasoning` 的块，用量在同一事件的 `data.usage`（`inputTokens`、`outputTokens`，可选 `totalTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`）；dsh 会把运行时上下文、时间等也作为 `user/message` 注入，人发的消息是 `source.kind` 为 `user` 的那些；`turn/end` 的 `reason.kind` 有 `completed`、`aborted`、`blocked`、`error`、`max-tokens`，崩溃恢复和 fork 时还有 `interrupted`、`forked`；人在 Web 里停止和插件调用 `cancel({ kind: 'user' })` 产生的 `turn/end` 相同，都是 `{ kind: 'aborted', reason: { kind: 'user' } }` |
| `agentPresets` | `mount(agentCtx, id)`。**dsh Web 禁用了全局工具，bash、读写文件等都挂在工具预设后面，不挂预设的会话一个工具都没有。** 内置预设有 `standard`、`ptc`、`minimal`、`cordis`（实测）。`mount` 是异步方法，返回 `{ id }`。**`agents.create` 不会自动挂预设**（dsh Web 自己的会话控制器是在 setup 里调用 `mount`），桥接必须在 setup 里显式调用。新增工具预设的方式，是在 bundle 补丁里插入一行 `@deepseek-ai/dsh-agent-preset`，写出完整的插件列表（没有继承或派生语法，见 9.5） |
| `permissionPresets` | `set(session, name)`：按预设名同时设沙箱和审批，名字不在预设表里会报错。要设表里没有的组合（比如只读），直接用 `dsh-sandbox-policy` 的 `setSandboxMode(session, mode)` 和审批服务的 `setApprovalPolicy(session, policy)` |
| `workspaceRegistry` | `create(path, title)` 返回工作区；同一路径重复调用会复用已有工作区（id 不变，title 沿用第一次的），不会报错。再调工作区对象的 `attachSession(sessionId)`（方法在工作区上，不在 registry 上），会话就挂到 dsh Web 侧栏对应工作区下。只有 web 组合包里有这个服务，要用 `ctx.get('workspaceRegistry')` 按需获取，不能写进 `inject`，否则在其他 profile 里插件会起不来 |
| `agentDefaultModel` | `currentSelection()` 返回 `{ provider, model, reasoningEffort? }` |
| `sessions` | `flush(session)` |
| `subagents` | `waitForChildren(agent)` |

### 5.5 dsh 自带的 ACP（`dsh-acp`、`dsh-acp-app`）

- `dsh --profile acp` 是 dsh 官方的 ACP stdio 服务器，文档标为"稳定 ACP v1"。支持的方法：`initialize`、`session/new`、`session/list`、`session/resume`、`session/close`、`session/set_config_option`（`model`、`reasoning_effort`）、`session/prompt`（文本、资源链接、图片）、`session/cancel`、`session/request_permission`。
- acp profile 里工具是可用的（它只禁用了 `session-title-llm` 和 `hmr`）。但它自带的默认值是 `deepseek-official` / `deepseek-v4-flash`，和用户在 dsh Web 里设的不一定一样，**退回时要把 dsh Web 的服务商和模型设置带过去**（做法见 11.5）。
- `dsh-acp` 的传输通道可以替换（源码里是 `config.stream ?? ndJsonStream(stdout, stdin)`），但它创建会话时**不挂工具预设**，放进 dsh Web 后会话没有工具，所以不能直接拿来当桥接。
- ACP 官方 SDK `@agentclientprotocol/sdk`（1.4.0，Apache-2.0，没有其他依赖）在 dsh 的依赖里。

### 5.6 dsh 插件的打包和安装

- 插件包的 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
- `cordis.patch.yml` 的写法是 `- insert: [{ id: <id>, name: <包名> }]`。
- 安装命令：`dsh plugin --profile <profile> add <spec>`，依赖 pnpm。spec 可以是本地路径、tarball 或注册表包名。**我们统一用 `npm pack` 打出的 `.tgz` 来装**：安装包会被复制进 profile，不依赖源码目录在哪。
- profile 的组合包列表在 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里。
- dsh 桌面版（Electron）使用保留名 `desktop` 的 profile，npm 装的 CLI 不能管理它（报 `profile "desktop" is managed exclusively by the Electron application`）。但 dsh 0.2.1-rc.2 的源码和 README 显示：桌面版自带的命令入口会打开 `runCli()` 的 `manageDesktopProfile` 选项，可以在桌面版完全退出、profile 已初始化时执行 `dsh plugin --profile desktop …`；profile 目录同样是 `<DSH_HOME>/profiles/desktop`。【待核实】桌面版本身未实测，Windows 探针见第 17 节第 15 项。第 1 阶段只支持通过 CLI 启动的 dsh Web；桌面版的支持放到后面再看。
- base 组合包启用了热重载（HMR），headless 关闭了它。实测：dsh Web 运行中**新装**一个插件包会热加载生效；用 `dsh plugin add` **更新已装的同一个包**不会重新加载，必须重启 dsh Web。
- `dsh plugin` 只调用 PATH 上的 `pnpm`，找不到时退出码 127，不会自己用 corepack。用 corepack 第一次取得 pnpm 时要联网下载；pnpm 就绪后，安装没有依赖的 `.tgz` 可以离线完成（registry 不可达加 `--offline` 实测通过）。

### 5.7 dsh 的模型配置在哪

- 服务商条目（`llm-*`）和默认模型（`agent-default-model`：`provider`、`model`、`reasoningEffort`）都在各 profile 的 `cordis.patch.yml` 里。在 dsh Web 的"设置 → 模型"里保存的选择也写到这里。
- `dsh --profile <名称> --dump-config` 输出的是各层 patch 的原样列表（含 `!!js` 表达式），不是求值后的最终配置。
- API key 依次从启动环境、`<运行目录>/.env`、`$DSH_HOME/.env` 读取。web、acp profile 还会读 dsh 的凭据存储（界面里保存的 key 和登录信息）；headless 默认不读。
- 结论：dsh 用什么服务商完全由用户在 dsh 里配置。桥接直接用 dsh Web 进程当前的设置，天然不依赖服务商。

## 6. 整体架构

### 6.1 角色和组件

```
                 ┌──────────────── 共享运行时 ~/.agent-collab/runtime/<版本>/ ────────────────┐
                 │  core/run.mjs  watch.mjs  doctor.mjs  config.mjs  server.mjs  setup.mjs   │
                 │  core/adapters/{dsh, codex, claude}.mjs        ui/  schema  模板           │
                 └───────▲───────────────────▲──────────────────────────────▲─────────────────┘
                         │ 调用               │ 调用（第 3 阶段）               │ 调用（第 3 阶段）
        设计端入口：      │                   │                              │
        Claude Code 插件（skill、命令、hook） dsh skill                       codex skill / 插件

        执行端：
        dsh ── 桥接插件（在 dsh Web 进程里，ACP 兼容）── 会话实时显示在 dsh Web
            └─ 桥接不可用时退回 dsh --profile acp（ACP stdio）
        codex ── codex exec（第 2 阶段）
        claude ── claude -p（第 2 阶段）
```

- **设计端**：负责跑流程的 agent。流程由两部分组成：给模型读的 skill，加上共享运行时里的脚本。
- **执行端**：被调用、负责实现的 agent，通过执行端适配器接入。
- 角色怎么组合、怎么选，见第 11 节。

### 6.2 第 1 阶段的数据流（Claude 设计、dsh 执行）

```
Claude Code（/collab）                             dsh Web 进程
┌───────────────────────────┐                    ┌──────────────────────────────┐
│ skill 流程                  │                    │ dsh-bridge 插件（ACP 服务端）   │
│ run.mjs 派发 + 工作进程     │── 回环 TCP + 令牌 ─▶│  建会话 / 续接 / 取消          │
│   adapters/dsh.mjs         │  ACP v1 + _meta    │  挂工具预设、权限、工作区       │
│   （ACP 客户端）            │◀─ session/update ──│  转发事件、人工插话、审批状态    │
│ watch.mjs → Monitor        │                    └──────────────┬───────────────┘
│ server.mjs 配置页 + 看板(1b) │                                   ▼
└──────────┬────────────────┘                    dsh 会话：在侧栏对应项目下实时显示
           │ 桥接不可用时                          ◀── 用户在 dsh Web 里看、批准、插话
           └─ 退回 dsh --profile acp（ACP stdio，用同一套客户端代码）
```

用户能看到的：

- **设计端这边**：Claude Code（终端或 Desktop）会话本身。执行端的关键进度会通过 Monitor 以一行行摘要推进对话。
- **dsh 这边**：dsh Web 里的原生会话，实时显示。
- **任务全貌**：本地看板（第 1b 阶段，见 12.5）；1a 阶段用 `collab run status` 和 `summary.json`。

## 7. 目录结构

### 7.1 仓库

```
agent-collab/
├── .claude-plugin/
│   ├── plugin.json                Claude Code 插件清单
│   └── marketplace.json           GitHub 或本地目录都可以作为插件市场
├── hooks/
│   └── hooks.json                 SessionStart：检查安装状态，自动同步（见 14.5）
├── commands/
│   ├── collab-setup.md            /collab-setup：首次安装、查看状态、卸载
│   └── collab-config.md           /collab-config：打开配置页
├── skills/collab/
│   ├── SKILL.template.md          流程主体，所有设计端共用
│   ├── hosts/                     各设计端的差异片段："怎么后台运行、怎么等结果"等
│   │   ├── claude.md
│   │   ├── dsh.md                 第 3 阶段
│   │   └── codex.md               第 3 阶段
│   ├── SKILL.md                   由模板和 hosts/claude.md 生成，供 Claude Code 插件直接使用（生成后提交进仓库）
│   ├── i18n/                      流程说明和模板的多语言版本（zh、en）
│   └── references/
│       ├── brief-template.md      任务书模板（改编自 sol-skill）
│       ├── correction-template.md 问题单模板
│       └── report-schema.json     汇报格式（沿用 sol-skill，增加 human_inputs 字段）
├── bin/
│   └── collab.mjs                 各工具入口统一调用的启动器：找到共享运行时，缺失时提示安装；开发模式下直接用仓库里的 core/
├── core/                          共享运行时的源码，安装时复制到 ~/.agent-collab/runtime/<版本>/
│   ├── run.mjs                    派发、续接、取消、等待；后台工作进程（D20）、基线快照（D21）、任务锁（D23）；卡死检测、提取汇报、生成补丁、写 summary.json
│   ├── watch.mjs                  把事件流转成里程碑行（给 Monitor 用）
│   ├── doctor.mjs                 环境自检
│   ├── setup.mjs                  检测、生成安装计划、安装、同步、卸载
│   ├── detect.mjs                 探测工具位置、版本、profile、端点和模型（见 4.3）
│   ├── platform.mjs               平台差异：路径、进程树终止、命令包装、文件权限
│   ├── config.mjs                 三级配置的读取、合并、校验、写入，以及版本迁移
│   ├── server.mjs                 本地服务：配置页 + 看板
│   ├── render-skill.mjs           按设计端和语言渲染 SKILL.md
│   ├── acp-client.mjs             ACP 客户端（自写的精简版，见 9.4）
│   ├── jsonrpc.mjs                换行分隔的 JSON-RPC 2.0，acp-client 用
│   ├── schema-check.mjs           零依赖的精简 JSON Schema 校验器，配置和汇报共用
│   ├── report.mjs                 从最后一条回复里提取汇报并校验（第 13 节）
│   ├── adapters/
│   │   ├── dsh.mjs                优先走桥接，Web 没开时自动启动，失败时退回 acp stdio
│   │   ├── codex.mjs              第 2 阶段
│   │   └── claude.mjs             第 2 阶段
│   └── vendor/                    第三方代码及其许可证（目前没有，需要时才建）
├── config/
│   └── config.schema.json         所有配置项的唯一描述；默认值只写在这里，不另建 defaults.json
├── ui/
│   ├── config.html                从 schema 自动生成的配置表单
│   └── dashboard.html             任务看板
├── dsh-bridge/                    dsh Web 插件（纯 JS，不需要构建步骤），打包成 .tgz 随运行时分发
│   ├── package.json               声明 dsh.bundle.patch，peerDependencies 写明支持的 dsh 版本并标为可选；没有需要联网下载的依赖（见 9.4）
│   ├── cordis.patch.yml           插入桥接插件，以及 agent-collab 工具预设（见 9.5）
│   └── lib/
│       ├── index.js               cordis 插件入口：监听端口、发令牌、管理连接
│       ├── acp-server.js          ACP 方法实现
│       ├── jsonrpc.js             与 core/jsonrpc.mjs 内容相同的一份（桥接装进 dsh profile 后拿不到 core/），由测试保证两份一致
│       └── dsh-api.js             所有 dsh 内部服务调用都集中在这一个文件
├── scripts/build.mjs              生成 skills/collab/SKILL.md、打包桥接 .tgz、组装运行时
├── tests/                         单元测试（用假的 dsh 和执行端，node --test 运行）；fixtures/ 放假对端；integration/ 放要真 dsh 的集成测试脚本，单独运行
├── docs/
│   ├── PLAN.md                    本文件
│   ├── protocol.md                字段级接口契约：桥接扩展字段、统一事件、运行目录文件、CLI 输出
│   ├── dev-setup.md               开发模式和 1a 阶段的手动安装步骤
│   └── user/                      用户文档（安装、配置、各平台注意事项）
├── LICENSE                        MIT
└── NOTICE                         sol-skill（MIT）等参考项目的署名
```

### 7.2 共享运行时（安装后，在每个用户自己的目录里）

```
~/.agent-collab/                    Windows 上是 %USERPROFILE%\.agent-collab\；可用环境变量 AGENT_COLLAB_HOME 改位置
├── bin/collab、bin/collab.cmd       命令入口，转给当前版本的运行时；不会自动加进 PATH，用户可以自己加
├── runtime/
│   ├── <版本>/                     bin/collab.mjs、core、ui、config schema、skill 模板、dsh-bridge-<版本>.tgz
│   └── current.json                {"version": "<版本>"}；用文件记录当前版本，不用符号链接，各平台通用
├── config.json                     全局配置
├── runs/<仓库标识>/<任务号>/       每个任务的运行目录（见第 8 节末尾）
├── installed.json                  安装记录（见 14.3）
├── setup.lock                      安装和同步时的全局锁（D23）
└── logs/setup.log
```

令牌、配置、运行记录需要只让本人读写。所以共享运行时**必须放在本机、支持权限控制的文件系统上**，不要放在网络盘、共享盘或不支持权限位的文件系统里。`doctor` 会检查这一点；用 `AGENT_COLLAB_HOME` 改位置时同样适用。

## 8. 协作流程（`/collab <需求>`）

下面的"设计端"在第 1 阶段就是 Claude。

本文写的 `/collab`、`/collab-setup`、`/collab-config` 是简称。插件里的命令和 skill 都带插件名前缀，实际要输入 `/agent-collab:collab` 等；实测终端 `claude -p` 下短名不可用，交互模式和 Desktop 里能否用短名在 T20 一并确认。

skill 设置 `disable-model-invocation: true`，只有用户手动输入才会触发。另外，派发时会给执行端加上防套娃标记（`AGENT_COLLAB_ROLE=executor`，dsh 执行端为 `DSH_AGENT_COLLAB_ROLE=executor`，见 11.4），防止执行端再往外派任务。skill 的 frontmatter 还用 `allowed-tools` 放行 `collab` 命令，免得每一步都弹权限确认。已实测可行，而且要写成只放行启动器的窄规则：`Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs":*)`，其中的 `${CLAUDE_PLUGIN_ROOT}` 会被替换成插件目录；skill 正文同样用 `node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs" …` 调用。

### 阶段 0：预检

1. `bin/collab.mjs` 确认共享运行时已安装，版本和插件一致。如果没装，进入 `/collab-setup`（见 14.4）。
2. 运行 `doctor.mjs`：检查执行端 CLI、dsh Web 和桥接、执行端实际要用的模型是否可用（按各工具自己的配置检查，不假设服务商）。
3. 不是 git 仓库：停下来问用户是否 `git init`（D10）。
4. 工作区有未提交改动：让用户选提交、暂存或取消（D10）。选暂存时，任务结束后提醒用户恢复，不自动执行 `git stash pop`，避免和执行端的改动冲突。
5. 确定本次的执行端：任务里临时指定的优先，其次用配置里该设计端的默认执行端（D18）。
6. 本仓库已有任务在跑（D23）：停下来，让用户选等它结束、接上它，或者取消它。

### 阶段 1：设计（设计端）

- 只阅读写任务书所必需的代码，不做全面通读。
- 任务书用 XML 块组织：
  - `<task>`：需求原文、计划、相关文件、要遵循的约定
  - `<environment>`：执行端的权限模式、有无网络、哪些目录只读、已知跑不了的检查、缓存应重定向到哪里。这些由 `doctor` 按执行端和平台生成，设计端照抄或补充
  - `<acceptance_criteria>`：**按 AC1、AC2… 编号，每条都能用命令或可观察的行为验证**
  - `<non_goals>`：不做什么
  - `<protected_paths>`：可选，执行端不许碰的路径，比如设计端预先写好的验收测试
  - `<verification_loop>`：执行端收尾前要跑的检查
  - `<action_safety>`：不提交、不切分支、不顺手重构，外加从设计端的记忆和对话里抄过来的规则
  - `<when_blocked>`：遇到产品决策、缺权限或缺工具时，停下来汇报 `blocked`，**不要直接问人**（D11）
  - `<output_contract>`：最后一条消息只输出一个 ```json 代码块，格式见 `report-schema.json`
- 参考图：在任务书里列出图片路径。执行端是 dsh 时要求它用 `read_image` 读取；codex 用 `-i` 直接附上。执行端不支持图片时（见 `doctor`），改成文字描述。
  - 只有文件形式的图片能交给执行端。用户直接粘贴在对话里的图片，设计端没法可靠地存成文件，要请用户给出文件路径，否则改成文字描述。
- 按配置决定派发前是否给用户确认，默认只在涉及破坏性操作、安全或产品歧义时才确认。

### 阶段 2：实施（执行端）

- 设计端运行 `collab run start`：先给工作区拍基线快照（D21），再启动独立的工作进程（D20），立即返回任务号。
- 设计端在后台运行 `collab run wait <任务号>` 等任务结束，同时挂上进度监视。具体做法由各设计端的差异片段决定：Claude 用 Bash 的 `run_in_background` 跑 `wait`，用 Monitor 挂 `watch.mjs`。
- 设计端会话中途关闭不影响任务。新会话里 `collab run status` 会列出没结束的任务，再 `wait` 一次就接上了。
- 执行端是 dsh 时，会话出现在 dsh Web 对应工作区下，标题形如 `[collab] T001 <任务名>`。
- 运行目录：`~/.agent-collab/runs/<仓库标识>/<任务号>/`。放在用户目录而不是仓库里，原因有三：不弄脏工作区；不在执行端的可写范围内，它改不了日志和汇报；换了设计端会话也能接着做。目录里的文件见本节末尾。

### 阶段 3：验收（设计端）

1. 读 `summary.json`：状态、汇报、改动文件、用户插话、审批记录、设计端和执行端分别是谁。
2. 读补丁文件：当前工作区相对基线快照的差异，**包括所有新建的未跟踪文件**（思路来自 sol-skill 的 `write_patch`，基线改用快照，见 D21）。
3. 检查受保护路径有没有被改动；HEAD 或当前分支变了（执行端提交了或切了分支），也记为违规。
4. **设计端自己重跑测试、lint、类型检查**；执行端没能跑的检查也由设计端跑。
5. 用户插的话按补充需求处理（D12）：先更新 AC，再按新的 AC 审查。
6. 界面类任务：设计端自己看截图。

### 阶段 4：返工（最多 N 轮，默认 2）

- 问题单只写需要改的部分，每条三件事：**在哪**（文件:行号 + AC 编号）、**错在哪以及要求是什么**、**必须通过哪个检查**。
- `collab run resume` 续接原来的会话，之后同样用 `wait` 等结束。
- 达到上限仍不通过：停下来，把剩余问题报给用户。
- 其他结果的处理：
  - `blocked`：设计端能答的，带上答复续接。这不算返工轮次，但单独计数，上限同 `maxCorrectionRounds`。涉及产品决策的问用户（D11）。
  - 用户在 dsh Web 里停止了任务（`stopped_by_human`）：不自动续接，问用户下一步怎么办。
  - 卡死超时（`idleTimeoutMinutes`）：取消本轮，标记为 `stalled`，把最后的进度报给用户，由用户决定续接还是放弃。

### 阶段 5：汇报（设计端）

- 每个文件改了什么：附相对基线的改动统计（类似 `git diff --stat`），每个文件一句说明。
- 设计端自己跑检查的实际结果。
- 审查结论和剩余风险。
- 用户插话、审批的记录。
- 默认不自动提交（可配置）。

### 运行目录和任务状态

每个任务一个目录：`~/.agent-collab/runs/<仓库标识>/<任务号>/`。仓库标识由仓库根目录的真实路径算出（目录名加路径哈希的前几位）；任务号在仓库内递增，形如 `T001`。

各文件的字段格式见 [protocol.md](protocol.md)。

任务锁（D23）放在仓库这一级：`runs/<仓库标识>/active.lock`，不在任务目录里，这样看本仓库有没有任务在跑只需看一个文件。

| 文件 | 内容 |
|---|---|
| `state.json` | 当前状态、工作进程 pid、执行端会话 id、收到的最后一个事件序号、返工轮次 |
| `brief.md`、`prompt-<轮次>.md` | 任务书（第 1 轮），以及之后每轮发给执行端的消息：问题单、对 `blocked` 的答复、要求重发汇报 |
| `cancel.request` | `collab run cancel` 写入，表示要求取消，工作进程定期检查；用文件而不是信号，各平台通用 |
| `baseline.json` | 基线快照的 tree id，以及当时的 HEAD 和分支（D21） |
| `events.jsonl` | 统一格式的事件流（11.3） |
| `report-<轮次>.json` | 每轮提取出的汇报 |
| `patch-<轮次>.diff` | 每轮结束时相对基线的补丁 |
| `summary.json` | 给设计端和看板读的总结 |
| `worker.log` | 工作进程自己的日志 |

任务状态：`starting`、`running`、`waiting_approval`、`waiting_question`、`done`、`partial`、`blocked`、`report_invalid`、`stalled`、`cancelled`、`stopped_by_human`、`failed`。

运行记录里可能有命令输出和环境信息，所以目录只让本人读写。超过 `runRetentionDays` 天的记录在同步时清理，正在运行的任务不清理。

## 9. dsh 桥接插件（ACP 兼容）

### 9.1 监听和发现

- 插件在 dsh Web 启动时加载，监听 `127.0.0.1` 的随机端口。各平台统一用回环 TCP，不用 Unix socket 或 Windows 命名管道，实现和排查都最简单。
- 写出发现文件 `$DSH_HOME/agent-collab/bridge-<profile>.json`：`{ port, token, pid, protocol, dshVersion, bridgeVersion, profile, startedAt, webUrl? }`。
  - 按 profile 分开存，同时开着几个 profile 的 dsh Web 也不会互相覆盖。
  - `webUrl` 能拿到时，设计端可以给出直达该会话的链接（待确认，第 17 节第 19 项）。
  - 文件权限只给本人读写（Linux / macOS 设为 0600；Windows 依赖用户目录本身的权限）。
  - 和共享运行时一样，不能放在不支持权限控制的位置。
- 客户端在 `initialize` 的 `_meta.agentCollab.token` 里带上令牌，令牌不对就直接断开连接。
- dsh Web 退出时删除发现文件。客户端读到的 pid 如果已经不存在，就当作桥接不在线。
- 客户端断开连接时，桥接**不取消**正在跑的会话；客户端重连后用 `session/resume` 接上（见 9.2）。

### 9.2 方法

参数、返回和扩展字段的具体格式见 [protocol.md](protocol.md)，本节只写行为。

| ACP 方法 | 桥接的行为 |
|---|---|
| `initialize` | 校验令牌和协议版本（D22），返回能力：支持 `session/resume`、`session/close`；图片能力按当前模型实际情况声明 |
| `session/new` | 参数是 `cwd` 加 `_meta.agentCollab`（`title`、`agentPreset`（默认见 9.5）、`permissionPreset`、`model`、`reasoningEffort`、`attachWorkspace` 默认 true、`env`）。`env` 的键必须以 `DSH_` 开头（见 11.4）。依次执行：`agents.create`；在 setup 里显式 `agentPresets.mount` 挂工具预设、用 `shellEnv.register` 注入 `env`、装好模型选择；按 11.9 设好沙箱和审批；`workspaceRegistry.create(cwd).attachSession` |
| `session/resume` | 会话还活着就直接用 `agents.get`，否则在本进程里 `agents.resume`。不存在抢锁问题。带 `_meta.agentCollab.sinceSeq` 时，先按序号补发断开期间的事件（`session.eventAt`），保证事件不丢 |
| `session/prompt` | 用 `agent.followup` 发消息，等根会话和所有子任务都完成后返回 `stopReason` |
| `session/cancel` | `agent.cancel({ kind: 'user' })` |
| `session/set_config_option` | 修改 `model` 或 `reasoning_effort` |
| `session/close` | 释放桥接自己持有的引用。**不删除会话**，用户还要在 Web 里回看 |
| `_agentCollab/models`（扩展） | 列出 dsh 当前服务目录里可选的模型，给配置页用 |

### 9.3 事件转发

各事件的字段见 [protocol.md](protocol.md)。

- 标准的 `session/update`：
  - `agent_thought_chunk`（思考）
  - `agent_message_chunk`（回复）
  - `tool_call` 和 `tool_call_update`（工具调用和结果）
  - `user_message_chunk`：用户在 dsh Web 里插话时发出，带 `_meta.agentCollab.source = "dsh-web-human"`
- 扩展通知 `_agentCollab/status`（带下划线前缀，符合 ACP 的扩展规则）：
  - 每一步结束时的 token 用量
  - `turn_end` 及原因
  - 审批状态：`approval_pending` / `approval_resolved`，来自会话日志里的 `approval/asked`、`approval/decided` 事件（5.2）。实测：通过 `ctx.on('session/event')` 能收到这对事件，两者用同一个 `id` 配对；`approval/asked` 带 `id`、`toolName`、`callId`、`reason`，`approval/decided` 带 `id`、`outcome`（如 `allowed-once`、`rejected`）。等待审批期间 `agent.status` 仍是 `running`，不能据此判断；桥接按“已 asked、未 decided”自己维护待审批集合
  - 提问状态：`question_pending`，执行端调用了 `ask_user_question` 时发出（见 9.5）。实测：以 `ask_user_question` 的 `tool/call` 事件为准，它带 `callId` 和完整的问题；`user-questions/request` 也带问题但不带 `callId`；`standard` 预设下的提问是阻塞模式，`userQuestions` 的投影里看不到待答问题
  - 用户在 Web 里停止了任务：`stopped_by_human`。dsh 的事件分不清“人在 Web 里停止”和“本连接取消”（5.4），由桥接判断：本连接发过 `session/cancel` 后以 `aborted` 结束的算客户端取消，否则算人停止。所以只有桥接进程一直在时才分得清，桥接重启后补发的历史轮次不知道是谁停止的
- 回复文字按 `assistant/message` 整条转发，不是逐字流式；思考同理。实时查看的粒度是一条消息（一步）
- **审批**：桥接模式下审批由人在 dsh Web 里处理，桥接**不会**把 `session/request_permission` 发给客户端，只用状态通知告诉客户端有审批在等。等审批期间暂停卡死计时。
  - 实测插件也能用代码应答：注册 `ctx.on('approval/request', (request, next) => …)`，返回 `allowed-once` 或 `rejected`，不处理的交给 `next()`；`ask_user_question` 同理可以监听 `user-questions/request` 并返回答案。本设计不用这个能力：桥接只观察事件，不注册应答者，审批和提问都留给人。以后要做自动审批时，还要先验证它和 dsh Web 自带应答者的先后顺序。

### 9.4 兼容性和自检

- 所有 dsh 内部服务调用都集中在 `dsh-bridge/lib/dsh-api.js`，包括 agent、session 对象上的方法（S2 实现时由 dsh-api 包一层再交给 ACP 服务端），dsh 升级后只需要改这一个文件；单元测试自动检查其他文件没有直接调用。
- `package.json` 声明支持的 dsh 版本范围，加载时遇到不支持的版本，在 dsh 日志和发现文件里写明原因。声明方式是 `peerDependencies` 加 `peerDependenciesMeta` 的 `optional: true`：pnpm 不会因此去下载 dsh（dsh 的 profile 还设了 `autoInstallPeers=false`）。【已验证】2026-10-23，S2 用离线方式在临时 profile 安装，`node_modules` 里只有桥接。桥接自己也按这个范围判断版本，不依赖 pnpm 的检查。
- 桥接包除了 dsh 自己提供的服务，不依赖任何需要联网下载的包：ACP 用自写的精简实现（换行分隔的 JSON-RPC 2.0，只实现用到的方法），客户端和桥接各一份，不附带 SDK（1a 定，用户 2026-10-23 确认）；方法和字段以 dsh 依赖里那份 SDK 的类型定义为准核对。这样安装时不用为我们的包联网。实测：pnpm 就绪后安装无依赖的 `.tgz` 不需要联网；但用 corepack 第一次取得 pnpm 时要联网（5.6）。离线机器需要预先装好 pnpm，或预置 corepack 缓存，用户文档要写明。
- `doctor.mjs --deep` 跑一个最小冒烟：建会话 → 发一句话 → 收到事件 → 正常结束 → 关闭会话。
- 发布前，在支持范围内的每个 dsh 版本上跑一遍桥接的集成测试。

### 9.5 dsh 的提问工具

dsh 的提问工具叫 `ask_user_question`（`dsh-tool-ask-user`），作为一行插件（`tool-ask-user`）挂在工具预设里，Web 的 `standard` 预设里就有它。它和 D11 冲突：执行端应该汇报 `blocked`，而不是直接问人。

- **采用**：桥接的 bundle 补丁里加一个工具预设 `agent-collab`，内容是**整份复制** `standard` 的插件列表、去掉 `tool-ask-user`，桥接建会话时默认用它。实测 dsh 没有基于已有预设派生的语法（`dsh-agent-preset` 没有继承字段，补丁也改不到 `standard` 内部的行），整份复制可以正常工作（用户 2026-10-23 确认采用）。
  - 代价：dsh 升级改了 `standard` 时，复制品会落后。由 `doctor` 比对 `agent-collab` 和当前 dsh 自带的 `standard`（去掉 `tool-ask-user` 后）是否一致，不一致就提示，桥接发新版本时同步更新这份列表。
  - 复制品不可用（比如引用了新版 dsh 已删除的插件）时，退回下一条。
- **退回做法**：用用户选的预设（`dsh.agentPreset`，默认 `standard`），靠任务书约束。执行端仍然提问时，桥接发出 `question_pending`，问题由人在 dsh Web 里回答，设计端在进度里看到提示。
- **acp 退回模式**：如果没有应答者，阻塞式提问会直接返回错误，执行端再按任务书汇报 `blocked`。

## 10. 环境自检（`doctor`）

`doctor` 是"探测而不是假设"（原则 1）的落地点：阶段 0 的预检、任务书的 `<environment>` 块、配置页顶部的状态、安装计划，都以它的结果为准。

| 检查项 | 内容 |
|---|---|
| 基础 | Node、git 的版本；当前平台 |
| 共享运行时 | 是否安装、版本是否和插件一致、文件是否完整；所在位置是否支持权限控制 |
| 安装记录 | `installed.json` 记录的部件和实际情况是否一致 |
| 执行端 | 每个执行端 CLI 的位置和版本；**实际会用的端点和模型**（读各工具自己的配置）；是否支持图片；沙箱模式下哪些目录只读、有没有网络 |
| dsh | 安装目录、`DSH_HOME`、dsh Web 用的 profile、Web 是否在运行、桥接是否在线、桥接和 dsh 版本是否兼容、`agent-collab` 工具预设是否可用，以及它和 dsh 自带的 `standard`（去掉 `tool-ask-user`）是否一致（9.5） |
| pnpm | 只在需要安装 dsh 桥接时检查 pnpm 和 corepack |
| 角色组合 | 默认执行端是否可用；同一个工具担任两端时给出提示 |

- 输出两种格式：给人看的文字，以及 `--json`（给设计端和配置页用）。
- `doctor --deep` 会做真实的试调用（比如桥接的最小冒烟、执行端的一次极短对话），会消耗少量 token。只在首次安装、用户明确要求或排查问题时运行。

## 11. 角色与适配器

### 11.1 设计端

设计端需要具备这些能力：加载 skill、执行命令、在后台跑长任务并在结束时得到通知（或者能主动查询状态）、读文件和图片。

| 设计端 | 阶段 | 入口 | 后台运行和等结果 |
|---|---|---|---|
| Claude | 第 1 阶段 | Claude Code 插件（终端和 Desktop 都适用） | Bash 的 `run_in_background`，结束时自动通知；Monitor 挂 `watch.mjs` 显示进度 |
| dsh | 第 3 阶段 | `$DSH_HOME/skills/collab/` | bash 工具的 `run_in_background` 返回任务 id，用 `job_output` 读取结果（待验证） |
| codex | 第 3 阶段 | codex 的 skill 目录，或 codex 插件（二选一，待确认） | 待调研 |

**skill 用一份模板按设计端渲染**：

- `SKILL.template.md` 是流程主体，所有设计端一样。
- `hosts/<设计端>.md` 只写差异：怎么后台运行、怎么等结果、怎么显示进度、怎么引用 skill 自己的目录。
- 语言按配置 `language` 选择（默认跟随系统语言，支持中文和英文）。
- Claude 版在构建时生成，随插件一起发布；其他设计端的版本由 `setup.mjs` 安装时生成。

**脚本接口与设计端无关**：

- `collab run start | resume | cancel | status --json`、`collab doctor`、`collab setup`、`collab sync`、`collab config`、`collab dashboard`。
- 输出都是 JSON，状态都存在文件里，任何设计端都能驱动。各命令的参数、JSON 输出和退出码见 [protocol.md](protocol.md)。

### 11.2 组合和选择

- 设计端和执行端可以任意组合，包括同一个工具同时担任两端，比如 Claude 设计、另开一个 Claude 会话实现。
- 同模型互审时，审查者和实现者有相同的盲区，这正是 sol-skill 强调要用不同模型的原因。所以这种组合**允许用，但 `doctor` 会给出提示**。
- 配置项 `executorByDesigner` 给每个设计端设默认执行端。出厂默认：Claude → dsh，dsh → claude，codex → dsh。默认执行端在本机不可用时，自动选一个可用的，并告知用户。
- 单个任务可以临时指定，比如 `/collab --executor codex <需求>`。
- `summary.json` 里记录这次是谁设计、谁执行，包括各自的模型。

### 11.3 执行端适配器的统一接口（`core/adapters/*.mjs`）

```
capabilities()                     → { images, structuredOutput, liveView, resume, humanApproval }
start({ cwd, runId, title, brief, images, options, env })
                                   → { sessionId, transport, model, turn }   turn 是本轮结束的 Promise
resume({ sessionId, message })     → { turn }
attach({ sessionId, sinceCursor }) 工作进程重启后，重新接上仍在运行的会话（不支持的执行端返回 attached: false）
cancel({ sessionId })
close()
onEvent(event)                     创建适配器时传入的回调，收到统一格式的事件：
                                   session / thinking / text / tool_call / tool_result / usage /
                                   human_message / approval / question / turn_end / warning / error
```

`run.mjs` 只认这套统一格式，它负责写 `events.jsonl`、提取汇报、卡死检测和生成 `summary.json`。`sinceCursor` 是适配器自己定义的补发位置（dsh 桥接用事件序号）。签名和统一事件的字段以 [protocol.md](protocol.md) 第 3、4 节为准。

### 11.4 防止套娃

- 派发时给执行端的进程和会话加上防套娃标记：
  - codex 和 claude 是子进程，直接设置进程环境变量 `AGENT_COLLAB_ROLE=executor`。
  - dsh 走桥接时，通过 `session/new` 的 `_meta.agentCollab.env` 注入该会话的 shell 环境。实测：桥接在会话的 setup 里用 `shellEnv.register` 注册，只影响这一个会话；但 dsh 要求键名以 `DSH_` 开头，所以 dsh 执行端用 **`DSH_AGENT_COLLAB_ROLE=executor`**。同理，`executors.dsh.env` 在桥接模式下只能传 `DSH_` 开头的变量，其他键 `doctor` 会提示无效。
  - acp 退回模式下 dsh 是子进程，两个变量都设上。
- 检测到 `AGENT_COLLAB_ROLE` 或 `DSH_AGENT_COLLAB_ROLE` 为 `executor` 时，`collab run start` 拒绝执行。
- skill 继续保持 `disable-model-invocation: true`。

### 11.5 dsh 适配器的连接顺序

1. 读取发现文件，桥接在线就走桥接（ACP over TCP）。
2. 桥接不在线，而配置为"自动启动"：在后台启动 `dsh --profile <dsh.profile>`（按配置决定是否加 `--no-open`，可通过 `dsh.webArgs` 追加参数），进程独立常驻。等发现文件出现，超时就报错。
   - dsh Web 已经开着但没装桥接插件：提示运行 `/collab-setup`，**不要再启动第二个 dsh Web**。
3. 桥接不可用（没装、版本不兼容、自检失败）：退回 `dsh --profile acp`（ACP stdio），用同一套客户端代码。同时提醒用户：这个会话不会实时显示，任务结束前不要在 dsh Web 里打开它，否则会占锁。
   - 这种模式下没人能批准，审批请求按配置处理，默认拒绝。
   - **模型**：运行时从 dsh Web 所用 profile 的用户配置层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）里挑出服务商和默认模型相关的条目（`llm-*`、`agent-default-model`），再加上 `acp` 条目的 `provider`、`model`，生成一个临时覆盖层，用 `dsh --profile acp --patch <覆盖层>` 传入。**不修改 acp profile 的配置**。实测可行：覆盖层能正常加载，ACP `session/new` 返回的当前模型就是覆盖层指定的模型；实现时要用可靠的 YAML 解析挑条目，不能靠简单的按行匹配：借用 dsh 安装目录里自带的 YAML 库（从解析出的 dsh 入口位置查找），格式和 dsh 自己的解析一致，也不给我们引入依赖；找不到时退回模式不可用，`doctor` 报告原因（1a 定，用户 2026-10-23 确认）。配置里明确指定了模型时，以配置为准。
   - 注意：第一次运行 `dsh --profile acp` 时，dsh 会按自带模板自动建出 `$DSH_HOME/profiles/acp` 目录。这是 dsh 自己的行为；如果这个目录是因为我们才出现的，就记入 `installed.json`，卸载时询问是否一并删除。
- 启动 dsh：从 PATH 上的 `dsh` 解析出它的入口 `.js` 文件，再用 `process.execPath` 运行，绕开 Windows 上 npm 生成的 `.cmd` 包装，也不依赖 dsh 装在哪个 Node 版本管理器下。

### 11.6 codex 适配器（第 2 阶段）

参考 sol-skill 已验证的调用方式：

- 派发：`codex exec --json -m <模型> -c model_reasoning_effort=<强度> -s <沙箱模式> --output-schema <schema> -o <汇报文件> - < 任务书`。不指定模型时省略 `-m`，沿用 codex 自己的配置。
- 续接：`codex exec resume <id> ...`。**注意**：续接不接受 `-s` 和 `--color`；用参数传任务时 stdin 要接空设备，否则会卡住（openai/codex#20919）。
- 原生支持图片（`-i`）和结构化汇报（`--output-schema`）。

### 11.7 claude 适配器（第 2 阶段）

- 派发：`claude -p --output-format stream-json`；续接用 `--resume <id>`；权限用 `--permission-mode`；指定模型时加 `--model`。
- **具体参数实现时再按 `claude --help` 核对。**
- 沿用 claude 自己的配置（官方订阅、API key 或任意网关都可以）。

### 11.8 执行端的环境和模型

- **原则**：执行端用它自己配置的服务商和模型（D19）。agent-collab 只在用户明确指定时覆盖模型；思考强度默认设为 high（D13）。两者都通过各工具自己的参数传入（dsh 用会话配置，codex 用 `-m` 和 `-c`，claude 用 `--model`），从不改写它们的服务商配置。
- **思考强度的档位**：各工具的档位不一样。配置里的 low … max 由适配器映射到最接近的档位，映射不了的在 `doctor` 里注明。
- **环境继承要注意**：执行端是设计端启动的子进程，默认继承设计端的环境变量，而不是用户终端的环境。
  - 比如 Claude Desktop 和终端里的 `ANTHROPIC_*` 变量可能不一样，从 Desktop 启动的 `claude -p` 用的端点，就可能和用户在终端里用的不同。
  - 配置项 `inheritEnv` 可选"继承设计端环境"或"使用登录 shell 的环境"；`env` 可以按执行端分别补充变量。
  - `doctor` 显示每个执行端**实际会用的**端点和模型，用户一眼就能看出有没有走错。

### 11.9 权限级别在各执行端的对应

`permissionPreset` 是一个抽象的权限级别，由适配器翻译成各工具自己的设置：

| 级别 | dsh | codex | claude |
|---|---|---|---|
| `read-only` | 预设 `read-only`（沙箱 read-only + 审批 ask，0.2.1-rc.2 默认就有，见 5.2）；用户删掉它时直接设开关，Web 里显示为 `custom` | `-s read-only` | 只允许读类工具（具体参数待核实） |
| `workspace-write` | 预设 `workspace-write`（沙箱 workspace-write + 审批 ask） | `-s workspace-write` | 允许编辑和指定的命令（权限模式加工具白名单，待核实） |
| `danger-full-access` | 预设 `danger-full-access`（沙箱 danger-full-access + 审批 never） | `-s danger-full-access` | 跳过所有权限确认（待核实） |

- **dsh 的做法**：用户可能改过预设表，所以桥接按"沙箱 + 审批"的组合在表里找匹配的预设，找到就用 `permissionPresets.set`，找不到就直接设两个开关（5.4）。审批策略在桥接模式下用 `ask`，由人在 dsh Web 里批准；退回模式下 `unattendedApproval` 为 `deny` 时，直接设成 `never`。
- **审批**：只有 dsh 走桥接时有人能批准（在 dsh Web 里）。codex、claude 和 dsh 的退回模式都是无人值守，按 `unattendedApproval` 处理，默认拒绝。
- **隔离强度不同**：dsh、codex 有系统级沙箱；claude 主要靠权限规则。`doctor` 会说明每个执行端在当前级别下实际受到哪些限制，任务书的 `<environment>` 块也照此填写。

## 12. 配置和可视化

### 12.1 配置分三级

后一级覆盖前一级：

1. 全局：`~/.agent-collab/config.json`
2. 项目：`<仓库>/.agent-collab.json`，可选
3. 单个任务：派发时临时指定

`config/config.schema.json` 是唯一的配置描述：类型、默认值、可选值、取值范围、标题和说明（中英文）、分组，以及允许在哪一级覆盖。**所有界面都从它生成。** schema 带版本号，升级时由 `config.mjs` 自动给新增的配置项补上默认值，不改动用户已经设置的值。

### 12.2 配置项（初版）

| 分组 | 配置项 | 默认值 |
|---|---|---|
| 角色 | `executorByDesigner`：各设计端的默认执行端 | `{ claude: dsh, dsh: claude, codex: dsh }` |
| | `warnSameAgentPair`：同一个工具担任两端时提示 | `true` |
| 执行端 | `executors.<名称>.command`：CLI 路径 | 在 PATH 上查找 |
| dsh | `dsh.home`：dsh 的数据目录 | 探测（4.3） |
| | `dsh.profile`：跑 dsh Web 的 profile | `web` |
| | `dsh.transport`：auto / bridge / acp | `auto` |
| | `dsh.autoStartWeb` | `true` |
| | `dsh.openBrowserOnStart` | `true` |
| | `dsh.webArgs`：启动 dsh Web 时追加的参数 | `[]` |
| | `dsh.agentPreset` | `agent-collab`，不可用时用 `standard`（9.5） |
| 模型 | `model`（按执行端分别设置） | 跟随该工具自己的设置（不覆盖） |
| | `reasoningEffort`：跟随 / low … max | `high` |
| 权限 | `permissionPreset` | `workspace-write`（越权操作由人批准） |
| | `unattendedApproval`：没人能批准时 deny / allow | `deny` |
| | `protectedPaths` | `[]` |
| | `allowedRoots`：允许派发任务的目录（可选白名单） | 不限 |
| 流程 | `confirmBeforeDispatch`：always / risky / never | `risky` |
| | `maxCorrectionRounds`（1–5） | `2` |
| | `commitOnAccept` | `false` |
| | `freshReviewForRisky`（高风险改动另开只读会话复审） | `false` |
| | `language`：auto / zh / en | `auto`（跟随系统语言） |
| 限额 | `idleTimeoutMinutes`（等审批期间不计时） | `15` |
| | `taskTimeoutMinutes` | 不限 |
| | `tokenBudget` | 不限，只显示 |
| 环境 | `env`：传给执行端的环境变量（可按执行端分别设置），比如缓存目录、服务商相关变量 | `{}` |
| | `inheritEnv`：继承设计端环境 / 使用登录 shell 的环境 | 继承设计端环境 |
| 安装 | `autoSync`：插件升级后自动同步已确认过的部件 | `true` |
| 存储 | `runRetentionDays`：运行记录保留天数 | `30` |

- `model`、`reasoningEffort`、`env`、`command` 这类按执行端设置的项，放在 `executors.<名称>` 下，比如 `executors.codex.model`；写在顶层的值作为所有执行端的默认值。
- `permissionPreset` 是抽象级别，各执行端怎么对应见 11.9。
- **项目级不能覆盖的项**：项目文件 `.agent-collab.json` 随仓库来，可能不可信，所以权限和执行环境类的项只能在全局和单个任务两级设置：`permissionPreset`、`unattendedApproval`、`allowedRoots`、`env`、`inheritEnv`、`executors.*.command`、`executors.*.env`、`dsh.*`、`autoSync`、`runRetentionDays`。项目文件里出现这些项时报错并忽略该项。其余项三级都可以设。schema 里用 `x-scopes` 标注每项允许的级别（1a 定，用户 2026-10-23 确认）。
- **项目级只能收紧的项**：下面 4 项项目文件可以设，但只能往安全的方向改：`protectedPaths` 与前面各级取并集（不替换）；`confirmBeforeDispatch` 按 `never` < `risky` < `always` 取较严的；`freshReviewForRisky` 只有 `true` 生效；`commitOnAccept` 只有 `false` 生效。往放宽方向改时报错并忽略该项。单个任务级不受此限制。收紧规则在 schema 里用 `x-` 键标注（S1 验收时发现，用户 2026-10-23 确认）。

### 12.3 本地配置页（第 1b 阶段）

- 入口：Claude 里输入 `/collab-config`，或在终端运行 `collab config`（命令入口见 7.2）。会在默认浏览器里打开。
- 只监听 127.0.0.1，端口随机，网址带一次性令牌，空闲 10 分钟自动关闭；只能读写配置文件。
- 页面：
  - "全局"和"当前项目"两个标签页，被覆盖的项标出来，每项都有"恢复默认"。
  - 控件按 schema 生成：可选值用下拉框，带范围的数值用滑块或数字框，布尔值用开关，列表和键值对用列表编辑器；选"完全放开"时显示红色警告。
  - 模型下拉框：dsh 的可选模型由桥接从 dsh 当前的服务目录里读出，不管用的是哪家服务商；codex、claude 用"可自由输入 + 常用建议"。默认选项是"跟随工具自己的设置"。
  - 保存前显示改了哪些项，写入前按 schema 校验，原子写入。
  - 顶部显示环境自检结果和安装状态：各工具装了哪些部件、版本是否一致、各执行端实际会用的端点和模型。
- 生效时机：每次派发或返工时重新读取配置，所以从下一次派发开始生效。

### 12.4 以后再做的界面

- dsh Web 里的设置入口：桥接插件在"插件"页注册一个页面，里面直接嵌入本地配置页，不重复写表单。
- 不用 Claude Code 自带的 `userConfig` / `/config`：Desktop 的 Code 标签页里用不了，而且会和我们的配置文件形成两份配置。

### 12.5 精简看板（第 1b 阶段）

和配置页用同一个本地服务。入口：派发后设计端在对话里给出看板链接，也可以运行 `collab dashboard` 打开。只显示任务层面的信息，dsh 的完整对话去 dsh Web 看：

- 当前阶段（设计 / 实施 / 验收 / 返工第几轮）、每条 AC 的状态、耗时、token 用量、设计端和执行端分别是谁。
- 任务书、执行端的汇报、问题单、补丁的 diff 对比。
- 用户插话和审批的记录。
- 操作："停止本次运行"、"给下一轮留言"（会附进下一份问题单）。
- 数据来自运行目录里的 `events.jsonl` 和 `summary.json`。

## 13. 汇报格式

沿用 sol-skill 的 `report-schema.json`：

| 字段 | 内容 |
|---|---|
| `status` | `done` / `partial` / `blocked` |
| `summary` | 改了什么、为什么 |
| `criteria[]` | 每条 AC 一项：`id`、`met`、`evidence` |
| `commands[]` | 实际跑过的命令：`command`、`exit_code`、`result` |
| `files_changed[]` | 改动的文件 |
| `deviations[]` | 偏离任务书的地方及原因 |
| `blocked_checks[]` | 没能跑的检查及具体错误 |
| `open_questions[]` | 需要设计端决定的问题 |

新增一个字段 `human_inputs[]`：执行端收到的用户插话，以及它是怎么处理的。

codex 有原生的 `--output-schema`；dsh 没有；claude 有没有类似参数待核实（第 17 节第 11 项）。没有原生支持的执行端，要靠任务书约束，再由 `run.mjs` 提取和校验：

1. 从最后一条回复里取出唯一的 ```json 代码块。
2. 用零依赖的精简校验器按 schema 校验。
3. 校验不通过：续接一次，只要求它重发汇报。
4. 仍然不通过：`summary.json` 里标记 `report_invalid`，设计端直接按补丁审查。

## 14. 安装与同步

### 14.1 原则

- **从任意一个工具触发都能完成全部安装**。第 1 阶段的入口是 Claude Code 插件。
- 所有实际代码都在共享运行时里，各工具里只放入口。所以升级时只换运行时，入口一般不用动。
- **首次安装确认一次，之后自动同步**（D17）。
- 每一项安装都写进 `installed.json`，卸载时按记录逐项清理。**绝不改动用户自己的配置值，也不改动其他工具写入的条目；agent-collab 从不写入模型服务商配置。**

### 14.2 各工具要装什么

| 工具 | 当设计端要装 | 当执行端要装 | 第 1 阶段（1a 手动装，1b 起自动装） |
|---|---|---|---|
| Claude | Claude Code 插件（skill、命令、hook） | 不用装，直接调 `claude -p` | 插件 |
| dsh | `$DSH_HOME/skills/collab/`（渲染好的 dsh 版 skill） | 桥接插件装进 dsh Web 所用的 profile（用 `.tgz`）。退回模式的模型设置在运行时生成，不需要安装（见 11.5） | 桥接 |
| codex | codex 的 skill 目录或 codex 插件 | 不用装，直接调 `codex exec` | 不装 |
| 公共 | 共享运行时；只有要装 dsh 桥接时才需要 pnpm | | 都装 |

只给本机检测到的工具装。没装 dsh 就跳过 dsh 那几项；之后用户装了 dsh，下次同步时检测到新工具，会再确认一次。

### 14.3 安装记录 `~/.agent-collab/installed.json`

```json
{
  "runtimeVersion": "0.1.0",
  "consent": {
    "at": "<时间>",
    "components": ["runtime", "pnpm", "dsh.bridge"]
  },
  "hosts": {
    "claude": { "plugin": "0.1.0" },
    "dsh": {
      "version": "<探测到的版本>",
      "home": "<探测到的 DSH_HOME>",
      "bridge": { "version": "0.1.0", "profile": "web", "package": "@agent-collab/dsh-bridge" },
      "createdProfiles": []
    },
    "codex": { "version": "<探测到的版本>" }
  }
}
```

### 14.4 首次安装：`/collab-setup`

触发时机：用户手动输入 `/collab-setup`；或者第一次用 `/collab` 时，发现共享运行时还没装。

1. **检测**（见 4.3）：
   - Node、git 是否满足要求；不满足就说明怎么装，并停止。
   - 哪些执行端 CLI 可用，各自版本。
   - dsh：安装目录、dsh Web 用哪个 profile、是否在运行。
   - pnpm 和 corepack 是否可用（只在要装 dsh 桥接时检查）。
2. **生成安装计划**并展示给用户，每一项写清楚：
   - 要装什么；
   - 会改哪些文件或配置，比如"在 `$DSH_HOME/profiles/web` 安装插件 `@agent-collab/dsh-bridge`"；
   - 各执行端检测到的服务商和模型（只读展示，不修改）；
   - 是否需要重启 dsh Web；
   - 本平台特有的注意点，比如 Windows 上 corepack 可能需要管理员权限。
3. **用户确认一次**：设计端把计划转述给用户，用户同意后再执行 `collab setup --apply`。确认的部件清单写进 `installed.json` 的 `consent`。
4. **执行**：
   1. 先把共享运行时复制到临时目录，完整后再改名为 `~/.agent-collab/runtime/<版本>/`，然后更新 `current.json`（D23）。同时写好 `~/.agent-collab/bin/` 下的命令入口。
   2. 需要 pnpm 而它不在时，按 D8 启用。
   3. 用随运行时附带的 `dsh-bridge-<版本>.tgz` 执行 `dsh plugin --profile <profile> add <tgz>`。
   4. 第 3 阶段起：为检测到的其他设计端渲染并复制 skill。
5. 跑 `doctor`，汇报结果。需要重启 dsh Web 时明确提示；也可以由用户同意后自动重启。

### 14.5 自动同步

触发时机：

- Claude Code 插件的 `SessionStart` hook：运行 `collab sync --quiet`。
- 每次 `/collab` 开始时也会快速检查一次。

做什么：

1. 插件里的运行时版本和 `installed.json` 不一致：复制新运行时、更新 `current.json`。
2. 桥接版本不一致：重新安装 `.tgz`。更新已装的桥接不会热重载（5.6），dsh Web 正在跑时要提示用户重启；重启前桥接仍是旧版本，按 D22 处理。
3. 重新渲染各设计端的 skill。
4. 配置文件迁移：补上新增配置项的默认值。
5. 清理：删除超过保留期的运行记录（`runRetentionDays`）；旧运行时只保留上一个版本，并且没有任务在用时才删。

规则：

- **只同步 `consent` 里已经确认过的部件**。出现新的部件类型（比如第 3 阶段新增 dsh skill），或者检测到新装的工具，就停下来请用户再确认一次，不会悄悄安装。
- `SessionStart` hook 要快：耗时的步骤（比如 pnpm 安装）放到后台独立进程去做，结果写进 `setup.log`，下次启动或下次 `/collab` 时汇报。
- 有协作任务正在运行时，不更新桥接，等任务结束后再做，避免热重载或重启打断正在跑的会话。这段时间里运行时和桥接的版本可能不一致，按 D22 处理。
- hook 命令形如 `node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs" sync --quiet`。运行时损坏时只输出一行提示，不阻塞 Claude 启动。
- 找不到 Node 时脚本本身跑不起来，没法给出友好提示，Claude Code 会把它当作一次不阻塞的 hook 失败。友好的说明由下一次 `/collab` 给出：skill 第一步先检查 `node --version`。
- 失败不影响 Claude 正常使用，只在 `doctor` 和配置页里显示。
- 配置项 `autoSync` 设为 `false` 可以关闭自动同步，改为每次手动 `/collab-setup`。

### 14.6 卸载：`/collab-setup --uninstall`

按 `installed.json` 逐项清理：

- `dsh plugin --profile <profile> remove @agent-collab/dsh-bridge`
- 删除桥接的发现文件目录 `$DSH_HOME/agent-collab/`
- 因我们而建出的 dsh profile（见 11.5）：询问后删除
- 删除各设计端的 skill
- 删除共享运行时

配置和运行记录是否保留，会先问用户。Claude Code 插件本身由用户在 Claude 里卸载。

卸载不依赖 Claude 插件：在终端运行 `~/.agent-collab/bin/collab setup --uninstall` 效果相同。用户先在 Claude 里卸了插件时，剩下的桥接仍会随 dsh Web 加载，但没有客户端连接时什么也不做；需要时用这个命令清掉。

### 14.7 各平台注意点

- **路径**：一律用 `os.homedir()` 等 API 拼路径；不用符号链接（`current.json` 记录当前版本），skill 一律复制。
- **启动外部命令**：从 PATH 解析出真实入口，Windows 上绕开 `.cmd` 包装（见 11.5）。
- **结束进程**：卡死时要结束整棵进程树。Linux、macOS 按进程组结束；Windows 用 `taskkill /T /F`。
- **pnpm**：Windows 上如果 Node 装在需要管理员权限的目录，`corepack enable` 会失败，改用 `npm i -g pnpm`。据我们所知，Node 25 起不再自带 corepack，同样改用 `npm i -g pnpm`。
- **换行符**：生成补丁和比较文件时注意 Windows 上 git 的 `autocrlf` 设置，避免整文件被判为改动。
- **沙箱**：各平台的差异见 5.2；Windows 的低完整性标记要写进用户文档。

## 15. 分阶段计划和验收标准

### 第 0 阶段：仓库准备

- 仓库 `git init`，建立构建和测试脚本。
- 从一开始就在 CI 里跑三个平台（Linux、Windows、macOS）的单元测试，让路径、进程管理这类平台差异尽早暴露，不用等到第 2 阶段。
- 产品不要求用户手动准备环境：pnpm 等依赖由 `/collab-setup` 处理，这是 1b 的验收项（T14）。1a 阶段开发机上需要的手动准备，写在 `docs/dev-setup.md`。

### 第 1 阶段：Linux 上跑通"Claude 设计、dsh 执行"

分两步走：

- **1a 核心闭环**：用最少的代码跑通"设计 → 实施 → 验收 → 返工 → 汇报"，同时尽早验证风险最大的几个点。
- **1b 产品化**：安装、同步、卸载、配置页、看板、完整版 `doctor`。

这样，如果技术验证发现桥接的设计要改，安装、配置页这些外围部分还没做，不会白做。设计端只有 Claude，但模板、脚本接口和角色字段从 1a 起就按"可互换"的结构来做。

#### 1a：核心闭环

**第一步：技术验证。** 下面这几项决定桥接能不能按现在的设计做。每项写一个最小的试验，结论回填本文：

| 待确认点（第 17 节编号） | 如果不成立 | 结论（2026-10-23） |
|---|---|---|
| 1. 能否派生一个去掉 `ask_user_question` 的工具预设 | 只能靠任务书约束，同时转发它的提问 | 不能派生；改为整份复制 `standard`，可行（9.5） |
| 2. `agentPresets` 的预设 id 和 `mount` 签名 | 桥接建的会话没有工具，桥接方案要改 | 成立；要显式 `mount`（5.4） |
| 3. `workspaceRegistry` 遇到已有工作区时的行为 | 会话挂不到侧栏对应的工作区下 | 成立：复用已有工作区（5.4） |
| 4. 审批和提问能否从会话事件里观察到 | 看不到"等待审批"，卡死检测只能放宽 | 成立：事件可观察，等待状态由事件判断，不看 `agent.status`（9.3） |
| 6. 能否给单个会话的 shell 注入环境变量 | 防套娃只能靠任务书约束；`executors.dsh.env` 在桥接模式下不生效 | 部分成立：只能用 `DSH_` 开头的变量（11.4） |
| 7. 装或更新插件后要不要重启 dsh Web | 影响 1b 的自动同步设计 | 部分成立：新装可热加载，更新要重启（5.6、14.5） |
| 8. Claude Code 插件：命令名前缀、Monitor、skill 怎么引用插件目录 | 影响 skill 的写法和用户要输入的命令 | 部分成立：带前缀；`${CLAUDE_PLUGIN_ROOT}` 可用；hook 运行、Monitor 可用。Desktop 里插件的部分留到 T20（第 8 节、第 17 节） |
| 12. 生成 acp 覆盖层是否可行 | 退回模式拿不到用户在 dsh 里的模型设置 | 成立（11.5） |
| 16. skill 的 `allowed-tools` 能否放行 `collab` 命令 | 每一步都要用户点确认，体验差，但不影响功能 | 成立，可写窄规则（第 8 节） |
| 17. Claude 会话结束后，独立的工作进程能否存活 | D20 要换实现方式 | Linux 终端和 Desktop 下成立（D20）；Windows 待验证 |
| 18. 安装桥接时 pnpm 是否需要联网 | 影响 1b 的安装设计；离线环境要在文档里写明 | 部分成立：首次取得 pnpm 要联网，之后可离线（5.6、9.4） |

实验代码和报告在 `experiments/1a/`，每项一条命令可重跑。

**范围：**

- dsh 桥接插件：完整实现第 9 节。
- 共享运行时的核心部分：
  - `acp-client.mjs`；
  - `adapters/dsh.mjs`：桥接、自动启动 dsh Web、退回 acp；
  - `run.mjs`（含工作进程、基线快照、任务锁）、`watch.mjs`；
  - `config.mjs`：只读写配置文件，不带界面；
  - `detect.mjs`、`platform.mjs` 中用得到的部分；
  - 基础版 `doctor`：只检查跑任务必需的项（dsh 和桥接、git 状态）。
- skill 模板、`hosts/claude.md` 和渲染出的 `SKILL.md`；任务书、问题单模板和汇报格式，先只做中文。
- Claude Code 插件只有 `/collab`，以开发方式加载。
- **手动安装**：
  - 直接从仓库运行：`bin/collab.mjs` 在开发模式下使用仓库里的 `core/`，不经过共享运行时。
  - 桥接：用 `scripts/build.mjs` 打出 `.tgz`，再手动执行 `dsh plugin add`。
  - 步骤写在 `docs/dev-setup.md`。

**进入 1b 的条件：** 1a 的验收全部通过，技术验证的结论都已回填本文。如果某项验证不成立、需要改设计，先更新本文再进入 1b。

#### 1b：安装、同步、配置页、看板

**范围：**

- `setup.mjs` 和 `installed.json`：检测、安装计划、一次确认、安装、自动同步、卸载（第 14 节）。能识别 1a 手动装好的桥接并接管。
- Claude Code 插件补齐 `/collab-setup`、`/collab-config`、`SessionStart` hook，以及插件市场的打包。
- 完整版 `doctor`：第 10 节的全部检查项，包括端点和模型、图片能力、运行时目录的权限。
- `server.mjs`：本地配置页（12.3）和精简看板（12.5）。
- 英文模板和英文界面；用户文档 `docs/user/`。

#### 验收

都在临时目录下新建的 git 仓库里做。

| 编号 | 阶段 | 验收内容 |
|---|---|---|
| T1 | 1a | 桥接插件在 dsh Web 里加载成功，写出发现文件，基础版 `doctor` 通过 |
| T2 | 1a | 派发任务后，会话实时出现在 dsh Web 侧栏**对应工作区**下，能看到每一步 |
| T3 | 1a | 任务需要写工作区外的文件时，dsh Web 里弹出审批；批准后继续；`summary.json` 和 `watch.mjs` 的输出里能看到"等待审批"，且这段时间不算卡死（看板上的显示在 1b 验证） |
| T4 | 1a | 在 dsh Web 里插话，`summary.json` 的 `human_inputs` 里有记录 |
| T5 | 1a | **在 dsh Web 里打开过会话之后，返工续接仍然成功**（这是 headless 方案里失败的那一项） |
| T6 | 1a | `collab run cancel` 能取消；在 dsh Web 里点停止，记录为 `stopped_by_human` |
| T7 | 1a | dsh Web 没开时自动启动，任务照常完成 |
| T8 | 1a | 桥接不可用时退回 `dsh --profile acp`，任务完成并给出提醒 |
| T9 | 1a | 能提取并校验汇报 JSON；故意给出不合法的汇报时，会续接一次要求重发 |
| T10 | 1a | 改动受保护路径会被标记为违规 |
| T11 | 1a / 1b | 能通过 `read_image` 读参考图（1a）；`doctor` 能正确报告当前服务商或网关是否支持图片（1b） |
| T12 | 1b | 配置页：编辑、校验、项目级覆盖都正常，修改从下一次派发开始生效 |
| T13 | 1a | 端到端：一个真实的小功能，走完设计 → 实施 → 验收 → 一轮返工 → 汇报（1a 用手动编辑的配置文件） |
| T14 | 1b | **首次安装**：装好插件后，`/collab-setup` 列出检测结果和安装计划；确认一次后，运行时、pnpm、桥接全部装好；`installed.json` 记录正确；`doctor` 全部通过 |
| T15 | 1b | **自动同步**：提升插件版本后新开 Claude 会话，运行时和桥接自动更新，不需要再次确认；模拟新增一种部件类型时，会停下来请求确认 |
| T16 | 1b | **卸载**：`--uninstall` 后，dsh profile 和各目录都恢复原样，用户和其他工具写入的条目原样保留 |
| T17 | 1a | **防套娃**：在执行端环境（`AGENT_COLLAB_ROLE=executor`，dsh 执行端为 `DSH_AGENT_COLLAB_ROLE=executor`）里调用 `collab run start` 会被拒绝 |
| T18 | 1b | **换服务商**：把 dsh Web 的模型换成另一家服务商后，桥接和退回模式都改用新设置，agent-collab 不需要任何改动；`doctor` 显示的端点和模型随之变化 |
| T19 | 1b | **环境差异**：在"没装 dsh""dsh 装在不同的 Node 版本管理器下""dsh Web 用非默认 profile""没装 pnpm"几种环境下，`/collab-setup` 都能正确检测并给出对应计划（可以用容器或临时的 PATH、`DSH_HOME` 模拟） |
| T20 | 1b | **设计端的两种形态**：Claude Code 终端版和 Desktop 的 Code 标签页都能完成 T13 和 T14 |
| T21 | 1a | **预检和上限**：非 git 目录、有未提交改动时按 D10 处理；返工达到上限时停下来，并汇报剩余问题 |
| T22 | 1b | **接管手动安装**：在 1a 手动装好桥接的机器上运行 `/collab-setup`，能识别并接管已有的桥接，不重复安装 |
| T23 | 1a | **设计端中断**：任务运行中关掉 Claude 会话，任务继续跑完；新会话用 `collab run status` 找到它，`wait` 能接上，`events.jsonl` 没有缺失 |
| T24 | 1a | **基线**：设计端预先写的验收测试、派发前已有的未跟踪文件，都不出现在执行端的补丁里；执行端提交或切分支会被标记为违规 |
| T25 | 1a | **并发**：同一仓库已有任务在跑时，再次 `/collab` 会停下来，让用户选等待、接上或取消 |
| T26 | 1b | **版本错位和清理**：运行时升级而桥接未更新时，协议兼容就照常跑，不兼容就退回 acp 并提示；过期的运行记录和旧运行时按规则清理 |

### 第 2 阶段：codex 和 claude 执行端 + Windows 验证

- 用 T2–T13 中适用的项分别验证 codex 和 claude 执行端。
- 验证"Claude 设计 + Claude 执行"这种同一工具的组合能跑通，`doctor` 会给出同模型提示。
- 每个执行端至少在两种不同的服务商配置下验证（比如官方 API 和一个第三方网关），并确认 `inheritEnv` 两种取值的效果。
- 在 Windows 上验证 T1、T2、T5、T7、T12、T13、T14、T16、T19、T20、T23。

### 第 3 阶段：dsh、codex 作为设计端 + dsh Web 内的配置入口

- 写 `hosts/dsh.md`、`hosts/codex.md`，`setup.mjs` 为这两个设计端渲染并安装 skill（会触发一次新的确认）。
- 验证 dsh 设计 + claude 执行、codex 设计 + dsh 执行等组合。
- 在 dsh Web 的"插件"页注册配置入口。
- 有条件时在 macOS 上做一轮验证。

### 第 4 阶段：多任务并行

每个任务一个 git worktree。要注意执行端的沙箱：worktree 的 git 目录在工作区之外，dsh 和 codex 都可能写不进去。

## 16. 风险

| 风险 | 应对 |
|---|---|
| dsh 是 0.2.x 预发布版，插件服务接口可能变 | 内部调用集中在 `dsh-api.js`；声明支持的版本；`doctor --deep` 做冒烟；失败时退回 acp；发布前在支持的各版本上跑集成测试 |
| dsh Web 必须开着；任务跑到一半时关掉或重启 Web，这一轮会中断 | 自动启动；会话之后可以续接；看板提示 |
| 用户环境千差万别（工具装法、版本、profile、服务商、平台） | 一律探测并允许配置覆盖；T19 和第 2 阶段的多服务商验证覆盖常见情况；`doctor` 把探测结果全部显示出来 |
| 自动同步会修改其他工具的配置 | 只同步已确认过的部件；全部记入 `installed.json` 和 `setup.log`；可以一键卸载；可以关闭 `autoSync` |
| 其他工具或用户手动改写 dsh profile，把桥接弄掉 | 每次同步和 `doctor` 都检查桥接是否还在，缺了就提示或按已确认的范围补上 |
| 执行端继承设计端的环境，用的端点可能和用户在终端里用的不同 | `doctor` 显示每个执行端实际会用的端点和模型；`inheritEnv` 和 `env` 可配置（11.8） |
| `SessionStart` hook 拖慢 Claude 启动 | hook 只做快速检查，耗时步骤放到后台 |
| 不确定当前服务商或网关是否支持图片 | `doctor` 按执行端检查图片能力；不支持时改成只在文字里描述 |
| Windows 的 ACL 沙箱会在工作区留下长期有效的低完整性标记 | 写进用户文档；让用户自己选 |
| 共享运行时放在不支持权限控制的位置，令牌可能被别人读到 | `doctor` 检查并警告；文档写明要求 |
| 能连上桥接，就能在任意目录跑带工具的代理 | 只监听回环、要求令牌；可选的 `allowedRoots` 白名单 |
| 同一工具担任两端时，审查有相同的盲区 | 允许用，但 `doctor` 和汇报里给出提示 |
| 思考强度高时很耗 token | 默认 high；看板显示用量；可设上限 |
| ACP 扩展字段在其他客户端里会被忽略 | 只在我们自己的客户端里用；标准字段保证基本可用 |
| 设计端会话关闭或重启，正在跑的任务被连带结束 | 任务由独立的工作进程负责（D20），新会话可以接上 |
| 运行记录里有命令输出等敏感内容，而且越积越多 | 目录只让本人读写；按 `runRetentionDays` 清理 |
| 运行时和桥接的版本不一致 | 协议版本协商（D22）；不兼容时退回 acp 并提示 |
| dsh 升级改了内置工具预设，我们复制的 `agent-collab` 预设跟不上（dsh 不支持派生，只能复制，见 9.5） | `doctor` 比对它和 dsh 自带的 `standard`（去掉 `tool-ask-user`）是否一致，不一致就提示；桥接发版时同步列表；预设不可用时改用 `standard` 加任务书约束 |

## 17. 实现时需要先确认的点

1. 能否在桥接的 bundle 补丁里基于 `standard` 派生一个去掉 `ask_user_question` 的工具预设（9.5）。**已验证：不能派生，改为整份复制。**
2. `agentPresets` 的预设 id 和 `mount` 的签名，在支持的 dsh 版本中是否和 ccteam 代码注释描述的一致。**已验证（5.4）。**
3. `workspaceRegistry.create` 遇到已存在的工作区时，是复用还是报错。**已验证：复用。**
4. 审批和提问在插件里怎么观察。文档显示审批会在会话日志里写 `approval/asked`、`approval/decided`，提问是 `ask_user_question` 的工具调用；要实测能否通过 `session/event` 收到（9.3）。**已验证（真实模型）：都能收到；插件也能用代码应答，但本设计不用。只测了 `write` 工具的审批和阻塞模式的提问。**
5. 怎么可靠地检测某个执行端当前的服务商或网关是否支持图片（T11）。
6. 桥接能否给单个 dsh 会话的 shell 注入环境变量（11.4 防套娃）。**已验证：可以，但键名必须以 `DSH_` 开头。**
7. 装或更新插件后，热重载能否生效，还是必须重启 dsh Web（5.6、14.5）。**已验证：新装生效，更新要重启。**
8. Claude Code 插件：
   - skill 内容里能否引用插件根目录（比如 `${CLAUDE_PLUGIN_ROOT}`），还是要靠"skill 所在目录"的相对路径。**已验证：`${CLAUDE_PLUGIN_ROOT}` 在 skill 正文、命令正文和 `allowed-tools` 里都会被替换；相对 skill 目录的路径也能用。**
   - `SessionStart` hook 在终端和 Desktop 的 Code 标签页里是否都能运行，输出显示在哪里。**终端已验证：会运行，`-p` 下输出在 stream-json 的 `hook_response` 事件里，运行时有环境变量 `CLAUDE_PLUGIN_ROOT`。Desktop 留到 T20。**
   - `/plugin marketplace add`、`/plugin install` 在 Desktop 里怎么操作。**留到 T20（届时插件真正安装）。**
   - Monitor 工具在终端和 Desktop 里是否都能用。**已验证：都能用。**
   - 插件里的 skill 和命令会带插件名前缀（比如 `/agent-collab:collab`）。用户实际要输入什么、能不能用短名 `/collab`，需要确认；本文写的 `/collab` 等命令名以确认结果为准。**已验证：带前缀；终端 `claude -p` 下短名不可用。交互模式和 Desktop 留到 T20。**
   - 另外发现：命令正文里的 `!` 预执行在 `claude -p` 下不执行。本设计不依赖它。
9. codex 作为设计端时，用 skill 目录还是 `codex plugin`；codex 的 skill 目录在各平台上的位置（第 3 阶段）。
10. dsh 作为设计端时，后台任务和 `job_output` 的具体用法（第 3 阶段）。
11. claude 执行端的具体 CLI 参数：三个权限级别分别怎么对应（11.9）、有没有结构化输出参数（第 13 节）（第 2 阶段）。
12. 从 dsh Web 所用 profile 的用户配置层挑出服务商条目、生成 acp 覆盖层的做法是否可行：挑哪些条目才完整，这些条目在 acp 组合里能否正常加载（11.5）。**已验证：可行；只测了一个服务商条目加默认模型的最小组合。**
13. 桥接能否从 dsh 的服务目录列出可选模型，给配置页用（9.2、12.3）。
14. 怎么在不消耗太多 token 的前提下，检查 codex、claude 实际会用的端点和模型（11.8）。
15. dsh 桌面版（Electron 管理的 `desktop` profile）能否、以及怎么安装桥接（5.6）。**2026-10-23 提前在 Windows 上做探针**（实验 `experiments/1a/15-desktop-windows/`，由 Windows 上的 Claude Code 运行）：桌面版自带的命令入口能否装 `.tgz`、插件能否拿到和 Web 一样的服务、会话能否显示在侧栏、桌面版是否认 `DSH_HOME`、只装桌面版时有没有 Node 和命令行 `dsh`。
16. Claude Code 插件里的 skill，能否用 frontmatter 的 `allowed-tools` 放行 `collab` 命令（第 8 节）。**已验证：可以，并且能写成只放行一个脚本的窄规则。**
17. Claude 会话结束时（包括在 Desktop 里关掉会话），从 Bash 启动的独立工作进程能否存活；Windows 上用什么方式脱离父进程（D20）。**Linux 已验证：终端和 Desktop 下都能存活（`detached` 加 `unref`）。Windows 待验证（第 2 阶段 Windows 验证时做）。**
18. `dsh plugin add <tgz>` 时 pnpm 是否需要联网，离线机器能否安装（9.4）。**已验证：首次取得 pnpm 要联网，之后可离线。**
19. 桥接能否拿到 dsh Web 的访问地址，生成直达某个会话的链接（9.1）。

## 18. 参考和许可

- [ozankasikci/sol-skill](https://github.com/ozankasikci/sol-skill)（MIT）：流程、任务书模板、汇报格式、补丁生成方法。改编的部分在 NOTICE 里署名。
- [firstintent/ccteam](https://github.com/firstintent/ccteam)（MIT）：dsh 插件桥接的思路（`dsh-plugins/ccteam-ui/src/transport.ts`）。只参考设计，不复制代码。
- [Agent Client Protocol](https://agentclientprotocol.com)；`@agentclientprotocol/sdk`（Apache-2.0）。1a 决定自写精简实现，不附带 SDK，只参照它的类型定义核对字段；以后如果附带，要保留许可证。
- dsh 源码和文档：见第 5 节。

---

## 附录 A：一台 Linux 开发机的实测记录（2026-10-23）

> 这些只是开发时参考用的一台机器的情况，**不是产品的前提或默认值**。

### A.1 机器情况

| 项目 | 情况 |
|---|---|
| dsh | 0.2.1-rc.2，装在某个 Node 版本管理器的目录下；实测期间安装位置变过一次，说明安装位置确实会变 |
| dsh profile | `web`、`headless`；dsh Web 用默认端口 3080 |
| 模型服务商 | dsh 和终端 Claude CLI 都经由一个本地模型网关访问模型；这类网关可能自动往 dsh profile 里写服务商条目，安装和卸载时要原样保留 |
| Claude Desktop 与终端的环境差异 | Desktop 会话里的 `ANTHROPIC_*` 模型变量和终端不同，正好是 11.8 所说的情况 |
| codex | 0.164.0，有 skill 目录 `~/.codex/skills/` 和 `codex plugin` 命令 |
| claude | Claude Code 2.1.309 |
| Node / corepack / pnpm | Node 22 自带 corepack 0.36.0；pnpm 未安装 |
| 沙箱 | bwrap 可用 |
| 磁盘 | 开发仓库所在的文件系统没有真正的权限位 |

### A.2 headless 实测

在一个普通目录里用只读模式跑了一个小任务（分 4 次执行 `sleep 10; date`）：

- 能正常跑完：退出码 0，用时 52 秒，用量 28.6K token，`--json` 事件流完整。
- dsh Web **刷新页面后**能看到这个会话，但它落在"未分组"下，因为没有挂到工作区。
- 运行中不会实时刷新。运行到一半时打开，界面误显示"任务已停止：DSH 进程在本轮完成前退出"，而任务其实在正常跑。
- 跑完后刷新，能看到完整记录。
- 在 dsh Web 里打开这个会话后，Web 会占住它的写锁，之后 `--session-id` 续接一直报错 `already owned by an active write handle`。离开会话 1 分钟后重试 3 次仍然失败。
- 测试留下的会话留在了 dsh Web 的"未分组"里。

## 附录 B：开发约定

- 开发期仓库位置不固定，代码和测试不能依赖它；它所在的文件系统可能不支持权限位。共享运行时仍然装在各系统自己的用户目录里。
- 设计讨论和实现分开进行：本文件由设计讨论会话维护，实现在单独的会话里进行。实现中发现和本文不符的地方，先更新本文再改代码。
- 测试不能依赖开发机的特有配置：集成测试用临时的 `DSH_HOME`、`AGENT_COLLAB_HOME` 和 PATH，必要时用容器模拟不同环境（见 T19）。
- 桥接和端到端测试优先用本地假 LLM 服务：一个 Node HTTP 服务，按 OpenAI 兼容接口（dsh 服务商条目的 `api: openai-completions` 加 `baseURL`）按脚本返回文字和工具调用，结果确定、不花 token。真实模型只用于 T11、T13。可行性在 1a 实现的桥接一步先做探针确认，不成立就改用真实模型（1a 定，用户 2026-10-23 确认）。
