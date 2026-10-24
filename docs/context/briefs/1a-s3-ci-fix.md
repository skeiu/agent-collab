本文件：S3 推送后 CI 失败的修复任务书原文（交给 dsh）。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-24，待用户派发；第 1–3 条依据的 protocol.md 修改（§5.3、§5.5）【已确认】用户 2026-10-24。依据：CI 运行 40065381813（`ba4c802`）的 macOS LTS 和 Windows Node 20 日志（用户 2026-10-24 提供）以及 Claude 在本机加负载的复现。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S3 原任务书 docs/context/briefs/1a-s3-runtime.md（隔离和安全规则照旧有效）。docs/protocol.md 只读 §5.3、§5.5 和 §6 的 `run wait`；第 1–3 条以 protocol.md 2026-10-24 修改后的条文为准。

## 第 0 步：沙箱自检（必须先做）

同 S3 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

S3 在本机 Linux 上连跑十几次都绿，推送后 CI 有 3 组失败：Windows Node 20 和 LTS、macOS LTS（Linux 两组、macOS Node 20 通过）。看到的 5 个失败里 3 个是产品缺陷，Claude 在本机复现了；Windows Node 20 另有 2 个失败在日志里被截掉了，推测和 macOS 的两个相同。

## 任务

1. **同一个任务会开出第二个执行端会话**（产品缺陷）。macOS 上 `tests/run-attach.test.mjs` 的 RW8 用例报“事件条数和执行端记录不一致 4 !== 6”。Claude 在本机满 CPU 负载下复现（96 次里 2 次），现场显示假执行端把同一轮跑了两遍（cursor seq 1–3、seq 4–6），`worker.log` 里有两次“工作进程启动”，第二个工作进程的事件里又写了一条 `session`。原因：测试看到第一个事件就杀掉工作进程，这时 `sessionId` 还没写进 `state.json`（一次是 `session` 事件已写、`state.json` 还没写）；新工作进程看到没有 `sessionId`，就走了 `start` 分支（`core/worker.mjs` 的 `if (!state.executor.sessionId)`）。
   - 只在任务为 `starting`、没有 `sessionId` 时调用 `start`。
   - `state.json` 里没有 `sessionId` 时，从 `events.jsonl` 里最后一条 `session` 事件恢复；恢复得到就照常 `attach`。
   - 任务已在进行中却哪里都找不到 `sessionId`：记为 `failed`（`worker_lost`），不再新开会话。
   - `start` 返回后先把 `sessionId` 写进 `state.json`，再处理排队的事件和写 `session` 事件，尽量缩短这个窗口。
   - 假执行端记下收到的 `start` 次数，测试里断言每个任务只有一次。
2. **`run wait` 返回时 `summary.json` 可能还不存在**（产品缺陷）。macOS 上“attach 不带 result 仍记 failed”用例：`run wait` 已返回 `failed`/`worker_lost`，接着读 `summary.json` 报 `ENOENT`。原因有两处：`finalize` 先把终态写进 `state.json`（`setStatus` 那一次写入），后写 `summary.json`；`run wait` 等工作进程退出时，用的是从 `state.json` 读到的 pid，新工作进程从启动到收尾都在一次轮询间隔里完成时，`run wait` 没见过它的 pid，拿已经死掉的旧 pid 去等，立即返回。
   - `finalize` 改为：追加 `status` 事件，写 `summary.json`，最后才把终态写进 `state.json`（protocol.md §5.3）。终态那次 `state.json` 写入失败仍按错误处理。
   - `run wait` 等进程退出时也要等自己启动的那个工作进程（`pendingSpawnPid`）。
3. **续接和接上后立刻被判为卡死**（产品缺陷）。Windows 上“等待审批期间超过阈值不算卡死”记成了 `stalled`。原因：`lastActivityAt` 只在收到事件时更新，`run start` 时是创建时间，`start`、`resume`、`attach` 都不重置它。Claude 在本机复现了更严重的情形：卡死阈值 1 秒，第 1 轮 `blocked` 停下，2.5 秒后 `run resume`，执行端 300 ms 后就有事件，任务仍被记为 `stalled`。正式环境里设计端审阅超过 15 分钟再续接、执行端在第一次卡死检查之前没出事件，就会被误取消。
   - 工作进程调用 `start`、`resume`（含重发汇报）之前和 `attach` 成功之后，把 `lastActivityAt` 设为当时（protocol.md §5.5）。
   - 加用例：上面的续接情形（短阈值，停下后等超过阈值再 `resume`）不再记为 `stalled`；`attach` 接上一个之后还要过一会儿才有事件的会话，不记为 `stalled`。
4. **测试本身的问题**：
   - `tests/run-baseline.test.mjs` 第 153 行写 `star*file.txt`：Windows 文件名不能含 `*`，`writeFile` 报 `ENOENT`。Windows 上跳过带 `*` 的那部分（只跳这一部分，中文、空格、跨目录改名照测），用 `t.diagnostic` 或注释说明原因。
   - `tests/run-cancel.test.mjs` 的 RW3 用例靠“这一轮 900 ms 跑完、工作进程 1200 ms 才查 `cancel.request`”的时间差制造竞态，Windows 上这一轮慢，工作进程先看到取消，`summary` 从来没有 `done`，用例等满 10 秒失败。改成不依赖时序的做法，例如把工作进程查 `cancel.request` 的间隔和 `run cancel` 自己的轮询间隔拆成两个测试变量（`run cancel` 的那个新变量名以 `AGENT_COLLAB_TEST_` 开头，汇报里写出来），让工作进程在这个用例里根本不会先看到取消。
   - `tests/run-stall.test.mjs`：第 3 条改完后再看阈值和等待时长的比例是否留够余量（例如阈值 300 ms 对 900 ms 的审批），慢机器上也要稳定。
   - `tests/run-attach.test.mjs` 的 RW8 和“不带 result”两个用例：杀工作进程之前先等 `state.json` 里有 `sessionId`，否则测的不是“接上”而是第 1 条的情形；第 1 条的情形另写用例。

## 验收标准

- FX1：第 1 条：新用例在 `sessionId` 写入 `state.json` 之前结束工作进程（可以用测试变量让工作进程在 `start` 返回后停一下），之后 `run wait`：假执行端只收到一次 `start`；`events.jsonl` 里有 `session` 事件时接上并正常结束，没有时记为 `failed`（`worker_lost`）。
- FX2：第 2 条：所有 `run wait` 返回终态的用例，返回后立即读 `summary.json` 都能读到（可以在测试夹具里统一断言）；新用例覆盖“新工作进程在一次轮询间隔内就收尾”的情形（把 `AGENT_COLLAB_TEST_WAIT_POLL_MS` 调大）。
- FX3：第 3 条的两个新用例通过。
- FX4：第 4 条的改动完成；RW3 用例里工作进程确实没有先看到取消（断言 `events.jsonl` 里没有“收到 cancel.request”的 `warning`）。
- FX5：负载下稳定：先启动 `nproc` 个占满 CPU 的进程（例如 `node -e 'const e=Date.now()+600000;while(Date.now()<e){}'`，按 PID 结束），在这期间把 `tests/run-attach.test.mjs`、`tests/run-cancel.test.mjs`、`tests/run-stall.test.mjs` 各同时跑 8 份、连跑 3 轮，全部通过；跑完结束占 CPU 的进程，确认没有残留。
- FX6：回归：`npm test` 连跑 10 次全部通过，每次跑完没有 `fake-executor`、`run.mjs --worker`、`lock-worker` 进程；S3 的测试合计仍在 60 秒内；`npm run build` 退出码 0，跑完删掉 `dist/`。
- Windows、macOS 上是否通过，以推送后的 CI 为准；推送由用户授权，不在本任务内。

## 隔离和安全

同 S3 原任务书。不执行 git commit、git push；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。只停止自己 spawn 的进程（按 PID）。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 FX 的结果和证据（命令及输出摘要）；新增的 `AGENT_COLLAB_TEST_` 变量；你开过的所有后台任务及其结束情况；和 protocol.md 不一致的地方；没做完的项和疑问。
