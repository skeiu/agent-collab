本文件：`cf2429b` 推送后 CI 在 macOS、Windows 上仍失败的修复任务书原文（交给 dsh）。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿并在 dsh Web 派发，用户未逐份审阅。依据：CI 运行 40113907322（`cf2429b`）：Ubuntu 两组通过；macOS LTS 2 项、macOS Node 20 3 项、Windows LTS 8 项、Windows Node 20 9 项失败。这些失败以前被“假 dsh 装不上”挡住了，这次才露出来。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和“按 CI 的条件重跑测试”、上一份任务书 docs/context/briefs/1a-ci-fix-s4.md（隔离和安全规则照旧有效），再读 docs/dev-setup.md 的“运行测试”。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程（不在 bwrap 里、命令行是 `dsh web` 的那个）就停止。

## CI 的失败（日志摘录）

1. `tests/detect.test.mjs:48`“POSIX 符号链接：解析出入口 .js”（macOS 两组、Windows 两组）：实际值是解析过的真实路径，期望值没解析。macOS：`/private/var/folders/...` 对 `/var/folders/...`；Windows：`C:\Users\runneradmin\...` 对 `C:\Users\RUNNER~1\...`（8.3 短文件名）。
2. `tests/doctor.test.mjs:149`“本仓库有进行中的任务：active_run 为 warn 且 ok false”（四组都失败）：`ok` 实际为 true。疑似同一原因：测试按未解析的临时路径写锁，`doctor` 用 git 给出的仓库根（真实路径）找锁，对不上。先确认原因；如果 `run start` 和 `doctor` 算仓库标识用的路径不是同一个来源，那是产品缺陷，按下文“产品缺陷”处理。
3. `tests/detect.test.mjs:75`“DSH_HOME 四级优先顺序”（Windows 两组）：期望写死 `/from/config`，Windows 上实际为 `D:\from\config`。
4. `tests/doctor.test.mjs:84`“找不到 dsh”（Windows Node 20）：`Cannot read properties of null (reading 'ok')`，说明 `doctor --json` 的 stdout 不是 JSON。查清 stdout、stderr 是什么。
5. `tests/dsh-acp.test.mjs:101`“inheritEnv 为 login-shell 时使用登录 shell 的环境”（Windows 两组）：实际 `null`，期望 `'yes'`。Windows 没有登录 shell；按 PLAN.md 和 protocol.md 对 `inheritEnv` 在 Windows 上的规定处理（规定了就按规定断言；没规定就在 Windows 上跳过，并在汇报里写明需要补规定）。
6. `tests/dsh-autostart.test.mjs:103`“假 dsh Web 正常退出后发现文件被删除”（Windows 两组）：等待超时。Windows 上 `process.kill(pid, 'SIGTERM')` 直接结束进程，假 Web 的信号处理不会运行，发现文件留下。“文件在才说明还活着”这条规则在 Windows 上因此不成立，要另想办法：例如 `stopWebFromDiscovery` 结束进程并确认它退出后，由清理方删掉发现文件；用例在 Windows 上改为验证这一点。要保证 R11 的目的不变：清理不能按陈旧的发现文件去结束别人的进程。
7. `tests/run-finalize.test.mjs:52`、`:123`（Windows 两组）：`after` 钩子删临时目录时 `EBUSY ... rmdir ...\runs\repo-...\T001`。上一轮改为“任务已结束就不结束工作进程”之后，删目录时工作进程可能还没退出、还占着运行目录。清理时先等这些工作进程退出（有上限，例如 10 秒；用现有的等待函数，不要杀），删目录用 `fs.rm` 的 `maxRetries`、`retryDelay`。检查其他用例的清理有没有同样的问题，一并改。
8. `tests/dsh-adapter.test.mjs:146`“桥接断开：进行中的一轮以 failed 结束，statusReason 说明原因”（macOS 两组之一、Windows Node 20）：`statusReason` 实际 `worker_lost`，期望 `dsh_disconnected`。意思是工作进程没写终态就没了，或者 `run wait` 在工作进程写终态之前就判定它丢了。找到原因：测试的问题就改测试；产品的问题（例如工作进程在桥接断开时自己崩溃）按下文“产品缺陷”处理。这一条在本机复现不了时，写出你的分析和让它在 CI 上能看清原因的诊断（例如断言失败时带上 `worker.log`）。

## 任务

逐条修好上面 8 项。原则：

- 测试里比较路径时，两边都用 `fs.realpathSync.native`（或 `fs.promises.realpath`）解析过的真实路径；期望值用 `path.resolve` 等平台相关的写法，不写死 POSIX 路径。
- 不放宽断言的判断条件；平台上本来就不适用的用例才跳过，并在用例里写明原因（`{ skip: process.platform === 'win32' ? '原因' : false }`）。
- 只改 `tests/` 下的文件。

**产品缺陷**：如果某一项是产品代码的问题，可以改 `core/`、`bin/` 里直接相关的最少代码，但必须在汇报里单独列出：改了哪个文件哪个函数、改前改后的行为、和 docs/protocol.md 是否一致（不一致的写出 protocol.md 应改成什么，不要改 docs/）。

## 验收标准

- PC1：本机 `npm test` 连跑 3 次全部通过，每次跑完没有 `fake-executor`、`fake-dsh-cli`、`run.mjs --worker` 进程。
- PC2：按 RUNBOOK“按 CI 的条件重跑测试”的方法，在 `chmod 644` 的副本里用默认参数和 Node 20 模拟参数各跑一次 `npm test`，全部通过。
- PC3：第 1、2、3 项的修改，在本机用一个模拟“临时目录经过符号链接”的办法验证：例如把 `TMPDIR` 设成一个指向真实临时目录的符号链接再跑 `tests/detect.test.mjs`、`tests/doctor.test.mjs`。修改前这样跑失败、修改后通过，汇报两次的结果。
- PC4：每一项写明原因（测试问题还是产品问题）和改法；第 8 项写明复现情况。
- Windows、macOS 的实际效果这边测不了，Claude 推送后看 CI。

## 隔离和安全

同上一份任务书。不执行 git commit、git push、切分支；不改 docs/ 和 AGENTS.md；只停止自己 spawn 的进程（按 PID）；遇到需要越权（审批）的操作：不要申请，记为发现。用户的 dsh Web 现在装了桥接（`~/.dsh/agent-collab/bridge-web.json` 存在）：不要读写它，不要连接它；测试和集成脚本只用临时 `DSH_HOME`。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；8 项逐项的原因和改法；PC1–PC4 的结果和证据；产品缺陷（如有）；你开过的所有后台任务及其结束情况；没做完的项和疑问。
