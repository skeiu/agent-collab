本文件：第 1a 阶段实现第 S3 步（运行时：工作进程、运行目录、CLI）交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-23，待用户派发。依据：接口契约 [docs/protocol.md](../../protocol.md)【已确认】用户 2026-10-23（第 6 节 `run start` 的 `--designer`、`--designer-model` 是之后补的，用户同日同意）；D20、D21、D23（PLAN.md §3）。和 S2 互不依赖，但在同一个工作目录里，S2 验收完再派本步。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”、docs/context/1a-impl-plan.md，再读 docs/protocol.md 的“通用约定”和第 3–6 节（这是本步的接口，全部要实现，`doctor` 除外）。docs/PLAN.md 只读：§3 的 D10、D11、D20、D21、D23；§8 的“阶段 2”到“运行目录和任务状态”；§11.3、§11.4；§13（先用 `grep -n '^#' docs/PLAN.md` 定位，不要全文读）。experiments/1a/17-worker-survival/ 是 D20 的实测（detached 加 unref），可以参考。

S1 的模块直接用：`core/config.mjs` 的 `loadConfig`、`getExecutorOptions`，`core/report.mjs` 的 `parseReportJson`，`core/platform.mjs` 的目录、原子写入和 PID 判断。它们有 bug 要改时先汇报。

## 第 0 步：沙箱自检（必须先做）

运行下面两条命令，把输出原样写进汇报：

    pgrep -af dsh
    cat /proc/1/cmdline | tr '\0' ' '

输出里有用户日常运行的 dsh Web 进程（不是你自己沙箱里的进程），说明沙箱没有隔离进程：立即停止，只汇报这一步。

## 任务

本步不碰 dsh：执行端用一个假的，按 protocol.md 第 3 节的适配器接口实现。全部用 Node ≥ 20 的内置模块，ESM，不加依赖。

1. **`core/run.mjs`**：`run start | wait | status | resume | cancel` 和工作进程。可以拆出少量辅助模块放在 `core/` 下（例如 git 基线和补丁、运行目录和锁），汇报里列出来，由 Claude 回填 PLAN.md §7.1。
2. **`core/watch.mjs`**：按 protocol.md 第 6 节的行格式打印里程碑。
3. **`bin/collab.mjs`**：开发模式的启动器，加载它所在仓库的 `core/`，把 `run …`、`watch …` 转给上面两个模块。其他命令（`doctor` 在 S4 做）以用法错误退出，提示尚未实现。
4. **适配器的加载**：执行端名 `<name>` 对应 `core/adapters/<name>.mjs`。本步还没有任何真实适配器，找不到时 `run start` 以退出码 1 失败，`error.code` 为 `executor_unavailable`。测试用环境变量 `AGENT_COLLAB_TEST_ADAPTER=<模块的绝对路径>` 代替按名字查找。
5. **假执行端**：`tests/fixtures/fake-executor.mjs` 是一个独立进程（由测试启动，不由工作进程启动），在回环 TCP 上持有会话，按测试给的脚本产生事件、改工作区文件、可选地执行 `git commit` 或切分支、等待“审批”或“提问”、以指定的 `stopReason` / `stoppedBy` 结束，并保存完整的事件记录，支持从某个位置补发。`tests/fixtures/fake-adapter.mjs` 按 protocol.md 第 3 节实现接口，连到它。它独立于工作进程存活，这样才能测“杀掉工作进程后重新接上”。

### 要点（容易漏的）

- **`run start`**：顺序是防套娃检查（两个环境变量任一为 `executor` 就以 `executor_role` 拒绝）→ 确认是 git 仓库 → 读配置（`--set` 作为单个任务级）→ 定执行端（`--executor`，否则 `executorByDesigner[--designer]`，两个都没有是用法错误）→ 拿仓库锁 → 用 `mkdir` 分配任务号 → 写 `brief.md`、`baseline.json`、`state.json` → 启动工作进程（detached、unref，标准输出和错误写进 `worker.log`，Windows 上加 `windowsHide`）→ 把锁改写为工作进程的 pid → 打印结果并退出。必须立即返回，不等执行端。
- **基线（D21）**：用临时 index 文件（`GIT_INDEX_FILE` 指向运行目录外的临时文件，用完删除）把当前工作区（含未跟踪文件、不含被忽略的文件）写成 tree 对象，不改分支、不写 ref、不动用户的 `.git/index`。每轮结束时用同样的方法得到当前 tree，补丁是两个 tree 的 `git diff --binary`，改动统计也从这两个 tree 算。
- **违规**：受保护路径（配置的 `protectedPaths` 加 `--protected`，相对仓库根目录，以 `/` 结尾表示目录）在两个 tree 之间有任何变化 → `protected_path`；HEAD 和基线不同 → `head_moved`；当前分支和基线不同 → `branch_changed`。违规只记录，不改变任务状态。
- **工作进程**：按 `state.json` 决定调用适配器的 `start`、`resume` 还是 `attach`。每个统一事件补上 `v`、`n`、`at`、`turn` 后追加到 `events.jsonl`，并更新 `state.json`（`lastActivityAt`、`waiting`、`cursor`、`lastEventN`，以及 `running` / `waiting_approval` / `waiting_question` 之间的切换；每次状态变化写一条 `status` 事件）。任务进入“停下”或“结束”状态后：写 `summary.json`，释放锁，调用适配器的 `close()`，退出。
- **一轮结束后**按这个优先顺序定状态：要求过取消 → `cancelled`；`stoppedBy` 为 `human` → `stopped_by_human`；卡死 → `stalled`；否则看汇报。每轮都写 `patch-<n>.diff` 和 `report-<n>.json`。
- **汇报**：从 `TurnResult.finalText` 用 `parseReportJson` 提取。合法 → 状态取汇报的 `status`。不合法且这份汇报还没要求过重发 → 写 `prompt-<n+1>.md`（`kind` 为 `resend`），用适配器的 `resume` 发出，内容是一段固定的中文：说明错在哪（错误类型和信息），要求只重发汇报、最后一条消息只输出一个 ```json 代码块、不要再改代码。重发后仍不合法 → `report_invalid`。`resend` 不计入 `maxCorrectionRounds`。
- **卡死**：距 `lastActivityAt` 超过 `idleTimeoutMinutes` 且 `waiting` 为空时，调用适配器的 `cancel`，状态记为 `stalled`。`waiting` 不空的这段时间不计入。
- **取消**：`run cancel` 写 `cancel.request`；工作进程定期检查，看到后调用适配器的 `cancel`，状态记为 `cancelled`。工作进程 10 秒内没确认时，`run cancel` 按 `state.json` 里的 pid 结束它，自己把状态记为 `cancelled` 并释放锁。
- **`run wait`**：任务在“进行中”而工作进程不在了（PID 不存活）时，启动一个新的工作进程用 `attach` 接上；`attached` 为 false 时记为 `failed`（`worker_lost`）。**工作进程启动时以 `events.jsonl` 为准恢复最后的 `n` 和 `cursor`**（不只信 `state.json`，因为可能刚写完事件还没来得及更新状态）；最后一行不完整时截掉；接上后按 `cursor` 跳过已经写过的事件。
- **`run resume`**：处于“进行中”或“结束”状态时以 `not_resumable` 拒绝；`correction` 和 `answer` 各自的轮数到 `maxCorrectionRounds` 时以 `round_limit` 拒绝；重新拿锁；写 `prompt-<n>.md`；启动新的工作进程，由它调用适配器的 `resume`。
- **`run status`**：没有任务号时列出本仓库未“结束”的任务，`--all` 列出所有仓库的。
- **测试用的时间参数**：卡死阈值、取消检查间隔、`run cancel` 的 10 秒等，测试里需要缩短的，只能通过以 `AGENT_COLLAB_TEST_` 开头的环境变量覆盖，正式配置项不变。汇报里列出你加了哪些，由 Claude 写进 dev-setup.md。
- 所有写文件的地方都按 protocol.md“通用约定”：原子写入（`events.jsonl` 是追加）、目录 0700、文件 0600。
- Windows 上目标文件正被读取时，原子写入的改名可能在重试预算内仍然失败（2026-10-24 CI 实测，见 [1a-ci-windows-fix2.md](1a-ci-windows-fix2.md)）。工作进程更新 `state.json` 失败时不退出：在 `events.jsonl` 记一条 `warning`，下次更新时再写；只有终态那一次写入失败才按错误处理。加一个用例：注入一次写入失败，任务仍正常走到终态。

## 验收标准

测试全部进 `node --test`，用临时的 `AGENT_COLLAB_HOME`、临时目录里新建的 git 仓库和假执行端；测试里固定 `TZ=UTC`；本步新增的测试合计在 60 秒内跑完。

- AC1：基本流程：`run start` 在假执行端还在跑时就返回（输出符合 protocol.md 第 6 节），`run start` 的进程退出后工作进程照常运行；`run wait` 在任务停下时返回；`run status` 有任务号和没有任务号两种输出；`watch` 的行格式和打印哪些事件符合第 6 节，任务停下后退出。
- AC2：基线：派发前已有的未跟踪文件、设计端预先写的测试文件不出现在补丁里；执行端新建的未跟踪文件出现在补丁里；被忽略的文件不出现；派发前后用户的 `.git/index` 内容和 `git for-each-ref` 的输出不变。
- AC3：违规：改受保护的文件、改受保护目录下的文件、执行端 `git commit`、执行端切分支，各自被记为对应的 `kind`。
- AC4：汇报：合法时状态取汇报的 `status`（`done`、`partial`、`blocked` 各一个用例）；不合法时自动重发一次、重发后合法；重发后仍不合法记为 `report_invalid`；`report-<n>.json` 在失败时带 `error.kind`。
- AC5：锁：同一仓库第二次 `run start` 以 `lock_held` 拒绝，`error.data` 带现有任务；两个 `run start` 同时运行时只有一个成功；锁里的 pid 不存活时能拿到锁；`run resume` 重新拿锁。
- AC6：防套娃：`AGENT_COLLAB_ROLE=executor` 和 `DSH_AGENT_COLLAB_ROLE=executor` 各一个用例，退出码 3，`executor_role`。
- AC7：卡死：没有事件超过阈值时记为 `stalled`；等待审批期间超过阈值不记为卡死，审批结束后重新计时。
- AC8：重新接上（T23 的运行时部分）：任务运行中按 PID 结束工作进程，`run wait` 启动新的工作进程接上，任务正常结束；`events.jsonl` 的 `n` 从 1 连续不跳号、不重复，内容和假执行端的完整记录一一对应；`events.jsonl` 最后一行不完整时也能恢复；接不上时记为 `failed`（`worker_lost`）。
- AC9：取消：`run cancel` 后状态为 `cancelled`、锁已释放、之后不能 `resume`；工作进程不响应时，`run cancel` 按 PID 结束它并记为 `cancelled`。
- AC10：续接：`correction` 和 `answer` 的上限分别生效（`round_limit`）；`resend` 不占上限；进行中的任务 `resume` 被拒绝（`not_resumable`）；`prompt-<n>.md` 和 `turn`、`counts` 正确。`stoppedBy: "human"` 时记为 `stopped_by_human`，不自动重发。
- AC11：`state.json` 和 `summary.json` 含 protocol.md 5.5、5.6 列出的每一个字段（测试逐个断言）；`summary.json` 的 `humanInputs`、`approvals`、`questions`、`usage` 合计、`changes`、`turns[]` 和假执行端产生的事件对得上。
- AC12：CLI：每个命令成功时打印一个 JSON 对象（`watch` 除外）；protocol.md 第 6 节拒绝表里的每个 `error.code` 都有用例，退出码符合约定；找不到任务时退出码 4；没有对应适配器时 `executor_unavailable`。
- AC13：`npm test` 全部通过，`npm run build` 退出码 0；仓库仍然没有任何依赖；每个新文件开头有一行职责说明；不出现写死的路径和端口（测试里的临时目录和随机端口除外）；测试不读写真实的 `~/.agent-collab`。

## 非目标

- 不做任何真实适配器（`adapters/dsh.mjs` 在 S4）、`doctor`、`detect.mjs`。
- 不做 `taskTimeoutMinutes`、`tokenBudget`（配置项保留，1a 不生效）。
- 不改 `dsh-bridge/`、`scripts/build.mjs`、`tests/build.test.mjs`、`docs/dev-setup.md`（S2 的范围或由 Claude 回填）。
- 不在 Windows、macOS 上实测（代码按跨平台写，CI 推送后验证）。

## 隔离和安全（违反任何一条都算不通过）

- 遵守 RUNBOOK“派发 dsh 任务”的全部规定。本步不运行 dsh，不读写 `~/.dsh`，不读 `.env`。
- 测试只在系统临时目录下建 git 仓库和 `AGENT_COLLAB_HOME`；不在本仓库里运行 `run start`（本仓库不是测试对象）。
- 只停止自己 spawn 的进程（按 PID）；不执行 kill/pkill/killall/fuser 按名字或端口找进程。
- 遇到需要越权（审批）的操作：不要申请，记为发现。
- 不在本仓库执行 git commit、git push、切分支（测试在临时仓库里做这些可以）；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。发现与它们不一致的地方，写进汇报。

## 汇报

在对话里汇报：第 0 步的原样输出；新建或修改的文件清单（含 `core/` 下新拆出的辅助模块）；逐条 AC 的结果和证据（命令及输出摘要）；你加的 `AGENT_COLLAB_TEST_` 环境变量；`npm test` 的结果和本步测试的耗时；清理检查的方法和结果（临时目录、残留的工作进程和假执行端）；和 PLAN.md、protocol.md 不一致或 protocol.md 没写清楚的地方；没做完的项、遇到的问题和你的疑问。
