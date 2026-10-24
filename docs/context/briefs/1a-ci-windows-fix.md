本文件：S1、S2 推送后 Windows CI 卡住的修复任务书原文（交给 dsh）。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-23，用户同日派发。依据：CI 运行 39972322180 的 Windows 完整日志（用户 2026-10-23 提供）。其余 80 个用例在 Windows 上全部通过。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”。隔离和安全规则同 S2 原任务书 docs/context/briefs/1a-s2-bridge.md“隔离和安全”。

## 第 0 步：沙箱自检（必须先做）

运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

推送 `176eb90` 后，CI 在 Linux、macOS（Node 20 和 LTS）共 4 组 10 多秒通过；Windows 两组卡在 `node --test`，20 多分钟不结束。日志按文件名顺序输出到 `config-schema.test.mjs` 为止，下一个文件 `tests/config.test.mjs` 没有输出，卡在它上面。

原因已由完整日志证实（用户 2026-10-23 提供）：该用例在第 345 行的 `saveConfig` 抛出 `EPERM: operation not permitted, rename '…\.config.json.tmp-…' -> '…\config.json'`（`core/platform.mjs:35`），之后测试文件挂起约 23 分钟，最后报 `Promise resolution is still pending but the event loop has already resolved`。机制如下：`saveConfig 的写入是原子的：并发读取始终能看到完整 JSON` 这个用例里，后台读循环只在 `for` 循环正常结束后才设 `stop = true`。Windows 上目标文件正被读取时，`fs.rename` 覆盖它可能失败（`EPERM`、`EACCES`、`EBUSY`），`saveConfig` 一抛错，`stop` 永远不会变成 `true`，读循环靠 `setTimeout` 一直让进程活着，测试文件就永远不结束。所以这里有两个问题：测试出错时会挂死，`writePrivateFile` 在 Windows 上遇到并发读会失败。

## 任务

1. **测试出错不能挂死**：`tests/config.test.mjs` 的这个用例，`stop = true` 放进 `finally`，保证无论写入是否抛错，读循环都会结束，然后才断言。全仓库其他“后台循环等标志位”的写法同样处理（目前 Claude 只找到这一处，你再查一遍）。
2. **`core/platform.mjs` 的 `writePrivateFile` 在 Windows 上重试改名**：`rename` 遇到 `EPERM`、`EACCES`、`EBUSY` 时，在 Windows 上退避重试（例如最多 10 次，间隔从 10 ms 逐步加到 200 ms 左右，总时长在 2 秒内），仍失败才清理临时文件并抛出原错误。其他平台、其他错误码不重试。加单元测试：用 `node:test` 的 `mock` 让 `rename` 前几次抛 `EPERM`，断言在 win32 分支下最终成功、临时文件不残留；重试次数用尽时抛出原错误、临时文件不残留（平台判断做成可注入的，让测试在 Linux 上也能走 Windows 分支）。
3. **桥接的发现文件写入同样处理**：`dsh-bridge/lib/index.js` 的 `atomicWriteJson` 现在在 Windows 上改名失败时先删目标再改名，中间有一段时间发现文件不存在；注释“Windows 上 rename 不能覆盖已存在的目标文件”也不对（Node 在 Windows 上的 `rename` 会覆盖）。改成和第 2 条相同的重试做法（桥接拿不到 `core/`，在桥接里放一份同样的逻辑），去掉先删后改名。
4. **CI 卡住时要尽快失败**：`.github/workflows/ci.yml` 给作业加 `timeout-minutes: 10`；`node --test` 加 `--test-timeout=60000`（Node 20 支持），`package.json` 的 `test` 脚本同步改，并更新 `tests/package.test.mjs` 里对 `scripts` 的断言和 `docs/dev-setup.md` 里的命令说明。这样以后哪个用例卡住，会在 1 分钟内失败并报出用例名。

## 验收标准

- AC1：第 1 条：故意让该用例里的 `saveConfig` 第 5 次调用抛错（临时改测试，不提交），`node --test tests/config.test.mjs` 在几秒内以失败结束，不挂死；汇报附输出摘要。
- AC2：第 2、3 条的单元测试通过，覆盖“重试后成功”和“重试用尽抛原错误”，两种情况都没有临时文件残留。
- AC3：第 4 条：`npm test` 实际带上 `--test-timeout`；临时加一个永不结束的用例（不提交）时，`npm test` 在约 1 分钟内失败并报出用例名。
- AC4：回归：`npm test` 全部通过，`npm run build` 退出码 0，`node tests/integration/bridge-dsh.mjs` 和 `node tests/integration/acp-client-dsh.mjs` 最后一行仍是 `RESULT: 通过`；仓库没有依赖；`lib/jsonrpc.js` 仍与 `core/jsonrpc.mjs` 相同。
- Windows 上是否真的通过，以推送后的 CI 为准；推送由用户授权，不在本任务内。

## 隔离和安全

同 S2 原任务书“隔离和安全”，违反任何一条都算不通过。不执行 git commit、git push；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 AC 的结果和证据（命令及输出摘要）；第 1 条你额外查到的同类写法；没做完的项和疑问。
