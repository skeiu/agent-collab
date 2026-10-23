# NOW

本文件：当前目标、验收标准、进展、阻塞、下一步和证据入口。修改类和接续任务时读；状态实质变化时，以及每个任务结束、被中断或交接前更新。保持约 100 行以内。

## 当前目标

第 1a 阶段第一步：技术验证（[PLAN.md](../PLAN.md) §15“1a：核心闭环”表格、§17）。分工不变：dsh 写代码，Claude 检查验收。按依赖分三组（AI 拟定，2026-10-23）：

- **第 1 批，交给 dsh**：§17 第 2、1、3、6、7、18、12 项。都在隔离的被测 dsh 里做，尽量不需要模型。
- **第 2 批，交给 dsh**：§17 第 4 项（审批和提问能否从会话事件里观察到），以及第 1 批里标为“需要模型”的部分。被测 dsh 用什么模型配置由用户决定后再做。
- **Claude 侧，Claude 自己做**：§17 第 8、16、17 项（Claude Code 插件的命令前缀、`allowed-tools`、会话结束后后台进程能否存活）。

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

## 验收标准（第 1 批，AI 拟定，2026-10-23）

1. 每项一个实验目录 `experiments/1a/<两位编号>-<短名>/`（编号用 §17 的编号），包括：
   - `run.mjs`：只用 Node 内置模块，一条命令跑完，依次建临时环境、启动被测 dsh、检查、清理；
   - `README.md`：目的、对应 §17 编号、运行方法、前置条件。
2. 实验文件名不匹配 `node --test` 的默认发现规则：不叫 `*.test.*`、`test-*`、`*-test.*`、`*_test.*`，也不放在名为 `test` 的目录里。`npm test` 仍是 3/3，CI 不受影响。
3. 符合上面的 R6 隔离要求。Claude 核对两点：实验前后用户日常 dsh Web 的 PID 不变；`~/.dsh/profiles/*/package.json` 和插件目录没有变化。
4. 每项给出结论：成立 / 不成立 / 部分成立 / 需要模型（未做），附关键输出摘录。不成立的，写明 PLAN.md §15 表格里的后备方案会影响哪些章节。全部汇总在 `experiments/1a/REPORT.md`。
5. 可复现：Claude 在自己的环境里重跑每个 `run.mjs`，结论一致才标【已验证】。
6. 无本机信息：代码和报告里不出现用户名、个人路径、本地网关，端口只能出现 dsh 默认值；路径用 `$DSH_HOME`、`<dsh包目录>` 等占位。按 [RUNBOOK.md](RUNBOOK.md)“提交前检查本机信息”扫描无命中。
7. 执行端不提交、不推送，不改 PLAN.md、AGENTS.md 和 `docs/context/`。PLAN.md 的回填由 Claude 起草、用户确认后再改。
8. 清理：实验结束后，自己启动的进程都已退出，临时目录都已删除。

第 1a、1b 阶段的产品验收：见 PLAN.md §15“验收”表（T1–T26）。

## 进展

- 2026-10-23 建立基础文档和根目录 `CLAUDE.md`（只含导入行 `@AGENTS.md`）。【已验证】2026-10-23：文档检查见 [RUNBOOK.md](RUNBOOK.md)“文档维护”，`claude -p` 实测新会话能加载 AGENTS.md（[RISKS.md](RISKS.md) R4）。用户验收：尚未进行。
- 2026-10-23 第 0 阶段完成：dsh 实现、Claude 验收，8 条全部通过，三平台 CI 通过；已推送到 `origin/main`（[history/2026-10-23-phase0.md](history/2026-10-23-phase0.md)）。用户验收：尚未进行。
- 2026-10-23 仓库清理了本机信息；PLAN.md 随仓库公开（[DECISIONS.md](DECISIONS.md)）。
- 2026-10-23 第 1 批技术验证由 dsh 完成（结论见 [REPORT.md](../../experiments/1a/REPORT.md)），Claude 按上面 8 条验收，**全部通过**，【已验证】2026-10-23：
  - 结论：02、03、12 成立；01 不成立（只能整份复制 standard）；06、07、18 部分成立。对 PLAN.md 的影响见 REPORT.md 末节，待用户确认后回填。
  - 第 5 条：Claude 用与 dsh 沙箱相同的 bwrap 参数逐个重跑 7 个 `run.mjs`，RESULT 行与报告一致；并对照 dsh 源码抽查了 02（预设文件）、06（`DSH_` 前缀校验）、18（PATH 上的 pnpm）。
  - 第 3 条：dsh 会话在任务开始前切到 `workspace-write`；第 0 步实测沙箱 PID 隔离生效（PID 1 为 `bwrap --unshare-pid`）；用户 dsh Web 的 PID、`~/.dsh` 下 profile 列表和配置哈希与派任务前的基线一致。
  - 第 2、6、8 条：`npm test` 3/3；本机信息扫描无命中（`127.0.0.1:9` 是故意不可达的地址）；宿主机上无遗留进程、临时目录和锁目录。
  - 第 7 条：dsh 未提交；应用户第二轮指令改了 NOW.md 三处，属用户授权。
  - 发现：harness 没有重定向 `XDG_RUNTIME_DIR`，在只读的 `/run/user/<uid>` 下 pnpm 失败；在不加沙箱的宿主机上会往临时目录外写锁目录。已补进 R6 第 4 条；Claude 按用户要求修了 harness，在 `/run/user` 只读的 bwrap 里重跑 7 项全部通过、结论不变，【已验证】2026-10-23。
- 2026-10-23 第 1 批结论经用户审阅 diff 后回填 PLAN.md（§5.4、§5.6、§9.2、§9.4、§9.5、§10、§11.4、§11.5、§14.5、§15、§16、§17 等）；01 采用整份复制 `standard`（[DECISIONS.md](DECISIONS.md)）。

## 阻塞与待核实

- 【待核实】`package.json` 写了 `"license": "MIT"`，但 LICENSE 文件还没建；版权人署名需用户提供（PLAN.md §7.1、§18）。
- 【待核实】PLAN.md §3 中 D1–D19 的确认人（见 [DECISIONS.md](DECISIONS.md)）。
- 【待核实】本次文档结构（MAP 并入 PROJECT_INDEX.md，RISKS 和 DECISIONS 独立）是 AI 采用的方案，待用户认可。
- 【待核实】第 2 批要用的模型配置：被测 dsh 在临时 `DSH_HOME` 里没有服务商配置，跑一轮对话需要模型；不能复制用户 `~/.dsh` 里的凭据。

## 下一步

1. Claude 做 §17 第 8、16、17 项的验证。
2. 用户决定第 2 批的模型配置；第 2 批和 Claude 侧都完成并回填后，才进入 1a 实现。
3. 可选：把 CI 里的 `actions/checkout`、`actions/setup-node` 升到面向 Node 24 的新版本，消除弃用警告。
4. 每次推送仍须用户授权。

## 证据入口

- 阶段计划与验收标准：PLAN.md §15；待确认点：PLAN.md §17
- 开发机实测记录：PLAN.md 附录 A
- 第 1 批实验报告：[../../experiments/1a/REPORT.md](../../experiments/1a/REPORT.md)
- 文档检查方法：[RUNBOOK.md](RUNBOOK.md)
- 归档：[history/README.md](history/README.md)
