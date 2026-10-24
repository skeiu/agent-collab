本文件：第 1a 阶段 S6（产品验收）中可以自动化的部分交给 dsh 的任务书原文：真实 dsh + 假 LLM + 临时环境，经 `bin/collab.mjs` 端到端跑 1a 的 T 编号。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿并在 dsh Web 派发，用户未逐份审阅。依据：PLAN.md §15“验收”的 T 编号；[1a-impl-plan.md](../1a-impl-plan.md) S6 的验收标准。范围说明：需要人在 dsh Web 里操作的项（T2 看侧栏、T3 点批准、T4 插话、T5 打开后续接、T6 点停止）和要真实模型的项（T11、T13）仍由用户做；本任务用测试插件模拟人的操作，先把运行时一侧跑通，用户做的时候只剩界面一侧。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”、docs/protocol.md（全文，它是字段的权威来源），再读 `tests/integration/dsh-harness.mjs`、`bridge-dsh.mjs`、`adapter-dsh.mjs`、`tests/fixtures/fake-llm.mjs`、`tests/fixtures/dsh-test-plugin/`。docs/PLAN.md 只读 §15 的“验收”表（先用 `grep -n '^#' docs/PLAN.md` 定位）。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书（docs/context/briefs/1a-s4-dsh-adapter.md）第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 任务

新建 `tests/integration/acceptance-1a.mjs`：一条命令跑完下面的场景，每个场景打印一行 `[T编号] 通过 / 不通过 — 说明`，最后一行 `RESULT: 通过` 或 `RESULT: 不通过 — 原因`，退出码非 0 表示失败。复用 `dsh-harness.mjs` 的临时环境、`findDsh`、`startWeb` 等；需要的话可以扩展 `dsh-harness.mjs`、`fake-llm.mjs` 和测试插件（`tests/fixtures/dsh-test-plugin/`），但不要破坏 `bridge-dsh.mjs`、`adapter-dsh.mjs`（改完两者都要重跑通过）。

环境：一个临时 `DSH_HOME`，装桥接（`npm run build` 打出的 `.tgz`）和测试插件，假 LLM 服务当唯一的服务商，起一个 Web（`--port 0 --no-open`）；临时 `AGENT_COLLAB_HOME`；每个场景在系统临时目录下新建 git 仓库（有一次初始提交）。所有 `collab` 命令都以子进程运行 `node bin/collab.mjs ...`（cwd 为临时仓库，环境里是临时的 `DSH_HOME`、`AGENT_COLLAB_HOME`），不在进程内调用 `core/`。可以用 dev-setup.md 列出的 `AGENT_COLLAB_TEST_*` 变量缩短等待时间。

场景（括号里是对应的 T 编号；“模拟”指用测试插件代替人在 dsh Web 里的操作）：

1. **T1**：`doctor --json --designer claude` 顶层 `ok` 为 true，`bridge` 在线，`agent_preset` 通过，`flow.executor` 为 `dsh`。
2. **T2（运行时一侧）、T9（合法汇报）**：`run start` 一个任务，假 LLM 在仓库里新建一个文件，最后给出合法的汇报 JSON；`run wait` 得到 `done`；`summary.json` 的字段符合 protocol.md §5.6，补丁里有这个文件；测试插件报告这个会话挂在该临时仓库对应的工作区下、预设是 `agent-collab`。
3. **T3**：假 LLM 调用工具写工作区外的文件，触发审批；测试插件在审批挂起一段时间后批准（这段时间要长于缩短后的卡死阈值）。审批挂起期间 `state.json` 的 `status` 为 `waiting_approval`，`watch` 的输出里有审批那一行；最后 `done`，不是 `stalled`。
4. **T4**：模拟人在会话里插话（测试插件经 dsh 内部接口往会话里加一条用户消息；dsh 没有可用的接口时，这一场景记为“不通过 — 无法模拟”并写明查过哪些接口，其余场景照常跑），`summary.json` 的 `human_inputs` 里有这条记录。
5. **T5（运行时一侧）**：第一轮结束后 `run resume --kind correction --message <文件>`，第二轮在同一个 dsh 会话里进行（`sessionId` 不变）并完成；中间断开再连接桥接（例如结束并重启 `run wait`）不影响续接。
6. **T6**：一个正在进行的任务，`run cancel` 后记为 `cancelled`；另一个任务由测试插件模拟在 dsh 里停止，记为 `stopped_by_human`。
7. **T9（不合法汇报）**：假 LLM 第一次给出不合法的汇报，运行时续接一次要求重发，第二次合法时 `done`；两次都不合法时 `report_invalid`。核对续接时发出的那条消息确实是要求重发。
8. **T10、T24**：派发前仓库里已有一个未跟踪文件和一个设计端预先写好的测试文件（用 `--protected` 指定）。假 LLM 修改受保护的测试文件，并在 shell 里执行 `git commit`。`summary.json` 的 `violations` 里有 `protected_path` 和 `head_moved`；派发前已有的未跟踪文件和预先写好的测试文件的原样内容都不出现在补丁里（按 protocol.md 的基线规则判断“不出现”的含义）。
9. **T17**：环境里 `AGENT_COLLAB_ROLE=executor` 时 `run start` 被拒绝；`DSH_AGENT_COLLAB_ROLE=executor` 时同样被拒绝；错误码符合 protocol.md。
10. **T23**：任务进行中结束设计端这一侧的 `run wait` 进程（只结束这个你自己 spawn 的进程）；工作进程继续把任务跑完；新的 `run status` 找到这个任务，新的 `run wait` 拿到最终状态；`events.jsonl` 的序号连续、没有重复。
11. **T25（运行时一侧）**：同一仓库已有任务在跑时，第二次 `run start` 被拒绝，错误里带着现有任务的任务号。

T7、T8 已由 `adapter-dsh.mjs` 覆盖，本脚本不重复。T21 由 skill 负责，不在本任务里。

## 发现产品缺陷时

不修改产品代码（`core/`、`bin/`、`dsh-bridge/`、`scripts/`、`skills/`、`config/`）。场景因产品行为与 protocol.md 不符而失败时，保留这个失败，在汇报里写明：哪个场景、期望（引用 protocol.md 的条目）、实际（命令输出或文件内容）、你认为问题在哪个文件哪个函数。不要为了让场景通过而放宽断言。

## 验收标准

- SX1：`node tests/integration/acceptance-1a.mjs` 连跑 2 次，结果一致；汇报每个场景那一行的原文和最后一行 `RESULT:`。不通过的场景按上一节写明原因。
- SX2：反证：在副本里把 `core/run.mjs` 或 `core/worker.mjs` 中判断受保护路径的地方改成不判断，场景 8 不通过；把要求重发的续接去掉，场景 7 不通过。汇报两次的输出原文。
- SX3：`node tests/integration/bridge-dsh.mjs`、`node tests/integration/adapter-dsh.mjs` 仍然 `RESULT: 通过`；`npm test` 全部通过。
- SX4：每次跑完没有残留进程（`fake-executor`、`fake-dsh-cli`、`run.mjs --worker`、临时 `DSH_HOME` 下启动的 dsh），临时目录已删除。
- SX5：脚本开头有一行职责说明；`docs/dev-setup.md` 的集成测试表需要新增一行，你把要加的那一行写在汇报里（不要改 docs/）。

## 隔离和安全（违反任何一条都算不通过）

- 遵守 RUNBOOK“派发 dsh 任务”的全部规定。被测 dsh 只在临时 `DSH_HOME` 里运行，`--port 0 --no-open`，不访问 dsh 的默认端口；运行任何 `dsh` 命令前断言 `DSH_HOME` 在临时目录下；缓存按 RUNBOOK 第 4 条重定向。不读写 `~/.dsh`，不读 `.env`；不调用真实模型，假 LLM 是唯一的服务商。不运行 `claude` 命令。
- 测试只在系统临时目录下建 git 仓库、`AGENT_COLLAB_HOME`、`DSH_HOME`；不在本仓库里运行 `run start`。
- 只停止自己 spawn 的进程（按 PID）；不执行 kill/pkill/killall/fuser 按名字或端口找进程。
- 遇到需要越权（审批）的操作：不要申请，记为发现。
- 不在本仓库执行 git commit、git push、切分支；不修改 docs/ 下的任何文件和 AGENTS.md。

## 汇报

在对话里汇报：第 0 步的原样输出；新建或修改的文件清单；SX1–SX5 的结果和证据（命令及输出摘要），反证的输出原文；发现的产品缺陷（按“发现产品缺陷时”的格式）；对测试插件和假 LLM 做了哪些扩展、用了 dsh 的哪些内部接口；你开过的所有后台任务及其结束情况；没做完的项和疑问。
