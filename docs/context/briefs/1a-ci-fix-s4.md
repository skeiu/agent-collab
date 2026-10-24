本文件：S4 推送后 CI 失败的修复，以及 R11（Windows CI 偶发失败）的修复任务书原文（交给 dsh）：假 dsh 安装在 CI 上不可用；测试清理时按已经退出的进程的 PID 结束进程。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿并在 dsh Web 派发，用户未逐份审阅。依据：CI 运行 40111031100（`6639f3b`，6 组全部失败）和 40089909906（`52f3795`，Windows Node 20）的日志；[RISKS.md](../RISKS.md) R11。只改测试，不改产品代码和文档。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S4 原任务书 docs/context/briefs/1a-s4-dsh-adapter.md（隔离和安全规则照旧有效），再读 docs/context/RISKS.md 的 R11。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景一：S4 的测试在 CI 上全部失败

`6639f3b` 推送后 CI 6 组都失败，本机却全部通过。Claude 用 `git archive HEAD` 导出到 `/tmp` 后运行，复现了两个原因：

- 开发分区（`core.fileMode=false`，没有权限位）上所有文件都显示为可执行。`tests/helpers/fake-dsh-install.mjs` 用 `copyFile` 把 `tests/fixtures/fake-dsh-cli.mjs` 复制成假的 `lib/bin.js`，本机复制出来是 0755，CI 的检出是 0644，PATH 上的 `dsh` 符号链接指向不可执行的文件，`findCommand` 找不到 dsh：`detect` 的符号链接用例、`doctor` 的多数用例失败（“在 PATH 上找不到 dsh 命令”）。
- 假的 `js-yaml`（和 `yaml`）的 `index.js` 用 `export` 语法，`package.json` 却没有 `"type": "module"`。适配器用 `require()` 加载它：本机 Node 22 会按语法把它当 ESM 并允许 `require(esm)`，Node 20 不会，加载失败，acp 模式的用例全部以 `overlay_yaml_unavailable` 失败。用 `NODE_OPTIONS='--no-experimental-require-module --no-experimental-detect-module'` 在 Node 22 上可以复现。真 dsh 里的 `js-yaml` 是 CommonJS。

## 背景二：R11

Windows CI 上已有三次没有输出的偶发失败：

- `1f346cb`（Windows Node 20）：`run resume` 用例第一轮记成了 `failed`；
- `b14504a`（Windows LTS）：`run-stall.test.mjs` 整个文件 0.45 秒就失败，一个用例都没跑，没有输出；
- `52f3795`（Windows Node 20）：`tests/run-report.test.mjs` 的 `startTask` 里 `run wait` 退出码 1，stdout 和 stderr 都是空的（断言信息为空，才显示成默认的 `1 !== 0`）。

Claude 的判断（把握：中）：测试清理时对“登记过的”PID 一律 `SIGKILL`，不管这个进程是不是早就退出了：

- `tests/helpers/run-harness.mjs` 的 `cleanup` 对 `ctx.workerPids` 里每个 PID 调 `killPid`；`killLeftoverWorkers` 对每个 `state.json` 里 `worker.pid` 存活的都结束，不看任务状态。正常情况下工作进程收尾后早已退出。
- `tests/helpers/dsh-case.mjs` 的 `cleanup` 对 `workerPids` 一律 `SIGKILL`；`stopWebs` 对发现文件里的 `pid` 一律 `SIGTERM`，不管那个 Web 还在不在。

Windows 会很快复用 PID，`node --test` 又是多个测试文件并行跑：清理时这个 PID 可能已经属于别的测试文件的进程（整个文件没有输出就失败）、别的用例正在跑的 `run wait`（Windows 上被 `TerminateProcess` 结束的进程退出码是 1、没有输出），或者别的用例的工作进程（任务被记成 `failed`）。Linux 上 PID 按顺序分配、很久才回绕，所以本机和 Linux CI 从没出现过。

## 任务

0. **假 dsh 安装在 CI 上可用**：`fake-dsh-install.mjs` 复制出 `lib/bin.js` 后显式设为 0755（Windows 上跳过）；假的 `js-yaml`、`yaml` 改成 CommonJS（`module.exports`），和真 dsh 里的一致。检查 `tests/` 下其他在测试时生成、复制的脚本有没有同样依赖源文件权限位或 Node 22 才有的模块行为，有就一并改，并在汇报里列出。

1. **只结束还应该活着的进程**。新建 `tests/helpers/pids.mjs`（或放进现有 helper），统一清理时结束进程的规则：
   - 自己 spawn、手里有 `ChildProcess` 句柄的：只在句柄的 `exitCode`、`signalCode` 都为 `null` 时结束（现有 `killChild` 已经这样）。
   - 运行时 spawn 的工作进程（测试手里只有 PID）：只在该任务 `state.json` 的 `status` 为进行中（`starting`、`running`、`waiting_approval`、`waiting_question`）、`worker.pid` 就是这个 PID、且 PID 存活时才结束。任务已到“停下”或“结束”状态的，工作进程按契约会自己退出，不结束它（需要等它退出时用现有的等待函数，不要杀）。
   - 自动启动或测试启动的假 dsh Web（只有发现文件里的 PID）：只在发现文件还在、`pid` 存活时才结束；让 `tests/fixtures/fake-dsh-cli.mjs` 的 Web 模式在正常退出（收到 `SIGTERM`、`SIGINT` 或主动退出）时删掉自己写的发现文件，这样“文件在”才说明它大概率还活着。
   - `run-harness.mjs` 的 `cleanup`、`killLeftoverWorkers`，`dsh-case.mjs` 的 `cleanup`、`stopWebs`，以及 `tests/dsh-autostart.test.mjs` 里 `t.after` 的清理，都改用这些规则。用例正文里为了制造场景、对**正在运行**的工作进程 `SIGKILL`（例如 `run-attach` 里先确认在跑再杀）的不用改，但在汇报里逐个列出并说明为什么那一刻它一定还活着。
2. **没有输出的失败要能看出来**。`tests/helpers/run-harness.mjs` 的 `runCli` 返回时带上 `signal`；新加一个断言函数（例如 `assertExit(result, code)`），失败信息里有退出码、信号、stdout、stderr，两者都为空时写明“没有任何输出（进程可能被外部结束）”。`run-report.test.mjs` 的 `startTask` 和其他直接 `assert.equal(x.code, 0, x.stdout + x.stderr)` 的地方改用它（只改断言方式，不改判断条件）。

## 验收标准

- PR0：在 `/tmp` 下新建目录，用 `git ls-files -co --exclude-standard` 列出的文件复制一份仓库（含工作区改动），复制后全部 `chmod 644`，等同 CI 的检出（不要在本仓库执行任何写 `.git` 的 git 命令），在其中分别用默认设置和 `NODE_OPTIONS='--no-experimental-require-module --no-experimental-detect-module'` 各跑一次 `npm test`，全部通过。汇报两次的 `# tests`、`# pass`、`# fail`。修改前先按同样方法跑一次，汇报失败数，证明能复现。
- PR1：`tests/pids.test.mjs`（或类似名字）新增用例，用注入的 `kill` 函数记录调用：进程已退出的句柄不结束；任务状态为 `done`、`failed`、`cancelled` 等非进行中时不结束其 `worker.pid`，即使该 PID 存活（用一个无关的、活着的子进程的 PID 冒充）；进行中且 PID 存活时结束；发现文件不在时不结束。反证：副本里把规则恢复成“PID 存活就结束”，“非进行中不结束”的用例失败，汇报断言原文。
- PR2：`grep -rn "process.kill(" tests --include=*.mjs`（不含 `tests/integration/`）列出的每一处，要么是 `process.kill(pid, 0)` 存活检查，要么经过第 1 条的规则，要么是用例正文里对确认在跑的进程的结束；汇报里逐条列出归类。
- PR3：假 dsh Web 正常退出后发现文件被删除，有用例覆盖。
- PR4：回归：`npm test` 连跑 3 次全部通过，每次跑完没有 `fake-executor`、`fake-dsh-cli`、`run.mjs --worker` 进程（用 `pgrep` 时别匹配到命令自己所在的 shell）。
- Windows 上的效果这边测不了，Claude 推送后看 CI。

## 隔离和安全

同 S4 原任务书。不执行 git commit、git push、切分支；只改 `tests/` 下的文件，不改产品代码（`core/`、`bin/`、`dsh-bridge/`、`scripts/`、`skills/`）、docs/ 下的任何文件和 AGENTS.md。只停止自己 spawn 的进程（按 PID）。遇到需要越权（审批）的操作：不要申请，记为发现。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 PR 的结果和证据（命令及输出摘要），反证的断言原文；PR2 的逐条归类；你开过的所有后台任务及其结束情况；你对上面判断的看法（同意、不同意或有别的可能原因），以及没做完的项和疑问。
