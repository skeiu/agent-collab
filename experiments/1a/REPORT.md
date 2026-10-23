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

