本文件：Windows LTS 上 `run-finalize.test.mjs`“run wait 返回时它启动的工作进程都已退出”偶发失败的修复任务书原文（交给 dsh）。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿，用户未逐份审阅。依据：CI 运行 40121813847（`e0364bd`）Windows LTS 失败；同一用例 `965ca04` 的 Windows LTS 上也失败过一次（docs/context/1a-impl-plan.md、docs/context/RISKS.md R11）；其余平台和 Windows Node 20 都通过。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和“按 CI 的条件重跑测试”、docs/context/RISKS.md 的 R11，再读 `tests/run-finalize.test.mjs` 第 74 行起的用例和它用到的 `tests/helpers/` 代码。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书（docs/context/briefs/1a-s4-dsh-adapter.md）第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程（不在 bwrap 里、命令行是 `dsh web` 的那个）就停止。

## 现象

```
✖ run wait 返回时它启动的工作进程都已退出、仓库锁已释放 (7227.9984ms)
  AssertionError [ERR_ASSERTION]: worker.log 里应记过至少两个工作进程的 pid，实际 [9316]
      at TestContext.<anonymous> (file:///D:/a/agent-collab/agent-collab/tests/run-finalize.test.mjs:115:10)
```

任务最终是 `partial`（前面的断言都过了），只是 `worker.log` 里去重后只有一个 pid。

## 原因（Claude 的判断，把握：中，请核实）

用例用 `new Set(...)` 对 `worker.log` 里的 `pid N` 去重，再要求至少两个。被 `SIGKILL` 的工作进程和 `run wait` 新启动的工作进程如果在 Windows 上拿到同一个 PID（R11 里记过 Windows 复用 PID 很快），去重后就只剩一个。另一种可能是新工作进程没有写“工作进程启动”那一行；CI 没有输出 `worker.log` 原文，分不清。

## 任务

1. 核实上面两种可能：读 `core/worker.mjs` 写“工作进程启动”的时机，确认 `run wait` 启动的工作进程在这个用例的条件下一定会写这一行；在本机能不能构造出“两个工作进程同一个 pid”不强求。
2. 改用例：按“工作进程启动”的行数判断启动过几次（应不少于 2），不靠 pid 去重；“每个记过的 pid 都已退出”的检查照旧；断言失败时把 `worker.log` 全文放进失败信息，下次 CI 再失败时能看到原因。检查 `tests/` 里其他按 pid 去重计数的断言有没有同样的问题，一并改，汇报里列出。
3. 不改产品代码。如果第 1 步发现是产品问题（新工作进程确实可能不写启动记录），停下，在汇报里写清证据和建议，不要改。

## 验收标准

- FF1：改后的用例在本机通过；用测试变量或临时改动模拟“两次启动拿到同一个 pid”（例如在用例里把读到的日志替换成两行同 pid 的启动记录做一次自检，自检代码不留在仓库里），旧断言失败、新断言通过，汇报两者的输出原文。
- FF2：`npm test` 连跑 3 次全部通过，无残留进程；`chmod 644` 副本里默认参数和 Node 20 模拟参数各跑一次，全部通过。
- FF3：汇报写明改了哪些断言、第 1 步的核实结论（读到的代码位置）。

## 隔离和安全

遵守 RUNBOOK“派发 dsh 任务”的全部规定：不读写 `~/.dsh`，不读 `.env`，不连接用户的 dsh Web（`~/.dsh/agent-collab/bridge-web.json` 不要读）；不调用真实模型。不执行 git commit、git push、切分支；不改 docs/ 和 AGENTS.md；只改 `tests/`；只停止自己 spawn 的进程（按 PID）；遇到需要越权（审批）的操作：不要申请，记为发现。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；第 1 步的核实结论；FF1–FF3 的结果和证据；你开过的所有后台任务及其结束情况；没做完的项和疑问。
