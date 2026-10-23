# NOW

本文件：当前目标、验收标准、进展、阻塞、下一步和证据入口。修改类和接续任务时读；状态实质变化时，以及每个任务结束、被中断或交接前更新。保持约 100 行以内。

## 当前目标

第 1a 阶段第一步：技术验证（[PLAN.md](../PLAN.md) §15“1a：核心闭环”表格、§17）。分工不变：dsh 写代码，Claude 检查验收。按依赖分三组（AI 拟定，2026-10-23）：

- **第 1 批，交给 dsh**：§17 第 2、1、3、6、7、18、12 项。已完成并回填 PLAN.md。
- **第 2 批，交给 dsh**：§17 第 4 项（审批和提问能否从会话事件里观察到），以及第 1 批里标为“需要模型”的部分。被测 dsh 用什么模型配置由用户决定后再做。
- **Claude 侧，Claude 自己做**：§17 第 8、16、17 项。已完成并回填 PLAN.md（Desktop 插件部分推迟到 T20）。

全部结论经用户确认后回填 PLAN.md，才能进入 1a 的实现（§15“进入 1b 的条件”同理）。

## R6 隔离要求（第 1a 阶段起，所有 dsh 任务都适用）

依据 [RISKS.md](RISKS.md) R6：写代码的 dsh 会话跑在用户日常的 dsh Web 里，被测的 dsh 必须与它隔离。

1. **派任务前**：用户在 dsh Web 里把这个会话的权限切到 `workspace-write`，确认显示的是 `workspace-write` 后再贴任务书。
2. **第一步自检**：任务书第一步运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报。看到用户日常的 dsh Web 进程，说明沙箱没有隔离进程，**停下来汇报**，由用户决定是否继续。
3. **被测 dsh 一律用临时环境**：`DSH_HOME` 设为 `os.tmpdir()` 下新建的目录，`dsh web` 加 `--port 0 --no-open`，从输出里解析实际端口。脚本运行任何 `dsh` 命令前都要断言 `DSH_HOME` 位于临时目录下，否则退出。
4. **缓存重定向到临时目录**：`COREPACK_HOME`、`npm_config_cache`、`PNPM_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`、`XDG_RUNTIME_DIR`（pnpm 12 把 store 操作锁建在这里，2026-10-23 验收时发现）。
5. **只停自己启动的进程**：按自己 spawn 得到的 PID 停止，禁止 `kill`/`pkill`/`killall`/`fuser` 按名字或端口找进程。
6. **不碰用户的 dsh**：不读写 `~/.dsh`（包括其中的凭据、`.env`、会话），不访问 dsh 的默认端口，不对默认 `DSH_HOME` 运行任何 `dsh` 命令。
7. **审批**：本阶段 dsh 发出的越权审批，用户一律拒绝；需要越权才能做的实验，记为发现并汇报。

## Claude 侧验证：§17 第 8、16、17 项（AI 拟定，2026-10-23）

**做法**

- 测试插件放在 `experiments/1a/08-claude-plugin/` 等目录，用 `claude -p --plugin-dir <目录>` 临时加载，不安装插件、不改 `~/.claude` 的设置。每次调用都加 `--permission-mode default --no-session-persistence --strict-mcp-config --max-budget-usd 0.5`；hook 和脚本只写临时目录。
- 第 8 项：从 `stream-json` 的 init 消息读出加载到的命令、skill 名和工具清单，看有没有插件名前缀、有没有 Monitor；分别实测 `/collab` 短名和带前缀的命令能否调用；skill 里用 `${CLAUDE_PLUGIN_ROOT}` 和相对路径各引用一个脚本，看哪种能跑；SessionStart hook 是否运行（写标记文件）、输出出现在哪里。
- 第 16 项：skill frontmatter 的 `allowed-tools` 放行运行插件脚本的 Bash 命令，在 `default` 权限模式的 `-p` 下调用（没人批准，未放行的工具直接被拒），看能否执行；对照组不写 `allowed-tools`。
- 第 17 项：让 `claude -p` 通过 Bash 启动一个脱离父进程的工作进程（`detached` + `unref`，每秒写一次心跳，持续 60 秒），`claude -p` 退出后检查心跳是否还在继续；对照组用普通的 `&` 后台运行。
- 需要用户在 Desktop 里操作的部分：Code 标签页里 hook 是否运行、输出在哪；`/plugin` 怎么操作；Monitor 能不能用；关掉会话后工作进程是否存活。Claude 给出步骤、核对结果。Windows 上怎么脱离父进程，本机测不了，标【未验证】。

**验收标准**

1. 每项一个目录，有一条命令可重跑的脚本和 README，结论附关键输出摘录；汇总写进 `experiments/1a/REPORT.md` 新增的一节。
2. 不改 `~/.claude` 的设置、插件安装和权限；所有写入都在临时目录；结束后不留进程。
3. 模型调用控制在 10 次左右，每次有花费上限，总花费写进报告。
4. 无本机信息（按 [RUNBOOK.md](RUNBOOK.md)“提交前检查本机信息”扫描）。
5. Desktop 部分写明由用户操作及日期；做不了的标【未验证】并说明原因。
6. PLAN.md 回填先给用户审阅 diff，确认后再改。

第 1a、1b 阶段的产品验收：见 PLAN.md §15“验收”表（T1–T26）。

## 进展

- 2026-10-23 建立基础文档和根目录 `CLAUDE.md`（只含导入行 `@AGENTS.md`）。【已验证】2026-10-23：文档检查见 [RUNBOOK.md](RUNBOOK.md)“文档维护”，`claude -p` 实测新会话能加载 AGENTS.md（[RISKS.md](RISKS.md) R4）。用户验收：尚未进行。
- 2026-10-23 第 0 阶段完成：dsh 实现、Claude 验收，8 条全部通过，三平台 CI 通过；已推送到 `origin/main`（[history/2026-10-23-phase0.md](history/2026-10-23-phase0.md)）。用户验收：尚未进行。
- 2026-10-23 仓库清理了本机信息；PLAN.md 随仓库公开（[DECISIONS.md](DECISIONS.md)）。
- 2026-10-23 第 1 批技术验证：dsh 实现、Claude 验收，8 条全部通过（[history/2026-10-23-1a-batch1.md](history/2026-10-23-1a-batch1.md)）；harness 补了 `XDG_RUNTIME_DIR`。
- 2026-10-23 第 1 批结论经用户审阅 diff 后回填 PLAN.md（§5.4、§5.6、§9.2、§9.4、§9.5、§10、§11.4、§11.5、§14.5、§15、§16、§17 等）；01 采用整份复制 `standard`（[DECISIONS.md](DECISIONS.md)）。
- 2026-10-23 Claude 侧验证（§17 第 8、16、17 项）CLI 部分完成，结论见 [REPORT.md](../../experiments/1a/REPORT.md) 末节，【已验证】2026-10-23：
  - 命令带 `agent-collab:` 前缀，短名不可用；`${CLAUDE_PLUGIN_ROOT}` 在 skill、命令和 `allowed-tools` 里都会替换；`-p` 下 SessionStart hook 运行、有 Monitor。
  - `allowed-tools` 窄规则只放行一个脚本；detached 工作进程在 `claude -p` 退出后存活，`run_in_background` 会让 `-p` 等它结束。
  - 调用模型 11 次，约 0.035 美元；无遗留进程和临时目录。
  - Desktop：用户新开 Code 会话启动 detached 工作进程后删除会话，进程继续运行、父进程变为 `systemd --user`，【已验证】2026-10-23。
  - 结论经用户审阅 diff 后回填 PLAN.md（D20、§8、§15、§17）。Desktop 里插件的 hook、`/plugin` 操作和短名，用户同意推迟到 1b 的 T20；Windows 留到第 2 阶段。

## 阻塞与待核实

- 【待核实】`package.json` 写了 `"license": "MIT"`，但 LICENSE 文件还没建；版权人署名需用户提供（PLAN.md §7.1、§18）。
- 【待核实】PLAN.md §3 中 D1–D19 的确认人（见 [DECISIONS.md](DECISIONS.md)）。
- 【待核实】本次文档结构（MAP 并入 PROJECT_INDEX.md，RISKS 和 DECISIONS 独立）是 AI 采用的方案，待用户认可。
- 【待核实】第 2 批要用的模型配置：被测 dsh 在临时 `DSH_HOME` 里没有服务商配置，跑一轮对话需要模型；不能复制用户 `~/.dsh` 里的凭据。

## 下一步

1. 用户决定第 2 批（§17 第 4 项）的模型配置；第 2 批完成并回填后，技术验证结束，才进入 1a 实现。
2. 可选：把 CI 里的 `actions/checkout`、`actions/setup-node` 升到面向 Node 24 的新版本，消除弃用警告。
3. 每次推送仍须用户授权。

## 证据入口

- 阶段计划与验收标准：PLAN.md §15；待确认点：PLAN.md §17
- 开发机实测记录：PLAN.md 附录 A
- 第 1 批实验报告：[../../experiments/1a/REPORT.md](../../experiments/1a/REPORT.md)
- 文档检查方法：[RUNBOOK.md](RUNBOOK.md)
- 归档：[history/README.md](history/README.md)
