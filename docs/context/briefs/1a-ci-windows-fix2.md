本文件：Windows CI 修复第 2 轮交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：2026-10-24 派发并验收通过（见 [1a-impl-plan.md](../1a-impl-plan.md)“进展”），推送后 CI 运行 40056577654 全部通过（`a67780f`）。依据：CI 运行 40055863970 的 Windows 日志（用户 2026-10-24 提供）。第 1 轮见 [1a-ci-windows-fix.md](1a-ci-windows-fix.md)。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和第 1 轮任务书 docs/context/briefs/1a-ci-windows-fix.md（隔离和安全规则照旧有效）。

## 第 0 步：沙箱自检（必须先做）

运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

第 1 轮修复（`2719951`）推送后，Windows 两组不再挂住，8 秒跑完 88 个用例，87 个通过。唯一失败的还是 `tests/config.test.mjs` 的并发读写用例：用例耗时 3.6 秒，其中某一次 `saveConfig` 把 10 次改名重试（约 1.1 秒）全部用完，仍抛 `EPERM`（栈经过 `renameWithRetry`，`core/platform.mjs:36`）。

说明 1.1 秒的重试预算在 Windows 上不够：读循环每隔约 1 ms 打开一次目标文件，加上 Windows Defender 扫描新文件时也会占着句柄，改名要等到没有任何句柄打开目标文件的空当才能成功。常用的 graceful-fs 对同样的错误在 Windows 上最多重试 60 秒。这个场景在产品里真实存在：S3 的工作进程频繁更新 `state.json`，同时 `run wait`、`run status` 在读它。

## 任务

1. **加大重试预算**：`core/platform.mjs` 和 `dsh-bridge/lib/atomic-write.js` 的 `renameWithRetry` 改为按总时长控制：Windows 上对 `EPERM`、`EACCES`、`EBUSY` 持续重试，直到总耗时超过 10 秒；间隔从 10 ms 起逐次加倍，上限 100 ms，每次加一点随机抖动（0–10 ms）。超时仍失败时抛出最后一次的原错误，并在错误对象上加 `attempts`（尝试次数）和 `elapsedMs`。总预算和间隔做成可注入的参数，测试里用短预算。两份实现保持一致。
2. **测试**：
   - 更新 `tests/atomic-write.test.mjs`：“重试用尽”用注入的短预算（例如 200 ms）跑，断言抛原错误、带 `attempts` 和 `elapsedMs`、临时文件不残留；“重试后成功”“非 Windows 不重试”“其他错误码不重试”照旧。
   - `tests/config.test.mjs` 的并发读写用例**不改读循环的频率**，它就是用来逼出这种情况的；失败时让断言信息带上错误的 `attempts` 和 `elapsedMs`，方便下次看 CI 日志。
3. 不改别的：第 1 轮的超时设置、桥接发现文件的写法（只换重试实现）保持不变。

## 验收标准

- AC1：`node --test tests/atomic-write.test.mjs` 全部通过，“重试用尽”用例在 1 秒内结束。
- AC2：两份 `renameWithRetry` 行为一致（同一组单元测试分别跑两份实现）。
- AC3：回归：`npm test` 全部通过；`npm run build` 退出码 0；`node tests/integration/bridge-dsh.mjs` 和 `node tests/integration/acp-client-dsh.mjs` 最后一行仍是 `RESULT: 通过`；跑完删掉 `dist/`（上一轮留下过）。
- Windows 上是否通过，以推送后的 CI 为准；推送由用户授权，不在本任务内。

## 隔离和安全

同第 1 轮任务书。不执行 git commit、git push；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 AC 的结果和证据；没做完的项和疑问。
