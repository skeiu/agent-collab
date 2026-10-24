本文件：第 1a 阶段实现的分步计划、各步验收标准和需要用户拍板的实现决定。派发或验收 1a 的某一步时读；步骤划分、依赖或验收标准变化时更新；1a 结束后归档到 history/。

# 1a 实现分步计划

> 状态：Claude 2026-10-23 起草；7 个实现决定【已确认】用户 2026-10-23 全部按推荐方案，已回填 PLAN.md 并登记在 [DECISIONS.md](DECISIONS.md)。范围和产品验收（T 编号）以 [PLAN.md](../PLAN.md) §15“1a：核心闭环”为准，本文只做拆分，不改范围。

## 拆分原则

- 先定接口，再并行：桥接（ACP 服务端）和运行时（ACP 客户端、工作进程）分别由不同的任务实现，两边按同一份接口契约开发，各自用假的对端测试。
- 每一步都能单独验收：`npm test`（CI 三平台）只跑不依赖 dsh 的单元测试；需要真 dsh 的放在 `tests/integration/`，一条命令运行，按 [RUNBOOK.md](RUNBOOK.md)“派发 dsh 任务”隔离，不进 `node --test`。
- 尽量少用真实模型：桥接和端到端测试优先用本地假 LLM 服务（见决定 4），真实模型只用于 T11（读图）和 T13（端到端）。
- 分工按 AGENTS.md：dsh 写代码，Claude 写任务书、接口契约、验收；每步验收时 Claude 自己重跑。

## 实现决定（已确认）

| # | 问题 | 推荐 | 替代方案 | 理由与把握 |
|---|---|---|---|---|
| 1 | ACP 用 SDK 还是自写（PLAN.md §9.4 写明“1a 定”） | 自写精简版：换行分隔的 JSON-RPC 2.0，只实现我们用到的方法；客户端和桥接各一份 | 随仓库附带 `@agentclientprotocol/sdk` 1.4.0（Apache-2.0），要加 NOTICE；桥接里要用 `bundledDependencies` 打包 | 用到的方法不到 10 个，协议是标准 JSON-RPC，自写约 200 行；免去附带第三方代码和许可证处理。方法和字段以 dsh 安装里那份 SDK 的类型定义为准核对。把握：高 |
| 2 | acp 退回模式生成覆盖层时，YAML 用什么解析（PLAN.md §11.5 要求可靠解析） | 借用 dsh 安装目录里自带的 `yaml` 包（从解析出的 dsh 入口位置找；本机实测 dsh 安装里有 `yaml` 和 `js-yaml`） | 自写只支持 cordis.patch.yml 顶层列表的解析器；或随仓库附带一个 YAML 库 | 这条路径只在 dsh 存在时运行，dsh 自己就是用这些库读配置，格式一定兼容；不引入新依赖。代价是依赖 dsh 的内部依赖，找不到时退回模式不可用，`doctor` 报告原因。把握：中，实现时确认包名和导入方式。S4 核实 dsh 加载 patch 用的是 `js-yaml`，实现改用它【已验证】2026-10-24 |
| 3 | 接口契约（桥接的 `_meta` 和扩展通知、统一事件格式、`state.json`/`summary.json` 字段、CLI 的 JSON 输出）放在哪 | 新建 `docs/protocol.md`，PLAN.md §8、§9、§11.3 各加一行链接 | 全部写进 PLAN.md | 这是字段级的实现约定，篇幅大、改动频繁；PLAN.md 已约 1000 行。按“一类事实一个权威来源”，字段以 protocol.md 为准，PLAN.md 只留设计意图 |
| 4 | 桥接和端到端测试怎么跑模型 | 本地假 LLM 服务：一个 Node HTTP 服务，按 OpenAI 兼容接口（dsh 服务商条目 `api: openai-completions` 加 `baseURL`）按脚本返回文字和工具调用；先在 S2 第一步做探针确认可行 | 全部用真实模型（每次跑都要用户的网关和 R6 例外） | 确定、可重复、不花 token，还能在 CI 外随时重跑；审批、提问、续接都能用脚本触发。探针不成立时退回真实模型。把握：中 |
| 5 | skill 正文（`SKILL.template.md`、`hosts/claude.md`、任务书和问题单模板）谁写 | Claude 起草正文，dsh 写 `render-skill.mjs` 和构建步骤 | 全部由 dsh 写 | skill 是写给设计端（Claude）看的流程说明，属于“任务书和验收”一类的文字工作，不是代码 |
| 6 | 和 PLAN.md §7.1 目录规划的出入 | 允许在 `core/` 下加少量辅助文件（如 `core/jsonrpc.mjs`、`core/schema-check.mjs`、`core/report.mjs`）；不建 `config/defaults.json`，默认值只写在 schema 里。由 Claude 在 PLAN.md §7.1 补记 | 严格按 §7.1 的文件 | 拆出可单测的小模块更好测；默认值放两处违反“一个权威来源”，§12.1 本来也说默认值在 schema 里。按附录 B，先补 PLAN.md 再合入代码 |
| 7 | 项目级配置能覆盖哪些项（PLAN.md §12.1 只说 schema 里声明，没定具体哪些） | 仓库里的 `.agent-collab.json` 不能设权限和执行环境类的项：`permissionPreset`、`unattendedApproval`、`allowedRoots`、`env`、`inheritEnv`、`executors.*.command`、`executors.*.env`、`dsh.*`、`autoSync`、`runRetentionDays`；其余三级都可以 | 所有项都允许项目级覆盖 | 项目文件随仓库来，可能不可信：克隆一个别人的仓库，就能把权限改成 `danger-full-access` 或把执行端命令指向任意程序。这是 PLAN.md 没覆盖到的安全缺口，确认后回填 §12.2（加一列“可覆盖级别”）。把握：高 |

## 步骤

依赖：S0 ∥ S1 → S2 ∥ S3 → S4 → S5 → S6。S0 和 S1 互不依赖，可以同时进行。S2 和 S3 互不依赖，但都在同一个工作目录里改，同时做时 `npm test` 会跑到对方写到一半的测试，所以按 S2、S3 的顺序派发，一步验收完再派下一步。

| 步 | 谁 | 内容 | 覆盖的 T |
|---|---|---|---|
| S0 | Claude | 接口契约 `docs/protocol.md`（决定 3），用户审阅 | — |
| S1 | dsh | 基础模块：JSON-RPC 和 ACP 客户端、配置、汇报校验、平台工具（任务书 [briefs/1a-s1-foundation.md](briefs/1a-s1-foundation.md)） | T9 的提取和校验部分 |
| S2 | dsh | 桥接插件 `dsh-bridge/` 全部第 9 节；构建打出 `.tgz`；假 LLM 服务和桥接集成测试（任务书 [briefs/1a-s2-bridge.md](briefs/1a-s2-bridge.md)） | T1（除 doctor）、T2–T6 的桥接部分 |
| S3 | dsh | `run.mjs`（工作进程、基线、锁、事件、汇报提取和重发、补丁、违规、卡死、取消）、`watch.mjs`、`bin/collab.mjs` 开发模式；用假执行端测试（任务书 [briefs/1a-s3-runtime.md](briefs/1a-s3-runtime.md)） | T6 取消、T9、T10、T17、T21 的锁部分、T23、T24、T25 |
| S4 | dsh | `adapters/dsh.mjs`（桥接、自动启动 Web、退回 acp 和覆盖层）、`detect.mjs`、基础版 `doctor` | T1 doctor、T7、T8 |
| S5 | Claude + dsh | skill 正文和模板（Claude）；`render-skill.mjs`、构建生成 `SKILL.md`、`.claude-plugin/plugin.json`、开发方式加载（dsh）；`docs/dev-setup.md` 的手动安装步骤 | T21 的预检部分 |
| P15 | dsh 写探针，Windows 上的 Claude Code 运行，Claude 验收 | PLAN.md §17 第 15 项：dsh 桌面版（Windows）能否装桥接（任务书 [briefs/1a-p15-desktop-windows.md](briefs/1a-p15-desktop-windows.md)）。不在 S 序列里，不阻塞 1a，可以和 S1 并行 | — |
| S6 | Claude（部分要用户操作） | 1a 产品验收：在临时目录新建的 git 仓库里逐项跑 1a 的 T 编号 | 全部 1a 项 |

## 各步验收标准

所有步骤共同要求：`npm test` 在本机和 CI 三平台通过（CI 要推送，须用户授权）；重负载压力测试不作常规要求（见 [DECISIONS.md](DECISIONS.md)“项目决策”）；不需要 `npm install`；不写死路径和端口；新文件开头有一行职责说明；提交前按 RUNBOOK 扫描本机信息。下面只列各步自己的标准，详细的 AC 写在各步任务书里。

- **S0**：契约覆盖 S2、S3 之间传递的每一个字段和每一种事件；PLAN.md §9.2、§9.3、§11.3、§8“运行目录和任务状态”里出现的字段都能在契约里找到；用户审阅通过。
- **S1**：见任务书 AC1–AC9；返工见 [briefs/1a-s1-rework.md](briefs/1a-s1-rework.md) RW1–RW7。
- **S2**：详细见任务书 AC1–AC8，要点：
  - 假 LLM 探针有结论（成立就用，不成立记录原因后改用真实模型）。
  - 集成测试一条命令跑完，在临时 `DSH_HOME` 里：打包、`dsh plugin add`、启动 Web、发现文件内容和权限正确、错误令牌被断开、协议版本不兼容被拒绝。
  - 用 S1 的 ACP 客户端连桥接：`session/new` 后会话挂在对应工作区下、挂了 `agent-collab` 预设、注入了 `DSH_AGENT_COLLAB_ROLE`；`session/prompt` 收到 `session/update`；审批触发 `approval_pending` / `approval_resolved`；`session/cancel` 能取消；断开重连后 `session/resume` 带 `sinceSeq` 补发的事件不缺不重。
  - 所有 dsh 内部调用只出现在 `dsh-bridge/lib/dsh-api.js`。
- **S3**：详细见任务书 AC1–AC13，要点：
  - 用假执行端（按契约发事件）跑通：start 立即返回任务号，工作进程独立存活；`wait`、`status --json`、`cancel`、`resume` 行为符合契约。
  - 基线：派发前已有的未跟踪文件和设计端预写的测试不进补丁；执行端提交或切分支被标记为违规；受保护路径被改动被标记。
  - 汇报：合法时提取成功；不合法时续接一次要求重发；仍不合法时标记 `report_invalid`。
  - 锁：同一仓库第二次 `start` 被拒绝并给出现有任务；持锁进程不在时锁失效。
  - 防套娃：两个环境变量任一为 `executor` 时 `start` 被拒绝。
  - 卡死：超过 `idleTimeoutMinutes` 标记 `stalled`；等待审批期间不计时（测试里用很短的超时）。
  - 杀掉工作进程后重启 `wait`，`events.jsonl` 不缺失（对应 T23 的运行时部分）。
- **S4**：
  - 桥接在线时走桥接；Web 没开时自动启动并等到发现文件；profile 里没装桥接时提示安装并退回 acp，不启动 Web（不会开出第二个 Web）；桥接不可用时退回 `dsh --profile acp`，覆盖层带上 Web profile 的服务商和默认模型，不修改 acp profile。
  - `doctor --json` 报告 1a 必需项（dsh 和桥接、git 状态），各项有通过或失败的原因。
- **S5**：`npm run build` 生成的 `SKILL.md` 与提交进仓库的一致（测试检查）；`claude --plugin-dir` 方式加载后 `/agent-collab:collab` 可用；`allowed-tools` 窄规则生效。
- **S6**：1a 的 T 编号逐项给出验证方法、结果和日期；需要用户在 dsh Web 里操作的项（T2 看侧栏、T3 批准、T4 插话、T5 打开后续接、T6 点停止），由 Claude 准备好环境和步骤，用户操作，Claude 核对记录。T11、T13 要真实模型，届时按 RUNBOOK 的 R6 例外另行征得同意。

## 进展

- 2026-10-23 7 个实现决定经用户确认，已回填 PLAN.md（头部、D3、§7.1、§8、§9.2–9.4、§11.1、§11.3、§11.5、§12.2、§18、附录 B）。
- 2026-10-23 S1 任务书定稿，用户同日派发给 dsh。
- 2026-10-23 S1 验收：AC1–AC9 全部通过。【已验证】2026-10-23，Claude 在临时副本重跑 `npm test`（56/56）和 `npm run build`（退出码 0），用外层 bwrap 重跑集成脚本（`RESULT: 通过`）；`~/.dsh/profiles` 的哈希、文件清单和用户 dsh Web 的 PID 与派发前一致；会话日志显示派发前已切到 `workspace-write`，执行的命令里没有读写 `~/.dsh`、按名字结束进程或提交。审读代码有 6 处要改，写成返工任务书 [briefs/1a-s1-rework.md](briefs/1a-s1-rework.md)，同日定稿；第 1 条（项目级配置能放宽 `protectedPaths` 等 4 项）按“只能收紧”处理【已确认】用户 2026-10-23，已回填 PLAN.md §12.2 并登记 DECISIONS.md。
  - dsh 的疑问已答：schema 顶层 `version` 符合 PLAN.md §12.1，不改；`loadConfig` 返回越权错误而不抛错，符合任务书；`inheritEnv` 取 `designer` / `login-shell`、`model` 允许字符串或 `{ provider, model }`，暂按此，S4 实现适配器时核对【未验证】。
  - ACP 字段的出入（`configId`/`value`、`mcpServers` 必填、权限应答是嵌套的 `outcome.outcome`）已补进 [protocol.md](../protocol.md) §2.5 或已与之一致；PLAN.md 没写到这层字段，不用改。
- 2026-10-23 S1 返工验收：RW1–RW7 全部通过，S1 完成。【已验证】2026-10-23，Claude 在临时副本重跑 `npm test`（68/68）和 `npm run build`（退出码 0），`grep "'high'" core/` 和 16 个别名的 grep 都无结果；外层 bwrap 下集成脚本 `RESULT: 通过`；另写 8 个边界用例核对收紧规则（含没有全局文件时按 schema 默认值比较、4 项同时放宽、任务级放宽），结果都符合 PLAN.md §12.2；`~/.dsh/profiles` 哈希、文件清单和用户 dsh Web 的 PID 与派发前一致，改动只在 `core/`、`config/`、`tests/`；会话日志里返工轮次全程 `workspace-write`，没有权限变化，命令里没有读写 `~/.dsh` 或 `.env`、按名字结束进程或提交。dsh 选的标注是 `x-project-tighten`（`union` / `max` + `order` / `only` + `value`），放宽时报 `ConfigTightenError`（继承 `ConfigScopeError`，`reason: 'loosens'`）。
  - 留给后续步骤：单行超长时 `JsonRpcPeer` 只停止处理并发出 `close`，不回收底层的子进程或 socket；调用方收到 `AcpClient` 的 `close` 事件后要调用 `client.close()`。S2 的桥接是服务端、S3 用假适配器，都不涉及；改由 S4（`adapters/dsh.mjs`）的任务书写明。
  - 小出入，不返工：项目级 `protectedPaths: []` 按并集本是空操作，dsh 把它当放宽报错（其余数组不报），可以接受；dsh 自己的会话里套不了外层 bwrap，这一项由 Claude 验收时跑。
- 2026-10-23 用户要求提前做 §17 第 15 项的 Windows 桌面版探针（P15），任务书定稿，待派发。
- 2026-10-23 S0 接口契约 [docs/protocol.md](../protocol.md) 写完，用户同日审阅原样通过【已确认】用户 2026-10-23。和 PLAN.md 的出入已回填：§8 表格的三处（`prompt-<n>.md`、仓库级 `active.lock`、`cancel.request`），以及 §11.3 的接口签名（`start` 返回 `turn`、`attach` 用 `sinceCursor`、事件由 `onEvent` 回调收、加 `question` 和 `warning`）；§7.1 补了 `dsh-bridge/lib/jsonrpc.js`（实现决定 1 的“客户端和桥接各一份”）。起草 S3 时发现契约没法告诉运行时设计端是谁，给 `run start` 补了 `--designer`、`--designer-model`，用户同意【已确认】用户 2026-10-23。
- 2026-10-23 S2、S3 任务书定稿，待用户按顺序派发。
- 2026-10-23 S2 验收：AC1–AC5、AC7 通过，AC6、AC8 各有一处不符，另有一个严重问题，写成返工任务书 [briefs/1a-s2-rework.md](briefs/1a-s2-rework.md)，用户同日派发。【已验证】2026-10-23，Claude 重跑 `npm test`（77/77）、`npm run build`（默认输出 `dist/` 和 `--out` 都对，包内恰好 6 个文件，不往仓库写文件），外层 bwrap 下 `bridge-dsh.mjs` 和 `acp-client-dsh.mjs` 都是 `RESULT: 通过`；`~/.dsh/profiles` 哈希和文件清单、用户 dsh Web 的 PID 与派发前一致；会话日志显示派发前已切到 `workspace-write`，全程没有审批请求，命令里没有读写真实 `~/.dsh` 或 `.env`、按名字结束进程或提交。
  - 要返工：`truncateText` 耗时随长度平方增长（实测 128 KiB 777 ms，桥接在 dsh Web 进程里，大输出会卡住 Web）；`acp-server.js` 直接调用 dsh 的 agent、session 对象（含已被 dsh 标为禁用的 `eventAt`），不符合“dsh 调用只在 dsh-api.js”；集成测试从 `experiments/` 导入，任务书要求复制；同一进程里重连后补发的 `stoppedBy` 变成 `null`，protocol.md §2.7 只允许桥接重启后这样。
  - 回填（2026-10-23 Claude 已起草进 PLAN.md §5.2、§5.4、§7.1、§9.3、§9.4、§11.9，protocol.md §2.5、§2.7，RISKS.md R8，用户审阅 diff 后原样通过【已确认】用户 2026-10-23）：PLAN.md §5.2、§11.9 的“默认没有 `read-only` 预设”与 dsh 0.2.1-rc.2 不符（dsh-base 默认表有 `read-only`，Claude 已在 dsh 源码核对）；protocol.md §2.7 的 `assistant/chunk` 改为 `assistant/message` 的内容块（整条消息一次转发，不是逐字流式）、只转发 `source.kind` 为 `user` 的 `user/message`、用量字段、`endReason` 取值、`stoppedBy` 由桥接按连接状态判定；dsh 版本范围用 `peerDependencies` 加 `optional: true`（dsh 汇报离线安装不下载 dsh，profile 带 `autoInstallPeers=false`）；`session.eventAt` 被 dsh 标为禁用，记入 RISKS.md。
- 2026-10-23 S2 返工验收：RW1–RW5 全部通过，S2 完成。【已验证】2026-10-23，Claude 重跑 `npm test`（80/80）和 `npm run build`（包内 6 个文件），外层 bwrap 下 `bridge-dsh.mjs`、`acp-client-dsh.mjs` 都是 `RESULT: 通过`，`grep -rn "experiments/" tests/` 无输出，`lib/jsonrpc.js` 仍与 `core/jsonrpc.mjs` 相同；新截断函数和逐字符参考实现对照 3000 组随机多字节文本无差异，16 MiB 表情文本截断 25 ms、无 U+FFFD；在临时副本里往 `acp-server.js` 加 6 种违规写法（`state.agent.followup`、`this.agent.session.seq`、方括号访问、经别名调用 `followup`、`state.session.append`、`ctx.get`），自动检查都能查出；`~/.dsh/profiles` 哈希、文件清单和用户 dsh Web 的 PID 与返工前一致，会话日志里返工轮次没有权限变化，命令里没有读写真实 `~/.dsh` 或 `.env`、按名字结束进程或提交。
  - 小出入，不返工：一个连接 `session/close` 后另一个连接再 `session/resume`，会话仍带着“已关闭”标记，这个连接断开时状态会被丢掉；运行时一个任务只有一个连接，暂不影响。自动检查查不出解构后再调用的写法（dsh 已说明）。
- 2026-10-23 推送 S1、S2 后 Windows CI 卡住：`tests/config.test.mjs` 的并发读写用例里 `saveConfig` 改名覆盖正被读的文件时抛 `EPERM`，后台读循环停不下来（用户提供的完整日志证实）。修复任务书 [briefs/1a-ci-windows-fix.md](briefs/1a-ci-windows-fix.md) 同日派发。
- 2026-10-24 Windows CI 修复验收：AC1、AC2、AC4 通过，AC3 有小出入已接受。【已验证】2026-10-24，Claude 重跑 `npm test`（88/88）、`npm run build`（包内 7 个文件，多了 `lib/atomic-write.js`），外层 bwrap 下两个集成脚本 `RESULT: 通过`，`jsonrpc.js` 两份仍相同；另在临时目录试了两种挂住情形（用例体永不结束；用例抛错后留下计时器，即这次 CI 的情形），`--test-timeout` 都让测试按时失败；`~/.dsh/profiles` 的 4 个哈希与派发前一致（机器 2026-10-24 重启过，基准文件随 `/tmp` 清空，按对话里记下的哈希核对），会话日志里开工前已切到 `workspace-write`，没有审批请求，命令里没有写 `~/.dsh`、按名字结束进程或提交。Windows 上是否真正修好以推送后的 CI 为准。
  - 小出入，接受：`--test-timeout` 实际是每个测试文件的时限，超时报出的是文件名而不是用例名（Node 22 实测）；用例先抛错再挂住时用例名和错误也会报出。已把 dev-setup.md 的说明改准。dsh 读取了 `~/.dsh/attachments/` 下的任务书附件（用户以附件形式发送任务书所致，内容就是任务书本身），以后派发时贴任务书路径，不用附件。dsh 跑默认构建后留下了 `dist/`（已在 `.gitignore`，Claude 已删除）。
- 2026-10-24 第 1 轮修复推送后（`2719951`，CI 运行 40055863970）：Windows 不再挂住，87/88 通过；并发读写用例里改名重试约 1.1 秒用尽仍 `EPERM`（用户提供日志）。第 2 轮任务书 [briefs/1a-ci-windows-fix2.md](briefs/1a-ci-windows-fix2.md)：重试改为按 10 秒总预算，测试不放宽读循环频率。S3 任务书加了一条：`state.json` 写入失败时工作进程不退出，记 warning、下次再写（S3 尚未派发，不涉及已确认的契约字段）。
- 2026-10-24 Windows CI 第 2 轮修复验收：AC1–AC3 通过。【已验证】2026-10-24，Claude 重跑：`tests/atomic-write.test.mjs` 8/8（“重试用尽”用注入的 200 ms 预算）；两份 `renameWithRetry` 逐行比对相同；用模拟的持续 `EPERM` 实测默认参数，两份实现都在 10000 ms 时停止，共 99 次尝试，错误上带 `attempts`、`elapsedMs`；`npm test` 88/88，`npm run build` 退出码 0，两个集成脚本 `RESULT: 通过`，`dist/` 已删；`package.json`、CI 配置未改；`~/.dsh/profiles` 的 4 个哈希与基准一致；本机信息扫描无命中。同日经用户授权提交并推送（`a67780f`），CI 运行 40056577654 的 6 组全部通过，Windows 两组各约 25 秒。【已验证】2026-10-24，GitHub API 查询作业结论。
- 2026-10-24 S3 验收：未通过，返工任务书 [briefs/1a-s3-rework.md](briefs/1a-s3-rework.md)（草稿）。【已验证】2026-10-24，Claude 重跑并审读代码：
  - 范围和隔离：相对 `1d1a963` 只新增 21 个路径；`~/.dsh/profiles` 4 个哈希和目录列表与基准一致，`~/.agent-collab` 仍不存在；会话日志开工前已切到 `workspace-write`，无审批请求，git 写操作都在 `mktemp` 的临时仓库里；dsh 写过的临时脚本已删。`npm run build` 退出码 0，新文件都有职责说明，无依赖。
  - 测试：`npm test` 11 次里 2 次失败（124 个用例）。原因：`startFakeExecutor` 读到假执行端没写完的端口文件，`JSON.parse` 报错；失败后假执行端没人结束，管道让测试文件挂满 60 秒，假执行端成为孤儿（dsh 自己 11:25 开的后台测试也因此挂住，汇报时仍在跑）。
  - 实测复现的缺陷：`acquireLock` 先建空文件再写内容，4 个进程并发 60 轮有 2 轮不止一个拿到锁；`run cancel` 等待期间任务自己以 `done` 结束时，被改成 `cancelled`（“工作进程未响应”）并重写 `summary.json`；临时 index 从空开始，被跟踪又匹配 `.gitignore` 的文件不进快照；git 输出未用 `-z`，中文路径成了八进制转义，跨目录改名的增删行数为 0。
  - 读代码发现：`summary.reportError` 在最后一轮合法时仍带前一轮的错误（与 protocol.md 5.6 不符）；`attach` 返回 `running: false` 时记 `failed`，工作进程掉线期间跑完的一轮汇报会丢（T23 情形）。
  - 低风险、不要求改：`run start`、`run resume` 启动工作进程后再写一次 `state.json`，可能短暂覆盖工作进程刚写的内容，下次写入即恢复；`watch` 每次轮询重读整个 `events.jsonl`。
  - 拆出的辅助模块（待回填 PLAN.md §7.1）：`core/rundir.mjs`、`core/git.mjs`、`core/events.mjs`、`core/executor.mjs`、`core/worker.mjs`。
- 2026-10-24 S3 返工任务书第 8、9 条按 Claude 推荐定稿【已确认】用户 2026-10-24：先改了 protocol.md §3（`attach` 的 `running: false` 带回 `result`）、§5.5（`worker_lost` 的含义）、§6（`run cancel` 可取消停下的任务、`run wait` 接上的说明）和 PLAN.md §11.3，登记 DECISIONS.md；任务书定稿待派发。dsh 上一轮卡住的后台测试进程已不在。
- 2026-10-24 S3 返工验收：RW1–RW10 全部通过。【已验证】2026-10-24，Claude 重跑：
  - 范围和隔离：改动的 12 个文件、新增的 2 个（`tests/fixtures/lock-worker.mjs`、`tests/run-lock-atomic.test.mjs`）与汇报一致；文档哈希与返工前基准相同；`~/.dsh/profiles` 不变，`~/.agent-collab` 不存在；会话开工前已切 `workspace-write`，无审批请求，没有后台任务，git 写操作只在 `mkdtemp` 的临时仓库里。dsh 读过 `.git/agent-collab-baselines/` 下的基准文件（只读，内容是哈希和文件列表）。
  - 用上一轮的复现脚本重跑：`run cancel` 竞态下 `statusReason` 为“设计端取消；取消前为 done”；被跟踪又匹配 `.gitignore` 的文件进了快照和补丁；中文路径原样；跨目录改名 `added: 1`；4 个进程抢锁 60 轮、抢一个 pid 已死的旧锁 60 轮，都没有双占。
  - `node --test` 连跑 12 次，每次 137/137、约 9 秒，跑完没有假执行端、工作进程、锁测试子进程残留；在 scratchpad 里写一个启动假执行端后立即抛错的用例，0.23 秒结束、无残留。`npm run build` 退出码 0，`dist/` 已删，无依赖。
  - 审读：锁改为临时文件加 `fsp.link`，打破旧锁用互斥文件并重读确认，互斥文件超过 5 秒可清；`run cancel` 分进行中、等待期间自己停下、停下三条路径；`attach` 带回 `result` 时按正常一轮结束处理。
  - 待回填（下一步起草给用户审阅）：protocol.md §5.2 锁的写法和 `lock_held` 的 `data` 多 `pid`、§5.5 `state.json` 多出的 `turnKinds`/`title`/`images`/`taskConfig`、`session` 事件由运行时写、拒绝表之外的 `error.code`、`run wait` 等工作进程退出再返回且文件取最后一轮、仓库外 `run status` 返回空列表、`turn_end` 两种来路、`--set` 的点号路径；按 PID 结束工作进程时没有补丁文件、`summary` 的改动由基线重算；对停下的任务取消时 `summary.json` 缺失就补一份（dsh 的疑问，Claude 认为可以接受）。PLAN.md §7.1 补 5 个辅助模块；dev-setup.md 写 `AGENT_COLLAB_TEST_` 变量。
- 2026-10-24 S3 回填（protocol.md 通用约定、§4、§5.2、§5.3、§5.5、§5.6、§6，PLAN.md §7.1、§11.3，dev-setup.md 的测试环境变量）用户审阅 diff 后原样通过【已确认】用户 2026-10-24，登记 DECISIONS.md；`run start` 重写 `state.json`、`watch` 重读整个事件文件两项记为 RISKS.md R9、R10。
- 2026-10-24 经用户授权提交并推送 S3（`ba4c802`）。CI 运行 40065381813：ubuntu Node 20/LTS、macOS Node 20 通过；windows Node 20（日志 744 行）、windows LTS（195 行）、macOS LTS（184 行）在 `node --test` 步骤以退出码 1 失败，没有超时。【已验证】2026-10-24，GitHub API 查作业结论和注释；日志正文 API 返回 403，待用户提供。
- 2026-10-24 S3 CI 失败分析（用户提供 macOS LTS 和 Windows Node 20 日志；Windows 日志中段被截，5 个失败里看到 3 个）。【已验证】2026-10-24，Claude 本机复现：
  - RW8 事件 4 对 6：满 CPU 负载下跑诊断脚本 96 次失败 2 次，现场显示假执行端把同一轮跑了两遍、`worker.log` 有两次启动。原因是 `sessionId` 写进 `state.json` 之前工作进程被杀，新工作进程又调用 `start`，同一任务开出第二个执行端会话。
  - “不带 result”用例 `summary.json` 不存在：`finalize` 先写终态再写 `summary.json`，`run wait` 没等它自己启动的新工作进程（读代码确认）。
  - 续接后立即 `stalled`：阈值 1 秒、停下 2.5 秒后 `run resume`，执行端 300 ms 就有事件，仍记为 `stalled`；`lastActivityAt` 在 `start`、`resume`、`attach` 时都不重置。Windows 上“等待审批不算卡死”失败是同一原因。
  - 测试问题：Windows 文件名不能含 `*`（`run-baseline` 第 153 行）；RW3 用例靠 900 ms 对 1200 ms 的时间差制造竞态。
  - protocol.md §5.3（先写 `summary.json` 再写终态）、§5.5（`lastActivityAt` 在发出消息和接上时重置；只在 `starting` 且无 `sessionId` 时 `start`）已先改，待用户审阅；修复任务书 [briefs/1a-s3-ci-fix.md](briefs/1a-s3-ci-fix.md) 草稿。
- 2026-10-24 protocol.md §5.3、§5.5 的修改用户审阅后通过【已确认】用户 2026-10-24，登记 DECISIONS.md；修复任务书定稿，待派发。
- 2026-10-24 S3 CI 修复（[briefs/1a-s3-ci-fix.md](briefs/1a-s3-ci-fix.md)）验收，部分通过。【已验证】2026-10-24，Claude 重跑：
  - 隔离：对照 `s3ci-baseline.txt`，文档哈希、profiles 未变，`~/.agent-collab` 不存在；dsh 会话先切 `workspace-write`、审批策略 `ask`，无越权审批，结束的都是自己 spawn 的进程。机器 2026-10-24 16:19 重启过，dsh Web 换了进程号（`cordis.yml` 随启动重写，内容是生成的空列表）。
  - FX1：两个新用例通过；副本里撤回“只在 starting 时 start”和“从 session 事件恢复”后 3/3 失败。FX3：两个新用例通过。
  - FX2 部分通过：用例通过，但副本里只撤回“summary 先写”、只撤回“`run wait` 等 pendingSpawnPid 和锁”各 3/3 仍通过——2 秒的 summary 延迟让新工作进程活过了 1.5 秒的轮询间隔，“一次轮询间隔内收尾”没出现，两处修复互相兜住。
  - FX5：3 个文件各 8 份、3 轮，72/72 通过；`run-attach` 单独 24 份 × 4 轮 96/96 通过。`npm test` 6 次 142/142、约 15 秒，无残留。
  - 更重负载（`nproc`=20 个占满 CPU 的进程，4 个文件各 16–24 份同时跑）：“杀掉再接上”的用例大量记成 `report_invalid`（96 个进程一轮失败 36–43 个）。留现场看：接上时这一轮已结束，假适配器按 §3 从补发事件算 `finalText` 只得到“最后一步”，汇报只在脚本的 `end.finalText` 里。副本里让假执行端补发 `end.finalText` 后这些失败消失。run-lock“run resume 以 lock_held 拒绝”偶发 `0 !== 3`：第二个任务跑的是立即结束的 `turns[0]`。
  - 审阅：`finalize` 设终态到写 `summary.json` 之间若有事件到达，`handleAdapterEvent` 会先把终态写进 `state.json`；重发汇报的 `resume` 返回后没重置 `lastActivityAt`。
  - dsh 提出的 3 处超出条文的实现：`lastActivityAt` 在适配器返回后也重置、收尾和首次接上前不查卡死，`run wait` 也等锁释放，接上后写一次 `state.json`；前两处起草进 protocol.md，第三处是实现细节不写。返工任务书 [briefs/1a-s3-ci-rework.md](briefs/1a-s3-ci-rework.md) 草稿。
- 2026-10-24 protocol.md §5.3、§5.5、§6 的补充用户审阅后通过【已确认】用户 2026-10-24，登记 DECISIONS.md；返工任务书定稿，待派发。
- 2026-10-24 S3 CI 返工（[briefs/1a-s3-ci-rework.md](briefs/1a-s3-ci-rework.md)）验收，部分通过：CR1–CR3、CR5–CR7 通过，CR4 部分通过。【已验证】2026-10-24，Claude 重跑：
  - 隔离：对照 `s3cr-baseline.txt`，代码以外只有 Claude 自己改的 3 份文档变了；`~/.agent-collab` 不存在，dsh Web 进程号未变。`profiles/web/cordis.patch.yml` 在 17:39 变过：dsh 沙箱里 `/` 只读、只有仓库可写，改它的是 dsh Web 进程本身（时间对应用户在内置浏览器里打开带令牌的地址），不是任务。会话日志：开工前切到 `workspace-write`、审批策略 `ask`，没有审批请求；`docs/` 只读不写，`git commit` 只发生在临时仓库里，`kill` 只针对自己记下的 PID。
  - CR1：副本里撤回“补一条 text 事件”（`turn_end` 照旧带脚本里的 `end.finalText`）后，新用例 CR1 失败，其余照过。CR2：副本里让 `wait_for_attach` 直接返回，并把 `ATTACH_GRACE` 调到 3 秒（attach 晚于这一轮结束），4 个“接上进行中一轮”的用例全部因 `running: true` 那条断言失败；只去掉等待、不推迟 attach 时，正常负载下只有 FX3 那个失败（其余脚本里本来就有足够长的步骤）。CR5：撤回收尾后早退，迟到事件用例失败。
  - CR4 部分通过：顺序用例在副本里把终态写入挪到 summary 延迟之前后失败（挪到延迟之后、紧挨 summary 时窗口只有几毫秒，10 ms 轮询抓不到）；`run wait` 用例在副本里只撤回“等 pendingSpawnPid 和锁”（恢复成修复前的 `waitForPidExit(state.worker?.pid ?? lastWorkerPid)`）后 3/3 仍通过：新工作进程活了 1.5 秒以上，`run wait` 50 ms 轮询早从 `state.json` 记下了它的 pid。dsh 的反证是把等待整段删掉，比撤回范围大。临时探针（`WAIT_POLL_MS=2000`、`PAUSE_BEFORE_RELEASE_MS=2500`，新工作进程在两次轮询之间收尾）修复版 3/3 通过、撤回版 3/3 失败，修复本身正确。
  - CR3：`run-lock` 24 份 × 3 轮全部通过。CR6：20 个占满 CPU 的进程期间，4 个文件各 24 份 × 3 轮（1 轮用默认 60 秒超时、2 轮 300 秒）、3 个文件各 8 份 × 3 轮，全部通过，每轮 26–37 秒；按 PID 结束后无残留。dsh 汇报的“默认 60 秒超时下 72/96 文件超时”本机没复现（dsh 在沙箱里每轮 87 秒），不需要为负载验收另定超时。CR7：`npm test` 10 次 146/146，每次 16–17 秒，无残留；S3 测试 58 个用例 16.4 秒；`npm run build` 退出码 0，`dist/` 已删。
  - 审阅：run-cancel RW9“对停下的任务取消不应联系执行端”改成只断言“没有新增 cancel 命令”，比原意（不联系执行端）宽；副本里改成“没有新增任何命令”，正常 3 次、满 CPU 下 24 份都通过，可以收紧。
  - 回填：dev-setup.md 补了 4 个测试变量（`CANCEL_WAIT_POLL_MS`、`PAUSE_AFTER_START_MS`、`SUMMARY_DELAY_MS`、`PAUSE_BEFORE_RELEASE_MS`，`CANCEL_POLL_MS` 不再给 `run cancel` 用）和假执行端的新脚本开关；dsh 提到的“`run wait` 也等锁释放”protocol.md §6 已写，不用再改。
- 2026-10-24 补测试（[briefs/1a-s3-ci-rework2.md](briefs/1a-s3-ci-rework2.md)）由 Claude 在 dsh Web 派发并交付，验收通过：RC1–RC4 全部通过。【已验证】2026-10-24，Claude 重跑：
  - 隔离：对照 `s3cr2-baseline.txt`，只有 `tests/run-finalize.test.mjs`（一个用例的参数和注释）和 `tests/run-cancel.test.mjs`（RW9 断言，去掉不再用的导入）变了；产品代码、文档、profiles 不变，`~/.agent-collab` 不存在，dsh Web 进程号未变。会话日志：从第一条记录起就是 `workspace-write`、审批策略 `ask`，没有审批请求，没有 git 写操作，副本和删除都在沙箱的 `/tmp` 里，`kill` 只针对自己启动的占 CPU 进程。
  - RC1：`run wait` 用例改为 `WAIT_POLL_MS=2000`、`PAUSE_BEFORE_RELEASE_MS=2500`。副本里只把 `cmdWait` 收尾恢复成 `waitForPidExit(state.worker?.pid ?? lastWorkerPid, 3000)`，3/3 失败（“run wait 返回后工作进程 … 还活着”），20 个占满 CPU 的进程下 4/4 失败；修复版 3/3 通过。
  - RC2：副本里让 `run cancel` 处理停下的任务时经适配器发一条 `attach`，三个 RW9 用例 3 次都失败，失败信息带出那条命令；修复版 `run-cancel` 3 次 6/6。
  - RC3：20 个占满 CPU 的进程期间，`run-finalize`、`run-cancel` 各 8 份 × 2 轮全部通过，每轮 13–15 秒；按 PID 结束后无残留。RC4：`npm test` 3 次 146/146，每次 16–17 秒，无残留。
  - dsh 指出的局限：RC1 的判别力靠时序，新工作进程从启动到写终态（本机约 1.8 秒）要短于 2 秒的轮询间隔；机器慢到超过这个时长时，撤回版也可能通过（漏报，不会误报失败）。暂不处理。
- 2026-10-24 经用户授权提交并推送 `1f346cb`。CI 运行 40087121759：5 组通过；Windows Node 20 有 2 个用例失败：
  - `run-lock-atomic` 的读锁循环读到 `EPERM`。Windows 上文件已被删除、但还有别的进程开着它时就会这样。
  - `run-lock` 的 `run resume` 用例第一轮记成了 `failed`。测试失败时不输出 `worker.log`，原因不明。
- 2026-10-24 Windows 锁修复（[briefs/1a-s3-ci-winlock.md](briefs/1a-s3-ci-winlock.md)，依据 protocol.md §5.2“正在删除的文件”）由 Claude 在 dsh Web 派发并交付，验收通过：WL1–WL5 全部通过。【已验证】2026-10-24，Claude 重跑：
  - 隔离：对照 `s3wl-baseline.txt`，只有 `core/rundir.mjs`、`core/run.mjs`、`core/worker.mjs`、`tests/helpers/run-harness.mjs` 和 10 个 `tests/run-*.test.mjs` 变了，另外新增了 `tests/run-lock-eperm.test.mjs`；文档、profiles 不变，`~/.agent-collab` 不存在，dsh Web 进程号未变。会话日志：从第一条记录起就是 `workspace-write`、审批 `ask`，没有审批请求，没有 git 操作，副本建在 `/tmp` 和仓库内的 `.tmp-probe/`，用完已删。
  - 审阅：
    - 实现：新增 `retryOnEperm`，只在 `win32` 上、只对 `EPERM` 重试，预算 1 秒。`readLock` 改为区分 missing、ok、unreadable 三种结果。读不出来的锁，`updateLock`、`releaseLock` 报 `lock_unreadable`；工作进程收尾时释放失败只记日志；`run wait` 按“还没释放”继续等。
    - 测试：43 处状态断言改用 `assertTaskStatus`，判断条件没有放宽。有一处断言原来在失败信息里带 `reportError`，现在没有了，由诊断代替。
  - WL1：新单元测试 9/9 通过。副本里让 `retryOnEperm` 不重试，4 个失败（“Windows 上应重试，实际调用 1 次”等）；把 `readLock` 改成读错就当不存在，4 个失败（“Missing expected rejection.”、按“刚写入”拒绝实际用了 15001 ms）。
  - WL2：副本里给读锁循环注入一次 `EPERM`，Linux 上照旧失败（“读到了不完整的锁文件 … EPERM 注入”）。
  - WL3：副本里让工作进程一启动就以 `failed`（`executor_error`）收尾并写一行标记，`run resume` 用例的失败信息里有 stdout、`statusReason="executor_error"` 和那行标记。
  - WL4：20 个占满 CPU 的进程期间，`run-lock-atomic`、`run-lock` 各 8 份，再加一轮连同 `run-lock-eperm` 各 8 份，全部通过，每轮 17–18 秒，无残留。WL5：`npm test` 3 次 155/155，每次 16–17 秒，无残留。
  - dsh 对第二个失败的分析：所有 `finalize('failed')` 都在 worker.mjs，锁相关代码只会抛 `lock_held` 和 `lock_unreadable`，判断与锁无关。下次 CI 失败时会有诊断输出。
  - dsh 的两处取舍和遗留：
    - `updateLock` 在锁文件不存在时不写、返回 `null`（工作进程可能已经收完尾并释放了锁）。Claude 认为合理，不改 protocol。
    - `run cancel` 结束工作进程那条路径上的 `releaseLock` 没有捕获 `lock_unreadable`。只在 Windows 上 `EPERM` 持续超过 1 秒时才会碰到，留到下一轮。
  - 回填：dev-setup.md 补了失败诊断的说明，【已验证】一行更新为 155/155。
- 2026-10-24 经用户授权提交并推送 `b14504a`。CI 运行 40089287530 的第 1 次尝试：5 组通过，上次失败的两个锁用例在两组 Windows 上都通过，读锁时 `EPERM` 出现 0 次。Windows LTS（Node 24）那组，`run-stall.test.mjs` 整个文件 0.45 秒就失败了，一个用例都没跑，也没有错误输出；这个文件在其他 5 组和本机都通过。经用户同意，Claude 在浏览器里重跑了失败的那组：第 2 次尝试 155 个用例，153 个通过、2 个跳过（Windows 上本来就跳过的），6 组全部通过。【已验证】2026-10-24。两次没查明的偶发失败记为 [RISKS.md](RISKS.md) R11。
- 2026-10-24 S4（[briefs/1a-s4-dsh-adapter.md](briefs/1a-s4-dsh-adapter.md)）由 Claude 在 dsh Web 派发并交付；2026-10-25 验收通过：DA1–DA10 全部通过。【已验证】2026-10-25，Claude 重跑：
  - 隔离：对照 `s4-baseline.txt`，profiles 的哈希不变，`~/.agent-collab` 不存在。用户的 dsh Web 进程号从 11084 变成了 2026-10-24 23:52 启动的新进程：这是用户自己重启的（当晚用户说已重新打开 dsh Web）；dsh 会话在 bwrap 里（`--unshare-pid`），看不到也没有结束用户进程。会话日志：开工前切到 `workspace-write`、审批 `ask`，没有审批请求；命令里没有按名字或端口结束进程、没有读写 `~/.dsh`、没有 git 写操作。
  - 重跑：`npm test` 3 次 195/195，每次约 16.6 秒，无残留进程；三个集成脚本（`adapter-dsh`、`acp-client-dsh`、`bridge-dsh`）都是 `RESULT: 通过`，跑完用户的 dsh Web 和 profiles 不变。反证：副本里删掉断开时的 `client.close()`，DA4 用例失败；副本里换回 S3 的 `run.mjs`，DA9 用例失败（`lock_unreadable`、退出码 1）。
  - dsh 的核实：桥接同时写进 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles`；dsh 没有标记 Web 实例的文件；dsh 加载 patch 用的是 `js-yaml`，不是 1a 实现决定 2 写的 `yaml` 包，实现改用 `js-yaml`（决定的本意“和 dsh 自己的解析一致”不变）。模型和思考强度的映射、`endReason` 换算、acp 用量只有 `{ used, size }`，已回填 protocol.md §3。
  - 超出任务书的改动：`core/worker.mjs` 两处（把 `state` 传给适配器；适配器错误带字符串 `code` 时用作 `statusReason`），理由成立，已回填 protocol.md §3、§5.5。`tests/run-start.test.mjs` 用 `nope-command` 代替已实现的 `doctor` 测未知命令。
  - 审阅发现 3 处小问题（`yaml` 包的退路会丢 `!!js`、doctor 文字输出把 info 印成 WARN、doctor 连接桥接的协议号写死），写成返工任务书 [briefs/1a-s4-rework.md](briefs/1a-s4-rework.md)，由 Claude 按用户授权定稿并派发。
  - 回填：PLAN.md §4.3、§7.2、§11.5，protocol.md §3、§5.5、§6，dev-setup.md（测试变量、假 dsh、集成脚本表）。
- 2026-10-25 S4 返工（[briefs/1a-s4-rework.md](briefs/1a-s4-rework.md)）由 Claude 按用户授权派发，dsh 交付，验收通过：SR1–SR4 全部通过。【已验证】2026-10-25，Claude 重跑：
  - 隔离：对照 `s4-rework-baseline.txt`，只有 `core/adapters/dsh.mjs`、`core/doctor.mjs` 和测试（`dsh-acp`、`doctor`、两个 helper、`adapter-dsh` 集成脚本）变了；profiles 的哈希、用户 dsh Web 的进程号不变，`~/.agent-collab` 不存在。会话日志：开工前切到 `workspace-write`、审批 `ask`，没有审批请求，没有按名字结束进程、读写 `~/.dsh` 或 git 写操作。
  - 重跑：`npm test` 3 次 197/197，每次约 16.6 秒；`adapter-dsh` 集成脚本 `RESULT: 通过`（I3 新增 `!!js` 断言）；`npm run build` 退出码 0。反证：副本里给 `loadYamlLibrary` 加回 `yaml` 包的退路，“只有 yaml 包”用例失败（`'done' !== 'failed'`）。
  - 实现：`js-yaml` 改为只在 dsh 包目录及其上层的 `node_modules` 里找（不经 Node 的全局路径）；覆盖层内容生成好之后才建目录。doctor 文字输出按 level 印 `INFO`、`WARN`、`FAIL`，连接桥接用 `SUPPORTED_PROTOCOL` 和 `package.json` 的版本。
- 2026-10-25 S5 中 dsh 的部分（[briefs/1a-s5-skill-render.md](briefs/1a-s5-skill-render.md)）由 Claude 按用户授权派发，dsh 交付，验收通过：SA1–SA5 全部通过；S5 的验收标准（`SKILL.md` 与渲染一致、`claude --plugin-dir` 加载后 `/agent-collab:collab` 可用、`allowed-tools` 窄规则生效）全部满足。【已验证】2026-10-25，Claude 重跑：
  - 隔离：对照 `s5-baseline.txt`，代码只有 `core/doctor.mjs`、`scripts/build.mjs`、`tests/build.test.mjs`、`tests/doctor.test.mjs` 变了，另新增 `core/render-skill.mjs`、`skills/collab/SKILL.md`、`.claude-plugin/plugin.json`、`tests/render-skill.test.mjs`；profiles 的哈希、用户 dsh Web 的进程号不变，`~/.agent-collab` 不存在。会话日志：开工前切到 `workspace-write`，没有审批请求，没有按名字结束进程、读写 `~/.dsh` 或 git 写操作。
  - 重跑：`npm test` 3 次 213/213，无残留进程；`npm run build` 第二次不改 `SKILL.md` 的修改时间，`--check` 退出码 0，副本里改模板一个字后退出码 1。反证：副本里改成循环替换，“替换只做一遍”用例失败。`chmod 644` 的副本里（默认参数和 Node 20 模拟参数）失败的 22 项都是已知的假 dsh 安装问题（`找不到可用的 dsh`），留给 [briefs/1a-ci-fix-s4.md](briefs/1a-ci-fix-s4.md)。
  - 插件实测（Claude Code 2.1.309，`claude -p --plugin-dir`，Haiku，临时 git 仓库，PATH 上没有 dsh）：`/agent-collab:collab` 在命令和 skill 列表里；skill 按预检第 1 步运行 `doctor --json --designer claude`，不经审批；同一插件的 `scripts/build.mjs --check` 被拒。花费约 0.01 美元。
  - 任务书没写死、dsh 自定的：文字输出最后一行 `[FLOW] flow：<JSON>`；项目配置有没生效的项时也出 `config` 检查项，`flow` 照常给出；`parseHost` 返回 `{ variables, slots }`。Claude 认为合理，已回填 protocol.md §6。
  - 回填：protocol.md §6，dev-setup.md（构建、`--check`、1a 手动安装步骤）。
- 2026-10-25 CI 修复和 R11（[briefs/1a-ci-fix-s4.md](briefs/1a-ci-fix-s4.md)）由 Claude 按用户授权派发，dsh 交付，验收通过：PR0–PR4 全部通过。【已验证】2026-10-25，Claude 重跑：
  - 隔离：对照 `cifix-baseline.txt`，产品代码和文档没变（RUNBOOK 是 Claude 自己改的），只改了 `tests/`；profiles 的哈希、用户 dsh Web 的进程号不变，`~/.agent-collab` 不存在。会话日志：`workspace-write`、审批 `ask`，没有审批请求，没有按名字结束进程、读写 `~/.dsh` 或 git 写操作。
  - 重跑：仓库里 `npm test` 3 次 224/224；`chmod 644` 的副本在默认参数和 Node 20 模拟参数下各 224/224（修复前同样方法 23 项失败），均无残留进程。反证：副本里去掉 `killWorkerIfActive` 的状态判断，“任务已经停下或结束时不结束它的 worker.pid”和 `killActiveWorkers` 两个用例失败。
  - 实现：`tests/helpers/pids.mjs` 统一结束进程的规则，`assertExit` 替换了 101 处退出码断言；假 dsh 的 `lib/bin.js` 显式 0755，假 `js-yaml`、`yaml` 改为 CommonJS。dsh 另外发现并修了假 dsh Web 的一个缺陷：信号处理装在写发现文件之后，父进程一看到文件就发 SIGTERM 时会留下陈旧的发现文件；新增测试变量 `FAKE_DSH_WEB_EXIT_AFTER_MS`。Claude 接受这两处。
  - 回填：dev-setup.md（测试变量、清理规则、224/224），RISKS.md R11，RUNBOOK“按 CI 的条件重跑测试”。
