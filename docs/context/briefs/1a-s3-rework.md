本文件：第 1a 阶段 S3（运行时）验收后交给 dsh 的返工任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-24，用户同日派发；RW1–RW10 同日验收通过。第 8、9 条的做法【已确认】用户 2026-10-24，已先写进 protocol.md §3、§5.5、§6（见 [DECISIONS.md](../DECISIONS.md)）。依据：S3 验收（[1a-impl-plan.md](../1a-impl-plan.md)“进展”）。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S3 原任务书 docs/context/briefs/1a-s3-runtime.md（隔离和安全规则照旧有效）。docs/protocol.md 只读第 3 节和第 5、6 节；第 8、9 条以 protocol.md 2026-10-24 修改后的条文为准。

## 第 0 步：沙箱自检（必须先做）

同 S3 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

S3 的大部分功能经 Claude 重跑通过：单独跑每个文件都绿，AC1–AC4、AC6–AC8、AC10、AC12 的用例和断言是实打实的。但有下面几处要改，其中前三条是 Claude 实测复现的。

另外：上一轮你在 11:25 开的后台任务（逐个跑 S3 测试文件的那条 `for f in …` 命令）里，`tests/run-resume.test.mjs` 卡住没有退出，汇报时它还在跑；汇报里写的“无残留进程”不成立。这一轮汇报时列出你开过的所有后台任务，逐个确认已经结束。

## 任务

1. **测试偶发卡死 60 秒并留下孤儿进程**。Claude 连跑 `npm test` 11 次，2 次失败：`startFakeExecutor` 看到端口文件存在就读，读到假执行端还没写完的空文件，`JSON.parse` 报错（`tests/helpers/run-harness.mjs:109`）；失败后这个假执行端没有任何清理代码结束它，它的 stdio 管道让测试进程退不出，整个文件挂到 `--test-timeout` 的 60 秒，假执行端变成孤儿。
   - 假执行端用原子写入（临时文件加改名）写端口文件；`startFakeExecutor` 读失败时也重试，不靠时序。
   - 每个用例启动的假执行端都登记到 `ctx` 上，`ctx.cleanup()` 无论用例成败都按 PID 结束它们；用例失败不能让测试进程挂住。
2. **仓库锁不是原子的**（`core/rundir.mjs` 的 `acquireLock`）。现在先以 `wx` 创建空文件再写内容；另一个进程在这个空当读到空文件，判为“内容不可用”，删掉别人刚拿到的锁再建自己的。Claude 用 4 个进程同时调用 `acquireLock`，60 轮里有 2 轮不止一个拿到锁。打破 pid 已死的旧锁时也有同样的问题：两个进程都判定旧锁已死，先建好新锁的那个会被另一个删掉。
   - 锁文件出现时内容必须已经完整（例如先写临时文件，再用 `fsp.link` 链接成 `active.lock`，`EEXIST` 即被占用）；打破旧锁不能误删别人新建的锁。Windows 上也要成立。
   - 读不出内容的锁不能直接当作已死：按修改时间给一个短的宽限（例如 5 秒），宽限内按被占用处理。
3. **`run cancel` 会覆盖已经自己停下的任务**（`core/run.mjs` 第 524–527 行）。等待期间看到任务已停下（例如执行端刚好以 `done` 结束）就跳出循环，接着照样把状态改成 `cancelled`、原因写“工作进程未响应，按 PID 结束”，并用 `changes: null`、`violations: []` 重写 `summary.json`。Claude 复现：`report-1.json` 是 `done`，`summary.json` 却是 `cancelled`，原因是“工作进程未响应”。
   - 等待期间任务自己停下了：不结束任何进程，按第 9 条“对停下的任务取消”处理。
   - 工作进程确实不响应、按 PID 结束它时：`summary.json` 的 `changes`、`violations` 照工作进程的算法对基线重新算（复用 `core/git.mjs`），不写空值。
4. **被跟踪又被忽略的文件不进快照**（`core/git.mjs` 的 `snapshotWorktree`）。临时 index 从空开始，`git add -A` 会跳过匹配 `.gitignore` 的已跟踪文件（例如 `git add -f` 加进去的配置文件），执行端改了它，补丁里没有，受保护路径的检查也漏掉。Claude 已实测。
   - 临时 index 从用户 index 的副本开始（用 `git rev-parse --git-path index` 找到文件，复制到运行目录外的临时文件；用户的 index 只读不写），没有 index 时从空开始。这样已跟踪的文件始终在快照里，`git add` 也能用上 stat 缓存。
5. **解析 git 输出要用 `-z`**（`changesBetween`、`changedPathsUnder`）。Claude 实测两个问题：中文路径在 `changes.files` 里是 `"\344\270\255…"` 这样带引号的转义；跨目录改名（`src/{a => b}/f.js`）的增删行数被记成 0。改为 `--name-status -z`、`--numstat -z` 解析。受保护路径传给 git 时加 `:(literal)` 前缀，避免 `*`、`?` 被当成通配符。
6. **`summary.reportError` 只取最后一轮**。protocol.md 5.6：“最近一轮汇报提取失败的 `{ kind, message }`，否则为 `null`”。现在第 1 轮不合法、重发后合法时，`summary` 里既有 `report` 又有第 1 轮的 `reportError`。
7. **运行时字段不能被适配器事件覆盖**（`core/events.mjs` 的 `append`）：`v`、`n`、`at`、`turn` 放到展开 `partial` 之后。第 3 节规定适配器不带这几个字段，这里是防御。
8. **`attach` 时本轮已经结束**（protocol.md §3、§6 的 `run wait`）。现在 `attached: true, running: false` 记为 `failed`（`turn_lost`），工作进程不在期间执行端跑完的那一轮的汇报就丢了；工作进程掉线（重启、注销、被杀）而执行端继续跑完，正是 T23 要覆盖的情形。改为：`attach` 在 `running` 为 false 时带回 `result: TurnResult`（适配器从补发的事件算出，`finalText` 的算法同第 3 节），工作进程照正常的一轮结束处理（写补丁和汇报、按优先顺序定状态、需要时重发）。没有 `result` 时才记 `failed`（`worker_lost`）。假适配器、假执行端跟着支持。
9. **对停下的任务 `run cancel`**（protocol.md §6 的 `run cancel`）。现在以 `not_running`（退出码 1）拒绝。改为：任务处于“停下”状态时，`run cancel` 直接把它记为 `cancelled`（不需要工作进程，也不联系执行端），`statusReason` 写明原来的状态（例如“设计端取消；取消前为 done”），`state.json` 和 `summary.json` 只更新 `status`、`statusReason`、`endedAt`，其余字段保持不变；之后不能 `resume`，`run status` 不再列出它。已经是 `cancelled` 的照旧直接返回成功。

## 验收标准

- RW1：`npm test` 连跑 20 次全部通过；每次跑完 `pgrep -f tests/fixtures/fake-executor` 和 `pgrep -f 'run.mjs --worker'` 都没有输出。再临时让一个用例在 `startFakeExecutor` 之后立即抛错，这个测试文件在 5 秒内结束、没有残留进程（验证后还原）。
- RW2：新增多进程用例：4 个进程同时 `acquireLock`，分别在“没有锁”和“有一个 pid 已死的旧锁”两种情况下各跑至少 20 轮，每轮恰好一个拿到锁、其余 `lock_held`；读不出内容的新锁在宽限内按被占用处理。
- RW3：任务在 `run cancel` 等待期间自己以 `done` 结束时，`report-1.json` 不变，`summary.json` 的 `changes`、`violations`、`report` 与取消前一致，`status` 为 `cancelled`，`statusReason` 写明取消前为 `done`，没有结束任何进程；工作进程不响应的用例里，`summary.changes` 和执行端实际改动对得上。
- RW4：已跟踪且匹配 `.gitignore` 的文件被执行端修改：出现在补丁和 `changes.files` 里；它在受保护路径下时记为 `protected_path`。用户的 `.git/index` 前后字节相同。
- RW5：中文路径在 `changes.files` 和违规的 `detail` 里是原样的；跨目录改名并改一行时 `change: "R"`、`from` 正确、`added: 1`；带空格的路径正确；受保护路径里的 `*` 按字面匹配。
- RW6：“不合法 → 重发 → 合法”的用例断言 `summary.reportError` 为 `null`；“重发后仍不合法”的用例断言它是最后一轮的错误。
- RW7：假适配器发一个自带 `n: 999`、`turn: 99` 的事件，`events.jsonl` 里的 `n`、`turn` 仍由运行时分配。
- RW8：用例：工作进程被结束后，假执行端把这一轮跑完（产生事件、改文件、以合法汇报结束），之后 `run wait` 接上，任务状态取汇报的 `status`，`patch-1.diff`、`report-1.json` 正确，`events.jsonl` 的 `n` 连续、内容与假执行端记录一一对应；`attach` 不带 `result` 时仍记 `failed`（`worker_lost`）。
- RW9：对 `done`、`stalled`、`failed` 的任务 `run cancel` 各一个用例：输出 `{ ok: true, runId, status: "cancelled" }`、退出码 0，之后 `resume` 为 `not_resumable`，`run status` 不再列出。
- RW10：回归：`npm test` 全部通过，本步新增和原有的 S3 测试合计在 60 秒内跑完；`npm run build` 退出码 0，跑完删掉 `dist/`；仓库仍然没有任何依赖。

## 不用改

- 原汇报里第 1、2、5、6、7、8 条（`state.json` 多出的字段、`session` 事件由运行时写、拒绝表之外的 `error.code`、`run wait` 的文件取最后一轮、仓库外 `run status` 返回空列表、`turn_end` 两种来路）按现在的实现保留，由 Claude 回填 protocol.md。
- `--set` 的点号路径和“不是合法 JSON 就按字符串”保留。
- `watch` 每次轮询都重读整个 `events.jsonl`：1a 不改，记为后续优化。

## 隔离和安全

同 S3 原任务书。不执行 git commit、git push；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。只停止自己 spawn 的进程（按 PID）。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 RW 的结果和证据（命令及输出摘要）；你开过的所有后台任务及其结束情况；`npm test` 20 次的结果和 S3 测试的耗时；和 protocol.md 不一致的地方；没做完的项和疑问。
