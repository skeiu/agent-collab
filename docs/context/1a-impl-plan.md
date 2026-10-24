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
| 2 | acp 退回模式生成覆盖层时，YAML 用什么解析（PLAN.md §11.5 要求可靠解析） | 借用 dsh 安装目录里自带的 `yaml` 包（从解析出的 dsh 入口位置找；本机实测 dsh 安装里有 `yaml` 和 `js-yaml`） | 自写只支持 cordis.patch.yml 顶层列表的解析器；或随仓库附带一个 YAML 库 | 这条路径只在 dsh 存在时运行，dsh 自己就是用这些库读配置，格式一定兼容；不引入新依赖。代价是依赖 dsh 的内部依赖，找不到时退回模式不可用，`doctor` 报告原因。把握：中，实现时确认包名和导入方式 |
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

所有步骤共同要求：`npm test` 在本机和 CI 三平台通过（CI 要推送，须用户授权）；不需要 `npm install`；不写死路径和端口；新文件开头有一行职责说明；提交前按 RUNBOOK 扫描本机信息。下面只列各步自己的标准，详细的 AC 写在各步任务书里。

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
  - 桥接在线时走桥接；Web 没开时自动启动并等到发现文件；Web 开着但没装桥接时报错提示，不启动第二个 Web；桥接不可用时退回 `dsh --profile acp`，覆盖层带上 Web profile 的服务商和默认模型，不修改 acp profile。
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
- 2026-10-24 Windows CI 第 2 轮修复验收：AC1–AC3 通过。【已验证】2026-10-24，Claude 重跑：`tests/atomic-write.test.mjs` 8/8（“重试用尽”用注入的 200 ms 预算）；两份 `renameWithRetry` 逐行比对相同；用模拟的持续 `EPERM` 实测默认参数，两份实现都在 10000 ms 时停止，共 99 次尝试，错误上带 `attempts`、`elapsedMs`；`npm test` 88/88，`npm run build` 退出码 0，两个集成脚本 `RESULT: 通过`，`dist/` 已删；`package.json`、CI 配置未改；`~/.dsh/profiles` 的 4 个哈希与基准一致；本机信息扫描无命中。Windows 上是否修好以推送后的 CI 为准。
