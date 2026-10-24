# RISKS

本文件：有证据的项目过程风险、长期验证缺口和保护措施，包括用户知情后仍选择承担的风险。任务涉及对应风险时读；证据或状态变化时更新。

## 权威位置

- 产品设计层面的风险及应对：[PLAN.md](../PLAN.md) §16，本文件不重复。
- 本文件只记录项目开发过程中的风险和验证缺口。

## 风险与验证缺口

| # | 风险 | 证据 | 影响 | 保护措施 | 状态 |
|---|---|---|---|---|---|
| R1 | 本地未推送的提交只在本机 | 2026-10-23 起各阶段成果均在验收后推送到 GitHub，最新为 `0da68a2` | 未推送部分在本机磁盘出问题时丢失 | 阶段性成果验收后及时提交并推送（每次须用户授权） | 已处理：已有远程副本 |
| R7 | 公开仓库里混入本机信息 | 2026-10-23 首次提交前已清理一轮（见 [DECISIONS.md](DECISIONS.md)） | 用户名、个人路径、本地网关、分区等泄露 | 每次提交前对暂存区做一遍 [RUNBOOK.md](RUNBOOK.md)“提交前检查本机信息” | 持续存在 |
| R2 | 开发仓库所在的文件系统没有真正的权限位 | PLAN.md 附录 A.1；`df -T` 核对（2026-10-23） | 在仓库目录下测试文件权限相关行为（PLAN.md §7.2 要求令牌、配置、运行记录只让本人读写）结果不可信 | 涉及权限的测试放在支持权限位的目录；PLAN.md §15 已要求验收在临时目录新建仓库 | 【待核实】实现时确认测试所用临时目录的文件系统 |
| R3 | AGENTS.md 的规则只是上下文，项目内没有工具权限或钩子强制禁止提交、推送、删除、读取密钥 | 项目目录内没有 `.claude/` 等配置（2026-10-23 目录检查） | AI 可能违反规则执行不可逆操作 | 由用户决定是否配置权限或钩子（AGENTS.md 通用规则（五）4） | 待用户决定 |
| R4 | Claude Code 会话需经 `CLAUDE.md` 才能加载 AGENTS.md | 2026-10-23 在项目根目录用 `claude -p`（Claude Code 2.1.309）实测：禁用 Read、Grep、Glob、Bash 后提问，回答逐字引出 AGENTS.md“（二）读取”第 1 条，全程无工具调用（步骤见 [RUNBOOK.md](RUNBOOK.md)） | 若导入失效，Claude Code 会话看不到本项目规则 | 根目录 `CLAUDE.md` 只含导入行 `@AGENTS.md`（AGENTS.md 通用规则（五）3）；改动 CLAUDE.md 或升级 Claude Code 后按 RUNBOOK.md 复查 | 【已验证】2026-10-23：加载生效；只测了 CLI 非交互模式，Desktop 的 Code 标签页未单独实测 |
| R5 | 设计会话与实现会话分开进行，可能同时修改 PLAN.md 或 `docs/context/` | PLAN.md 附录 B | 互相覆盖修改 | 写入前重读目标部分，只改与本任务相关的条目（AGENTS.md 通用规则（三）2、4） | 持续存在 |
| R6 | 写代码用的 dsh 会话跑在用户日常的 dsh Web 里（默认 `~/.dsh`、默认端口 3080），而被开发的产品要安装桥接插件、重启或自动启动 dsh Web；测试或命令若作用于这个实例，会打断甚至杀掉正在写代码的会话 | 2026-10-23 核对：进程 `dsh web` 监听 127.0.0.1:3080，环境里没有 `DSH_HOME`；`dsh-sandbox-local` 源码中 bwrap 参数含 `--unshare-pid`、只读挂载 `/`，未隔离网络；`dsh web --help` 支持 `--port 0` | 第 0 阶段不涉及 dsh，风险低。第 1a 阶段（装桥接、重启 Web、T7 自动启动、T8 退回）风险高。沙箱内看不到宿主进程、家目录只读，但 `danger-full-access` 或批准后的越权命令没有这层保护；网络不隔离，能访问 3080 | 按 [RUNBOOK.md](RUNBOOK.md)“派发 dsh 任务”执行：先切 `workspace-write`；被测 dsh 用临时 `DSH_HOME`、`--port 0`，缓存和 `XDG_RUNTIME_DIR` 重定向；只按 PID 停进程；不碰 `~/.dsh`（真实模型的例外只允许只读挑服务商条目、链接 `.env`）；Claude 验收时对比基线 | 【已验证】2026-10-23 第 1a 第 1 批：会话切到 `workspace-write` 后，沙箱 PID 1 为 `bwrap --unshare-pid`，看不到宿主 dsh Web；实验前后用户 dsh Web 的 PID 和 `~/.dsh` 配置不变。【已验证】dsh Web 新建会话的默认权限是 `danger-full-access`、审批 `never`（三次会话日志 seq 0），所以每次派任务前都要先切换。第 2 批（真实模型）前后 `~/.dsh` 和 `.env` 均未变 |
| R8 | 桥接补发历史事件用的 `session.eventAt` 被 dsh 标为“新的生产代码禁止调用”，以后的 dsh 版本可能移除或改变它 | dsh 0.2.1-rc.2 的 dsh-session README“Read the log”一节（S2 汇报，Claude 2026-10-23 核对） | 断线重连后 `session/resume` 的补发失效，运行时重新接上任务时缺事件 | 调用只在 `dsh-bridge/lib/dsh-api.js`（S2 返工后有自动检查）；dsh 升级时先跑桥接集成测试（PLAN.md §9.4）；dsh 给出替代的读日志接口后改用它 | 持续存在 |
| R9 | `run start`、`run resume` 启动工作进程后再整份写一次 `state.json`，可能覆盖工作进程刚写的内容（如 `status`、`executor.sessionId`） | S3 验收审读 `core/run.mjs`（Claude 2026-10-24） | 读 `state.json` 的命令短暂看到旧状态；工作进程下一次写入即恢复，只有工作进程恰在这段时间内死掉才会丢失 | 1a 不改（Claude 判断风险低，未经用户决定）；之后可改为 `run start` 不再写 `state.json`，由工作进程自己记 pid | 持续存在 |
| R10 | `watch` 每次轮询（默认 100 ms）都重读整个 `events.jsonl` | S3 验收审读 `core/watch.mjs`（Claude 2026-10-24） | 长任务的事件文件到几 MB 后，`watch` 持续占用 CPU 和磁盘读取 | 1a 不改；之后改为记住读到的位置，只读新增部分 | 持续存在 |
| R11 | Windows CI 上有三次没有输出的偶发失败：`1f346cb` 的 Windows Node 20 上，`run resume` 用例第一轮记成了 `failed`；`b14504a` 的 Windows LTS 上，`run-stall.test.mjs` 整个文件 0.45 秒就失败，一个用例都没跑；`52f3795` 的 Windows Node 20 上，`run-report.test.mjs` 里 `run wait` 退出码 1、stdout 和 stderr 都为空。Claude 2026-10-25 的判断（把握：中）：测试清理对登记过的 PID 一律结束，不管进程是否早已退出，Windows 复用 PID 很快，会结束并行运行的别的测试进程 | CI 运行 40087121759、40089287530、40089909906（Claude 读日志）；`tests/helpers/run-harness.mjs`、`dsh-case.mjs` 的清理代码 | CI 偶尔变红 | 修复任务书 [briefs/1a-ci-fix-s4.md](briefs/1a-ci-fix-s4.md)：清理只结束还应该活着的进程，没有输出的失败在断言里写明；2026-10-25 已实现并验收（测试侧），是否消除要看之后几次 Windows CI。产品里的同类风险记在 PLAN.md §16 | 已修复，待观察 |
| R12 | PLAN.md §11.8、§12.2 和 protocol.md 没规定 Windows 上 `inheritEnv: login-shell` 怎么办：Windows 没有登录 shell，现在的实现静默退回设计端环境 | 第二轮 CI 修复（dsh 汇报，Claude 2026-10-25 核对） | Windows 用户设了这一项却不生效，也没有提示 | 待设计会话决定：退回并报 warning，还是在 Windows 上不允许；定了以后把 `tests/dsh-acp.test.mjs` 里 Windows 的跳过改成按规定断言 | 待定 |
| R13 | dsh 适配器和工作进程的几处收尾问题：主动关闭旧连接时 worker.log 记一条“dsh 连接断开”；工作进程没有 `unhandledRejection`/`uncaughtException` 兜底，再出现类似问题时只能被记成 `worker_lost`；acp 模式 `resume` 失败时没关新建的子进程 | 第三轮修复的 dsh 汇报和 Claude 在 S6 重跑 T9 时看到的 worker.log（2026-10-25） | 排查时误以为断线；个别异常路径下任务原因记不准、子进程残留 | 第四份修复（[briefs/1a-fix4-env-resume.md](briefs/1a-fix4-env-resume.md)）2026-10-25 已改好其中两处：主动关闭不再记断线，acp `resume` 失败时关子进程。剩下的兜底要先改 protocol.md §5.5（已由用户确认过的部分），待用户审阅：按 `failed` 收尾并写 worker.log | 部分修复，兜底待用户决定 |
| R14 | 桥接为每个会话在 `$DSH_HOME/agent-collab/session-env/` 下留一个小文件（protocol.md §1.1），只在 `session/close` 时删除；运行时正常结束任务时不发 `session/close`，文件会一直积累 | 第四份修复的 dsh 汇报，Claude 2026-10-25 读代码核对 | 长期使用后目录里文件越来越多（每个几十字节，不含密钥） | 待设计会话决定清理办法：例如任务结束（终态写完）时由运行时发 `session/close`（但人可能还要在 Web 里续这个会话），或桥接按 dsh 会话是否还存在、按时间清理 | 待定 |
