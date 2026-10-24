本文件：S3 CI 返工（[1a-s3-ci-rework.md](1a-s3-ci-rework.md)）验收后补两处测试的任务书原文（交给 dsh）。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-24【已确认】用户 2026-10-24，由 Claude 在 dsh Web 派发。依据：Claude 2026-10-24 对 1a-s3-ci-rework 的验收（[1a-impl-plan.md](../1a-impl-plan.md)“进展”）。只改测试，不改产品代码和文档。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S3 原任务书 docs/context/briefs/1a-s3-runtime.md（隔离和安全规则照旧有效），再读上一轮的任务书 docs/context/briefs/1a-s3-ci-rework.md 的第 4 条。

## 第 0 步：沙箱自检（必须先做）

同 S3 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

上一轮 CR1–CR3、CR5–CR7 Claude 重跑都通过，产品修复正确。剩两处测试问题：

- `tests/run-finalize.test.mjs` 的“run wait 返回时它启动的工作进程都已退出、仓库锁已释放”抓不住单独撤回的那处修复。Claude 在副本里只把 `cmdWait` 收尾处恢复成修复前的 `await waitForPidExit(state.worker?.pid ?? lastWorkerPid, 3000);`（不等 `pendingSpawnPid`、不等锁），用例 3/3 仍通过：`AGENT_COLLAB_TEST_WAIT_POLL_MS=50` 时 `run wait` 早就从 `state.json` 读到了新工作进程的 pid，旧写法也会等它。你上一轮的反证是把等待整段删掉，比实际撤回的范围大。Claude 用临时用例把参数改成 `AGENT_COLLAB_TEST_WAIT_POLL_MS=2000`、`AGENT_COLLAB_TEST_PAUSE_BEFORE_RELEASE_MS=2500`（`ATTACH_GRACE_MS=50` 不变），新工作进程在 `run wait` 两次轮询之间收尾：修复版 3/3 通过，撤回版 3/3 失败。
- `tests/run-cancel.test.mjs` 的 `cancelSettledAndCheck`（RW9“对停下的任务取消不应联系执行端”）现在只断言“`run cancel` 之后没有新增 `cancel` 命令”，比原意宽：发一条 `attach` 也算联系了执行端。Claude 在副本里改成“没有新增任何命令”，正常负载 3 次、20 个占满 CPU 的进程下 24 份并发都通过。

## 任务

1. **`run wait` 用例让新工作进程在两次轮询之间收尾**。改 `tests/run-finalize.test.mjs` 的那个用例，让 `run wait` 在新工作进程活着的时候一次都没轮询到它（参数可参考上面的值，但 `PAUSE_BEFORE_RELEASE_MS` 要小于 `run wait` 每个 pid 最多等的 3 秒）；在用例注释里写明为什么要这样取值。原有断言全部保留。
2. **RW9 断言收紧**。`cancelSettledAndCheck` 改成断言 `run cancel` 之后假执行端没有收到任何新命令（不限类型），失败信息里带上新增的命令；保留“之前收到过命令”的前置断言。

## 验收标准

- RC1：第 1 条的用例通过。反证：在副本里只把 `cmdWait` 收尾处恢复成 `await waitForPidExit(state.worker?.pid ?? lastWorkerPid, 3000);`（其余不动），用例连跑 3 次都失败，汇报断言原文；修复版连跑 3 次都通过。
- RC2：第 2 条完成，三个用到 `cancelSettledAndCheck` 的用例通过。反证：在副本里让 `run cancel` 处理已停下的任务时联系一次执行端（改法你定，例如经适配器发一条 `attach`），用例失败；做不到时写明原因。
- RC3：负载：启动 `nproc` 个占满 CPU 的进程（按 PID 结束），期间 `tests/run-finalize.test.mjs` 和 `tests/run-cancel.test.mjs` 各同时跑 8 份、1 轮，全部通过；跑完结束占 CPU 的进程，确认没有残留。
- RC4：回归：`npm test` 连跑 3 次全部通过，每次跑完没有 `fake-executor`、`run.mjs --worker`、`lock-worker` 进程（用 `pgrep` 时注意别匹配到命令自己所在的 shell）。

## 隔离和安全

同 S3 原任务书。不执行 git commit、git push；不修改产品代码（`core/`、`bin/`、`dsh-bridge/`）、docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。只停止自己 spawn 的进程（按 PID）。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 RC 的结果和证据（命令及输出摘要）；你开过的所有后台任务及其结束情况；没做完的项和疑问。
