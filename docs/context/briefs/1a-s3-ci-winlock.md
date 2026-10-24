本文件：S3 推送后 Windows CI 失败的修复任务书原文（交给 dsh）：仓库锁在 Windows 上遇到“正在删除的文件”时的处理，以及 run 测试失败时的诊断输出。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-24【已确认】用户 2026-10-24，由 Claude 在 dsh Web 派发。依据：CI 运行 40087121759（`1f346cb`）Windows Node 20 那组的两个失败（Claude 2026-10-24 读日志分析）；protocol.md §5.2 新增的“正在删除的文件”一条【已确认】用户 2026-10-24。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S3 原任务书 docs/context/briefs/1a-s3-runtime.md（隔离和安全规则照旧有效），再读 docs/protocol.md §5.2（最后一条“正在删除的文件”是这次新加的）。

## 第 0 步：沙箱自检（必须先做）

同 S3 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

`1f346cb` 推送后的 CI：Linux、macOS 4 组和 Windows LTS 通过；Windows Node 20 有 146 个用例，2 个失败：

1. `tests/run-lock-atomic.test.mjs`“4 个进程同时抢 pid 已死的旧锁”：抢锁结果正确（每轮一个成功、三个 `lock_held`），失败的是测试里不停读锁文件的那个循环，第 2 轮读到 `EPERM: operation not permitted, open '…\runs\repo-b\active.lock'`，被记成了“读到了不完整的锁文件”。原因：Windows 上文件被删除、但还有别的进程开着它时，它会进入“删除中”状态，这时再去打开就会得到 `EPERM`，要等最后一个句柄关掉，文件才会消失。
2. `tests/run-lock.test.mjs`“run resume 重新拿锁，期间其他 run start 被锁住”：第一轮 `run wait` 返回 `failed`，期望 `partial`，用例 2 秒结束。测试失败时不输出 `statusReason` 和 `worker.log`，CI 日志里没有能定位的信息。

Claude 读代码时发现，产品代码也有同类隐患：
- `core/rundir.mjs` 的 `inspectLock` 把 `EPERM` 当成“内容读不出来”，在宽限内会误报 `lock_held`。
- `linkLockFile` 遇到 `EPERM` 会退回独占复制，复制再遇到 `EPERM` 就把错误抛出去（不是 `lock_held`）。
- `acquireBreakGuard` 的独占创建只认 `EEXIST`，遇到 `EPERM` 也会抛出去。
- `readLock` 吞掉所有错误、返回 `null`，结果：
  - `updateLock` 读不出锁时，会写出一份只有补丁字段的锁；
  - `releaseLock` 读不出锁时，会当成没有锁直接返回 `false`；
  - `run wait` 等锁释放时，会把“读不出来”当成“已释放”。

## 任务

1. **产品：按 protocol.md §5.2“正在删除的文件”处理 `EPERM`**（`core/rundir.mjs`，必要时改 `core/run.mjs`、`core/worker.mjs` 里用到锁的地方）：
   - 写一个重试工具，仿照 `core/platform.mjs` 的 `renameWithRetry`：只在 `win32` 上、只对 `EPERM` 重试，总预算 1 秒；平台、预算、间隔都可以注入，方便测试。
   - 用这个工具包住 `active.lock` 和 `active.lock.break` 上的打开、`stat`、`link`、独占复制和独占创建。
   - 重试用完仍是 `EPERM` 时，按 §5.2 处理：
     - 读锁按内容读不出来处理；
     - 获取锁抛 `LockHeldError`，`error.data` 为 `null`；
     - 拿互斥文件按没拿到处理；
     - `lockAgeMs` 按“刚写入”处理，不按文件不存在处理。
   - `readLock` 要区分“不存在”和“读不出来”，返回值的形式你定，调用处一并改：
     - `updateLock` 读不出来时报错，不写出缺字段的锁；
     - `releaseLock` 读不出来时报错，不返回 `false`；
     - `run wait` 等锁释放时，把“读不出来”当作“还没释放”，仍受原来 3 秒上限的约束；
     - 对停下的任务执行 `run cancel` 时，读不出来的锁不释放，并在 stderr 提示一句。
   - 工作进程收尾时释放锁失败，只记进 `worker.log`：不能改动已经写好的终态，也不能走 `drive()` 外层的 `finalize('failed', …)`。
   - 非 `win32` 平台上的行为保持不变。
2. **测试读锁**：`tests/run-lock-atomic.test.mjs` 里不停读锁文件的那个循环：
   - 只在 `win32` 上把 `EPERM` 当作“文件正在消失”，跟 `ENOENT` 一样不算错，但要计数，最后用 `t.diagnostic` 输出次数；
   - 其他平台上，`EPERM` 和 JSON 解析失败照旧记为错误。
3. **诊断输出**：在 `tests/helpers/run-harness.mjs` 加一个函数，给定运行目录，返回一段诊断文字：
   - `state.json` 的 `status`、`statusReason`；
   - `worker.log` 最后约 40 行；
   - `events.jsonl` 最后约 10 条事件的 `type`。
   
   `tests/run-*.test.mjs` 里所有对 `run wait`、`run status`、`run start` 返回的任务状态（`json.status`）做的断言，失败信息都要带上这段诊断和这次命令的 stdout、stderr。可以改成一个统一的断言函数。原有断言的判断条件一条都不放宽。
4. **单元测试**：
   - 重试工具：注入 `win32`，操作先抛 N 次 `EPERM` 再成功，结果成功；一直抛 `EPERM`，用完预算后按任务 1 的规则落地；注入 `linux`，第一次 `EPERM` 就抛出。
   - 读不出来的锁：在 Linux 上用“`active.lock` 是一个目录”造出读锁的非 `ENOENT` 错误，断言 `updateLock` 报错且没有写出缺字段的锁，`releaseLock` 报错且目录还在。
   - 另外读一遍 `run-lock.test.mjs` 失败那条用例的代码路径，判断有没有哪条和锁有关的路径会让第一轮记成 `failed`。在汇报里写结论和依据；与锁无关的代码不改。

## 验收标准

- WL1：任务 1、4 完成，新单元测试通过。反证：在副本里让重试工具不重试（直接抛出），重试相关的单元测试失败；把 `readLock` 恢复成吞掉所有错误返回 `null`，“读不出来的锁”那组单元测试失败。汇报断言原文。
- WL2：任务 2 完成。Linux 上的判断逻辑不变：说明怎么确认的（例如在副本里让读取注入一次 `EPERM`，Linux 上照旧记为错误）。
- WL3：任务 3 完成。反证：在副本里让工作进程每一轮都以 `failed`（`executor_error`）收尾，并在 `worker.log` 写一行可识别的文字，跑 `tests/run-lock.test.mjs`，失败信息里出现 `statusReason` 和这行文字。汇报失败信息原文，长的话摘录。
- WL4：负载：启动 `nproc` 个占满 CPU 的进程（按 PID 结束），期间 `tests/run-lock-atomic.test.mjs` 和 `tests/run-lock.test.mjs` 各同时跑 8 份、1 轮，全部通过；跑完结束占 CPU 的进程，确认没有残留。
- WL5：回归：`npm test` 连跑 3 次全部通过，每次跑完没有 `fake-executor`、`run.mjs --worker`、`lock-worker` 进程（用 `pgrep` 时注意别匹配到命令自己所在的 shell）。
- Windows 上的效果这边测不了，由 Claude 提交推送后看 CI。

## 隔离和安全

同 S3 原任务书。不执行 git commit、git push；不修改 docs/ 下的任何文件（包括 PLAN.md、protocol.md、dev-setup.md 和 docs/context/）、AGENTS.md、`bin/`、`dsh-bridge/`；产品代码只改 `core/rundir.mjs`，以及 `core/run.mjs`、`core/worker.mjs` 里用到锁的地方。新增 `AGENT_COLLAB_TEST_*` 变量时在汇报里列出，dev-setup.md 由 Claude 回填。只停止自己 spawn 的进程（按 PID）。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 WL 的结果和证据（命令及输出摘要）；任务 4 对第二个失败的分析；你开过的所有后台任务及其结束情况；没做完的项和疑问。
