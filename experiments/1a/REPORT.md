# 第 1a 阶段第 1 批技术验证报告

本文件：第 1 批（§17 第 2、1、3、6、7、18、12 项）的实验汇总。实验在 2026-10-23 用临时 `DSH_HOME` 和隔离的 dsh 进程执行；结论均来自对应目录的 `run.mjs` 实际输出。

## 汇总表

| 编号 | 问题 | 结论（成立/不成立/部分成立/需要模型） | 关键证据摘录 | 不成立时对 PLAN.md 的影响（§15 表格里的后备方案涉及哪些章节） |
|---|---|---|---|---|
| 02 | `agentPresets` 的预设 id 和 `mount` 签名 | 成立 | 实测 id：`standard`、`ptc`、`minimal`、`cordis`；`mount.length === 2`，源码为 `async mount(ctx, id)`，返回 `{ id: generation.mount.presetId }` | —（成立；但 §5.4 写的 `code` 应为 `ptc`） |
| 01 | 能否在 bundle 补丁里基于 `standard` 派生去掉 `tool-ask-user` 的预设 | 不成立 | `agent-collab` 复制版可注册，去掉 `tool-ask-user` 后与 `standard` 逐字一致；`dsh-agent-preset` 无 `extends` 字段，补丁层只匹配顶层或原始 group 行，`preset-standard` 不是 group；两条派生写法均未改变 `standard` | §9.5、§15“1a”第 1 行、§17 第 1 项：只能整份复制（有 dsh 升级漂移风险）或退回任务书约束并转发提问 |
| 03 | `workspaceRegistry.create` 对已有路径是复用还是报错；`attachSession` 是否可用 | 成立 | 同一目录两次 `create` 返回相同 id，第二次 title 被忽略，列表仍 1 条；workspace 实体 `attachSession(sessionId)` 可用，cwd 匹配后挂入 `sessionIds` | —（成立） |
| 06 | 能否只给单个会话的 shell 注入环境变量 | 部分成立 | 会话 A 的 bash 输出 `executor`，会话 B 为 `(no output)`；`AGENT_COLLAB_ROLE` 被 `shellEnv.register` 以 invalid key 拒绝，必须用 `DSH_AGENT_COLLAB_ROLE` | §11.4、§15“1a”第 6 行、§17 第 6 项：改用 Agent setup 的 `shellEnv` contributor 和 `DSH_` 前缀；`_meta.agentCollab.env` 的普通变量注入不可用 |
| 07 | 装/更新插件后是否要重启 dsh Web | 部分成立 | 运行中安装新 bundle：热加载成功（v1 apply，PID 不变）；同包更新到 v2：30 秒内无 v2 apply，重启后出现且 v2 行为文件存在 | §5.6、§14.5、§15“1a”第 7 行：新装可热加载，CLI 同包更新要重启；1b 自动同步需按此设计 |
| 18 | `dsh plugin add <tgz>` 的 pnpm 来源；无依赖 tgz 是否需联网 | 部分成立 | 无 pnpm 时退出 127，提示 `pnpm was not found`；corepack shim 首次会下载 pnpm（需联网）；pnpm 就绪后，registry 不可达 + `--offline` 安装无依赖 tgz 成功并选中 bundle | §9.4、§14 安装说明、§15“1a”第 18 行：文档必须写明 pnpm bootstrap 的联网要求；离线安装本身可行 |
| 12 | 生成 acp 覆盖层是否可行 | 成立 | 覆盖层加载成功；ACP `initialize` 成功；`session/new` 的 `model` configOption 当前值为 `["example-provider","example-model"]`，即覆盖层指定值 | —（成立；实验中用的是简化顶层块选择器，真实实现需可靠 YAML 解析） |

## 各项说明

### 02 — agentPresets 的 id 与 mount 签名

实验目录：`experiments/1a/02-agent-presets/`。测试插件通过 `ctx.inject(['agentPresets'])` 取得服务，轮询等待预设注册完成后写出 `exp-02.json`。实际 id 为 `standard`、`ptc`、`minimal`、`cordis`，全部没有 `broken` 诊断；`mount` 是两参数方法，源码位于 `<dsh包目录>/dsh-agent-preset-registry/lib/index.js`，与实测一致。PLAN §5.4 的“内置预设有 standard、code、minimal、cordis”应改为 `standard`、`ptc`、`minimal`、`cordis`（或把 `ptc` 作为额外预设记录）；这是文档与当前 dsh 的差异，不改变桥接方案。

### 01 — 基于 standard 派生工具预设

实验目录：`experiments/1a/01-preset-derive/`。`plugin/cordis.patch.yml` 里的 `preset-agent-collab` 是从当前安装的 `dsh-web-app/presets/standard.patch.yml` 复制、去掉 `tool-ask-user` 块后的完整列表；它实际注册成功，`readDocument` 文本在去掉 `tool-ask-user` 后与 `standard` 完全一致。派生尝试没有可用入口：`dsh-agent-preset` 的 Config 只接受显式 `plugins` 数组且没有继承字段；`cordis-plugin-include` 的补丁算法只对原始 `group: true` 的行递归匹配子 id，而 `preset-standard` 是 `dsh-agent-preset` 自己管理的 EntryGroup。实验中的两条派生写法（向 `preset-standard` 插入子行、覆盖 `preset-standard:tool-ask-user`）均未生效，`standard` 仍保留 `tool-ask-user`。结论是“不成立（无法派生）”，但“复制”方案本身可运行；因此桥接可以采用复制版 `agent-collab` 预设，同时承担 dsh 升级后的列表同步成本。

### 03 — workspaceRegistry.create 与 attachSession

实验目录：`experiments/1a/03-workspace-registry/`。第二次 `create` 返回同一个 workspace id，`title` 仍是第一次的，`list()` 只有一条；说明是复用而不是报错或新建。`attachSession` 是 workspace 实体上的方法（不是 `workspaceRegistry` 服务上的方法）；用 `ctx.sessions.create` 建一个 cwd 相同的会话后调用成功，`sessionIds` 包含该会话。桥接可以安全地对已有目录重复 `create`，再对会话调用 `attachSession`。

### 06 — 单个会话的 shell 环境变量

实验目录：`experiments/1a/06-session-shell-env/`。dsh 的 shell 环境注入点是 `dsh-shell-env` 的 `ctx.shellEnv.register`：在 Agent 的 `setup` 中注册 contributor，resolver 用 `execution.agent === agent` 限定当前 Agent。实测会话 A 的 bash 工具输出 `executor`，会话 B 输出 `(no output)`，说明只影响一个会话；contributor 随 Agent scope 释放。`dsh-shell-env` 强制键名以 `DSH_` 开头，`AGENT_COLLAB_ROLE` 会被拒绝，因此 PLAN §11.4 的变量名要改为 `DSH_AGENT_COLLAB_ROLE`。另外，直接 `ctx.agents.create` 不会自动挂工具预设（Web 会话控制器在 setup 里调用 `agentPresets.mount`）；桥接实现也必须显式调用 `mount(agentCtx, presetId)`，否则会话没有工具。这一点对 §5.4/§9.5 的实现有影响。

### 07 — 安装/更新插件后的热重载

实验目录：`experiments/1a/07-hot-reload/`。Web 运行中安装新 bundle 后，HMR 重组合使插件立即执行（v1 日志出现，Web PID 未变）。随后安装同包 v2（`dsh.profile.bundles` 不变，仅包文件与依赖版本变化），30 秒内没有 v2 的 apply；终止并重启 Web 后 v2 才生效，且 v2 的行为文件出现。结论：新装 bundle 可热加载；CLI `dsh plugin add` 的同包更新需要重启。1b 的自动同步不能假设 CLI 更新会自动重载，更新流程应显式提示并记录重启。

### 18 — pnpm 来源与离线安装

实验目录：`experiments/1a/18-pnpm-offline/`。本机没有全局 pnpm；`dsh plugin add` 直接执行 PATH 上的 `pnpm`，没有时退出码 127 并提示 `pnpm was not found`。用 `corepack enable --install-directory <临时 bin> pnpm` 生成 shim 后可用，但首次使用 corepack 会下载 pnpm（输出含 `Corepack is about to download ...pnpm...tgz`），说明 bootstrap pnpm 需要联网，除非预置 corepack 缓存或单独安装 pnpm。pnpm 就绪后，将 registry 设为不可达的 `http://127.0.0.1:9` 并加 `--offline`，安装无依赖 .tgz 成功，`dsh.profile.bundles` 自动加入该 bundle。局限：`--offline` 只模拟本次 `pnpm add` 不访问 registry，不能证明 corepack 首次下载也不需要网络。

### 12 — acp 覆盖层

实验目录：`experiments/1a/12-acp-overlay/`。在临时 `DSH_HOME` 的 `profiles/web/cordis.patch.yml` 写入 `llm-pi-ai` 的假 provider（base URL 为不可达的 `http://127.0.0.1:9/v1`，不写 key）和 `agent-default-model`，然后按顶层块挑出 `llm-*` 与 `agent-default-model`，加上 `acp` 的 provider/model 生成覆盖层。`dsh --profile acp --patch <覆盖层>` 正常启动；ACP `initialize` 返回 `deepseek-harness-acp` / protocol 1；`session/new` 返回的 `configOptions` 中 `model.currentValue` 为 `["example-provider","example-model"]`，与覆盖层一致，说明覆盖层在 acp 组合里正常加载并成为当前模型。实验用的是简化顶层块选择器；真实实现应使用可靠的 YAML 解析并处理 profile 用户层可能出现的全部行形态。

## 未解决问题与后续

- **01**：派生不可行，只能复制 `standard` 的插件列表；dsh 升级后需要自动同步或人工核对。若用户不接受复制漂移，按 §15 后备方案改为任务书约束 + 转发 `ask_user_question`。
- **06**：变量名需改成 `DSH_AGENT_COLLAB_ROLE`；桥接必须显式 `agentPresets.mount`。这两点会影响 §5.4、§9.5、§11.4 的实现文字，需在回填 PLAN 时确认。
- **07**：CLI 同包更新不热重载；1b 自动同步需要重启提示/流程。
- **18**：真实离线机器需预置 pnpm（corepack 首次下载需要网络）；文档要明确。
- **12**：覆盖层条目挑选逻辑还需要在真实实现里支持完整 YAML；本实验只验证了 `llm-pi-ai` + `agent-default-model` 的最小组合。
- 本批没有需要模型才能验证的项；06 直接调用 `ctx.tools.execute` 走真实 bash 工具路径，但没有跑模型。若要求验证模型看到并调用 bash，仍需第 2 批的模型配置。

## 建议的 PLAN.md 回填点（给 Claude 核对）

- §5.4：内置预设 id 应为 `standard`、`ptc`、`minimal`、`cordis`；原文的 `code` 与当前 dsh 不符。
- §5.4/§9.5：`agentPresets.mount(ctx, id)` 返回 `{ id }`；直接 `ctx.agents.create` 不会挂预设，桥接要在 `setup` 中显式 `mount`。
- §9.5：基于 `standard` 派生没有可用语法，只能整份复制列表或按后备方案靠任务书约束；复制版 `agent-collab` 已验证可工作，但需承担 dsh 升级后的列表同步。
- §11.4：`AGENT_COLLAB_ROLE` 不是 `dsh-shell-env` 允许的键；应改为 `DSH_AGENT_COLLAB_ROLE`，通过 Agent setup 的 `shellEnv.register` 注入，不能依赖 `_meta.agentCollab.env` 的普通变量。
- §5.6/§14.5：运行中安装新 bundle 可热加载；CLI `dsh plugin add` 的同包更新需要重启 dsh Web。1b 自动同步要明确重启提示/流程。
- §9.4/§14：`dsh plugin add` 调用 PATH 上的 pnpm，dsh 不会自动使用 corepack；corepack 首次获取 pnpm 需要联网。无依赖 .tgz 在 pnpm 就绪且 `--offline` + registry 不可达时能安装。
- §15“1a”/§17：02、03、12 成立；01 不成立；06、07、18 部分成立；本批没有“需要模型”项。
## 运行与清理

每个目录执行 `node experiments/1a/<目录>/run.mjs`。脚本只写临时 `DSH_HOME`，启动 `dsh web --port 0 --no-open` 时从输出解析实际端口；所有子进程都设超时，`finally` 中按自己 spawn 的 PID 停止并删除临时目录。

## 验证与清理结果

- `npm test`：3/3 通过（2026-10-23 执行；`node --test` 未发现实验目录中的文件）。
- 每个 `run.mjs` 都在临时 `DSH_HOME` 下执行，使用 `dsh web --port 0 --no-open`；结束时按自己 spawn 的 PID 停止 Web 进程并删除临时目录。
- 实验完成后复查：无遗留的 `agent-collab-1a-*` 临时目录，无遗留的被测 dsh 进程；`pgrep -af dsh` 只显示当前沙箱自己的进程。

## Claude 侧：§17 第 8、16、17 项（Claude 实测，2026-10-23）

实验目录：`experiments/1a/08-claude-plugin/`（第 8、16 项）、`experiments/1a/17-worker-survival/`（第 17 项）。都用 `claude -p` 实测（Claude Code 2.1.309，Haiku），共调用模型 11 次（其中 2 次因命令写法不匹配权限规则而重跑），花费约 0.035 美元。

| 编号 | 问题 | 结论 | 关键证据 | 对 PLAN.md 的影响 |
|---|---|---|---|---|
| 8 | 命令名前缀 | 带前缀；`-p` 下短名不可用 | init 里是 `agent-collab:probe-cmd`；`/probe-cmd` 回复“isn't available” | §8 等处的 `/collab` 应写成 `/agent-collab:collab`；交互模式下短名【未验证】 |
| 8 | skill 怎么引用插件目录 | `${CLAUDE_PLUGIN_ROOT}` 可用 | skill、命令正文和 `allowed-tools` 里都替换成绝对路径；hook 环境变量里也有 | skill 直接写 `node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs" …` |
| 8 | SessionStart hook | `-p` 下运行 | stream-json 有 `hook_response`，标记文件写出 | Desktop 下【未验证】 |
| 8 | Monitor | 可用 | `-p` 的工具清单有 Monitor；Desktop 的 Code 标签页里本验收会话的工具清单也有 Monitor | 无 |
| 8 | `!` 预执行 | `-p` 下不执行 | 原样留在文本里 | 设计不依赖它，无影响 |
| 8 | Desktop 里 `/plugin` 怎么操作 | 【未验证】 | 需要用户在 Desktop 里操作 | — |
| 16 | `allowed-tools` 放行 `collab` | 成立 | `Bash(node:*)` 放行、对照组被拒；窄规则 `Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs":*)` 只放行这一个脚本 | §8：用窄规则只放行 `collab.mjs` |
| 17 | 会话结束后工作进程能否存活 | CLI 下成立 | detached + unref：`claude -p` 退出后心跳继续；`run_in_background`：`claude -p` 会等它跑完才退出 | D20 的做法可行；不能用 `run_in_background` 跑工作进程。Desktop：用户在 Code 标签页新开会话启动 detached 工作进程后删除该会话，进程继续写心跳，父进程变为 `systemd --user`，【已验证】2026-10-23。Windows【未验证】 |

## 第 2 批：§17 第 4 项（2026-10-23，dsh 实测，真实模型）

实验目录：`experiments/1a/04-approval-question/`。用临时 `DSH_HOME` 启动被测 `dsh web --port 0 --no-open`，测试插件建 3 个 `standard` 预设会话，沙箱 `read-only`、审批策略 `ask`：第一次写文件由插件批准，第二次拒绝；第三个会话调用一次 `ask_user_question` 并由插件回答固定答案，再让模型复述。模型配置由 `AC_REAL_DSH_HOME` 指向的真实 profile 中只读挑出的 `llm-*` 与 `agent-default-model` 条目生成，`.env` 只建符号链接。

| 问题 | 结论 | 关键事件摘录 | 对 PLAN.md 的影响 |
|---|---|---|---|
| 审批请求和结果能否通过 `ctx.on('session/event')` 收到；事件名和关键字段 | 成立：能收到 `approval/asked` 和 `approval/decided`，两者用同一个 `id` 配对；`approval/asked` 字段为 `id`、`toolName`、`callId`、`reason`；`approval/decided` 字段为 `id`、`outcome`（`allowed-once`/`rejected`） | `approval/asked {"id":"e6c72426…","toolName":"write","callId":"call_00_…","reason":"escalate sandbox to workspace-write: …"}`；`approval/decided {"id":"e6c72426…","outcome":"allowed-once"}`；拒绝组同一 `id` 的 `outcome` 为 `"rejected"` | §9.3 的 `approval_pending`/`approval_resolved` 可以直接由这对事件驱动；§5.2 的“每次审批记两条事件”成立，字段可按实测补进 §9.3 |
| “等待审批”能否从会话状态（如 `agent.status`）或事件里判断出来 | 成立（限定方式）：`agent.status` 只有 `idle`/`running` 两种，等待审批时仍是 `running`（`approval/asked` 和 `approval/decided` 时都为 `running`），不能单独判断；事件可以：`approval/asked` 已到、`approval/decided` 未到即为等待中 | `status-at-asked=running`、`status-at-decided=running`、`status-at-when-idle=idle` | §9.3 不要依赖 `agent.status` 判定审批等待；桥接需要自己维护 pending 审批集合（或从事件折叠），再发 `approval_pending`/`approval_resolved` |
| 插件能否用代码批准或拒绝审批；用的是哪个服务、哪个方法 | 成立（本实验没有连接 Web UI 客户端）：插件注册 `ctx.on('approval/request', (request, next) => …)` 作为 waterfall 应答者，返回 `"allowed-once"` 或 `"rejected"`；服务是 `approval`（`ctx.approval`），其 `request()` 方法发出 `approval/request`；没有单独的服务“answer”方法 | 批准组 `write` 成功、文件写出、`approval/decided outcome="allowed-once"`；拒绝组工具返回错误、文件不存在、`outcome="rejected"` | §9.3/§11.9：桥接插件自身可以作为审批应答者（实现自动批准/拒绝或超时策略）；若仍需人审，在应答器里调用 `next()`，交给 Web UI |
| `ask_user_question` 的提问在插件里能否看到、能否回答、回答后模型能否收到 | 成立（有保留；本实验没有连接 Web UI 客户端）：`tool/call` 事件带完整 `questions`；`user-questions/request` 的服务请求也带完整 `questions`（`requestKeys: questions, agent, signal`，legacy 模式没有 `callId`）；插件在应答器返回 `{answers:[{id:"magic",selected:[],custom:"PLUM-731"}]}` 后，`tool/result` 含答案，模型回复 `ANSWER=PLUM-731`。保留：标准预设的 legacy 模式 `userQuestions` 投影为 `timed=false`、`active=[]`，不能靠投影看待答问题；投影只记录 timed 模式的 continued 问题（源码检查，未实测 timed） | `tool/call {"name":"ask_user_question","callId":"call_00_…","questions":[{"id":"magic","question":"What is the magic word?"}]}`；服务请求 `{"requestKeys":["questions","agent","signal"],"questions":[…]}`（无 `wait`/`callId`）；最终回复 `"ANSWER=PLUM-731"` | §9.3/§9.5：`question_pending` 可监听 `tool/call`（有 `callId`）或 `user-questions/request`（无 `callId`，需与 tool/call 关联）；legacy 模式的待答问题不在 `userQuestions` 投影里；桥接默认去掉 `tool-ask-user` 后这条路径不会出现，fallback 时需使用应答器或 Web UI |

### 说明

- **模型类别**：网关上的某个对话模型（报告不记录服务商名称、网关地址和模型 id）。
- **运行次数和轮数**：共运行 5 次（首次发现 legacy 投影不记录待答问题后修正实验判据，后 4 次为复跑；模型行为一致）；每次 3 个会话、3 个用户轮次，模型响应 6 次（每个会话“工具调用 + 最终回复”两步）。最终一次运行的 usage 为 input≈2.0k、output≈0.48k token，provider 报的 total≈46k（含缓存）；调用量很小，未单独估算金额。
- **审批路径**：被测会话的沙箱由 `agent.session.append('sandbox/mode', {mode:'read-only'})` 设为只读，审批策略用 `approval/policy: ask`；模型按任务书在 `write` 调用里带 `sandbox_permissions:"workspace-write"` 和 justification，触发 `approval/request`。插件只对这两个测试会话应答，其他请求 `next()`。
- **提问路径**：标准预设里的 `tool-ask-user` 是 legacy 阻塞模式；插件监听 `user-questions/request`，记录服务传入的 `questions` 后返回固定答案。工具结果和模型最终回复都包含该答案。
- **隔离与清理**：被测 dsh 的 `DSH_HOME` 是 `os.tmpdir()` 下新建目录，`dsh web --port 0 --no-open`；`.env` 只建符号链接，实验代码只对链接做 `lstat`/`readlink`，不读取内容；结束后按 PID 停止 Web、删除链接本身和临时目录，检查 `/tmp` 无 `agent-collab-1a-04-*` 残留。
- **测试**：`npm test` 仍为 3/3（`node --test` 未发现 experiments 目录下的脚本）。
- **局限**：被测 dsh Web 没有连接 Web UI 客户端；真实 Web 会话里 `dsh-api-remotes` 还有面向 UI 的 `approval/request`/`user-questions/request` 应答器，插件监听顺序和优先级未测（必要时可用 `prepend`）。只测了 `write` 工具的审批，未测 bash 的审批事件；只测了 legacy `ask_user_question`，未测 timed 模式的 `continued`/投影路径；`agent.status` 是采样观察，不是连续监听；模型具有随机性，结论按 5 次运行的行为一致给出。

### 对 PLAN.md 的回填建议

- §9.3：审批状态直接由 `approval/asked`/`approval/decided` 事件对生成；等待审批不依赖 `agent.status`。
- §9.3/§9.5：`question_pending` 的可靠来源是 `tool/call` 事件（带 `callId`）；`user-questions/request` 可提供问题内容但 legacy 模式不含 `callId`，需要与 `tool/call` 关联。`userQuestions` 投影只覆盖 timed 模式的 continued 问题。
- §9.3/§11.9：桥接插件可以作为 `approval/request` 的应答者，用返回 `"allowed-once"`/`"rejected"` 实现自动审批；若采用人审，则应答器应委托给 Web UI。
