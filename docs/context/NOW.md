# NOW

本文件：当前目标、验收标准、进展、阻塞、下一步和证据入口。修改类和接续任务时读；状态实质变化时，以及每个任务结束、被中断或交接前更新。保持约 100 行以内。

## 当前目标

第 1a 阶段第一步：技术验证，**2026-10-23 已全部完成并回填 PLAN.md**，下一步是 1a 的实现（[PLAN.md](../PLAN.md) §15“1a：核心闭环”表格、§17）。分工不变：dsh 写代码，Claude 检查验收。按依赖分三组（AI 拟定，2026-10-23）：

- **第 1 批，交给 dsh**：§17 第 2、1、3、6、7、18、12 项。已完成并回填 PLAN.md。
- **第 2 批，交给 dsh**：§17 第 4 项（审批和提问能否从会话事件里观察到），第 1 批没有标为“需要模型”的项。用户决定复用网关配置、调用真实模型（见下面“第 2 批”）。
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
   - **第 2 批的例外**（用户要求复用网关配置，2026-10-23）：可以**只读**真实 web profile 的 `cordis.patch.yml`，从中挑出 `llm-*` 和 `agent-default-model` 条目，复制进临时 `DSH_HOME`；可以在临时 `DSH_HOME` 里建符号链接 `.env`，指向真实的 `$DSH_HOME/.env`，由被测 dsh 自己读取。实验代码和执行端都不得打开、打印或复制 `.env` 的内容，也不得写真实 `DSH_HOME` 里的任何文件。
7. **审批**：本阶段 dsh 发出的越权审批，用户一律拒绝；需要越权才能做的实验，记为发现并汇报。

## 第 2 批：§17 第 4 项（AI 拟定，2026-10-23）

**要回答的问题**：审批和提问能否在插件里观察到、能否由插件应答。具体包括：
- 审批请求和结果，能否通过 `ctx.on('session/event')` 收到，事件名和字段是什么；
- “等待审批”能否从会话状态或事件里判断出来；
- 插件能否用代码批准或拒绝审批；
- `ask_user_question` 的提问能否被插件看到并回答。

**做法**：
- 被测 dsh 复用用户网关的服务商条目，见 R6 第 6 条的例外。实验会真实调用模型，可用环境变量 `AC_TEST_MODEL` 换成便宜的模型。
- 触发审批：把会话的沙箱设为 `read-only`、审批策略设为 `ask`，让模型在工作区里写一个文件。
- 触发提问：让模型调用一次 `ask_user_question`。
- 测试插件记录事件，并自动应答。

**验收标准**：
1. 实验目录 `experiments/1a/04-approval-question/`，有 `run.mjs`、README 和测试插件，一条命令跑完，最后一行输出 `RESULT:`；上面的问题逐个给出结论和关键事件摘录，汇总写进 `experiments/1a/REPORT.md` 新增的一节。
2. 符合 R6 隔离要求（含第 6 条的例外）。Claude 核对三点：实验前后用户 dsh Web 的 PID 不变；`~/.dsh` 下 profile 和配置的哈希不变；`~/.dsh/.env` 的哈希和修改时间不变。实验结束后，只删临时目录里的链接，不删链接指向的原文件。
3. 密钥不外泄：仓库文件、报告、汇报和命令输出里都不出现密钥。Claude 用两种方式核对：读实验代码，确认没有读取 `.env` 的代码；查 dsh 会话日志，确认没有执行过读取 `.env` 的命令。
4. 可复现：Claude 用同一条命令重跑，结论一致。模型行为有随机性，每项最多允许重试 2 次；报告里写明模型 id 的类别（不写网关名和地址）、轮数和大致花费。
5. 无本机信息：仓库和报告里不出现网关名称、地址、模型服务商配置，按 RUNBOOK 扫描无命中。
6. 实验文件不被 `node --test` 发现，`npm test` 仍是 3/3；执行端不提交、不推送，不改 PLAN.md、AGENTS.md 和 `docs/context/`；结束后不留进程和临时目录。

第 1a、1b 阶段的产品验收：见 PLAN.md §15“验收”表（T1–T26）。

## 进展

- 2026-10-23 建立基础文档和根目录 `CLAUDE.md`（只含导入行 `@AGENTS.md`）。【已验证】2026-10-23：文档检查见 [RUNBOOK.md](RUNBOOK.md)“文档维护”，`claude -p` 实测新会话能加载 AGENTS.md（[RISKS.md](RISKS.md) R4）。用户验收：尚未进行。
- 2026-10-23 第 0 阶段完成：dsh 实现、Claude 验收，8 条全部通过，三平台 CI 通过；已推送到 `origin/main`（[history/2026-10-23-phase0.md](history/2026-10-23-phase0.md)）。用户验收：尚未进行。
- 2026-10-23 仓库清理了本机信息；PLAN.md 随仓库公开（[DECISIONS.md](DECISIONS.md)）。
- 2026-10-23 第 1 批技术验证：dsh 实现、Claude 验收，8 条全部通过（[history/2026-10-23-1a-batch1.md](history/2026-10-23-1a-batch1.md)）；harness 补了 `XDG_RUNTIME_DIR`。
- 2026-10-23 第 1 批结论经用户审阅 diff 后回填 PLAN.md（§5.4、§5.6、§9.2、§9.4、§9.5、§10、§11.4、§11.5、§14.5、§15、§16、§17 等）；01 采用整份复制 `standard`（[DECISIONS.md](DECISIONS.md)）。
- 2026-10-23 Claude 侧验证（§17 第 8、16、17 项）完成并回填 PLAN.md（[history/2026-10-23-1a-claude-side.md](history/2026-10-23-1a-claude-side.md)）；Desktop 插件部分推迟到 T20。
- 2026-10-23 第 2 批（§17 第 4 项）由 dsh 完成（真实模型，结论见 [REPORT.md](../../experiments/1a/REPORT.md) 末节），Claude 按上面 6 条验收，**全部通过**，【已验证】2026-10-23：
  - 结论：审批事件 `approval/asked`、`approval/decided` 和提问的 `tool/call` 都能在插件里收到；等待审批不能看 `agent.status`，要从事件判断；插件也能用代码应答审批和提问。
  - 隔离：dsh 先切 `workspace-write` 再开工；沙箱自检 PID 隔离生效；用户 dsh Web 的 PID、`~/.dsh` 配置哈希、`.env` 哈希和修改时间与派任务前一致（基线后只有 `storages/workspace.json` 在用户新建会话时由用户的 dsh Web 自己更新）。
  - 密钥：dsh 会话日志里没有读取 `.env` 内容的代码或命令，工具输出和回复里没有出现“密钥变量名=值”；实验代码对 `.env` 只做 `symlink`、`lstat`、`readlink`、`unlink`。
  - 复现：Claude 用 bwrap（家目录只读）重跑一次，18 秒，结论一致；重跑后用户 dsh 和 `.env` 仍不变，无遗留进程和临时目录，日志无密钥和本机信息。
  - `npm test` 3/3；仓库本机信息扫描无命中；dsh 未提交、未改文档。
  - 结论经用户审阅 diff 后回填 PLAN.md（§9.3、§15、§17）。**1a 技术验证全部完成。**

## 阻塞与待核实

- 【待核实】`package.json` 写了 `"license": "MIT"`，但 LICENSE 文件还没建；版权人署名需用户提供（PLAN.md §7.1、§18）。
- 【待核实】PLAN.md §3 中 D1–D19 的确认人（见 [DECISIONS.md](DECISIONS.md)）。
- 【待核实】本次文档结构（MAP 并入 PROJECT_INDEX.md，RISKS 和 DECISIONS 独立）是 AI 采用的方案，待用户认可。

## 下一步

1. 进入 1a 的实现：Claude 先起草实现的分步计划、各步验收标准和第一份任务书，给用户审阅。
2. 可选：把 CI 里的 `actions/checkout`、`actions/setup-node` 升到面向 Node 24 的新版本，消除弃用警告。
3. 每次推送仍须用户授权。

## 证据入口

- 阶段计划与验收标准：PLAN.md §15；待确认点：PLAN.md §17
- 开发机实测记录：PLAN.md 附录 A
- 第 1 批实验报告：[../../experiments/1a/REPORT.md](../../experiments/1a/REPORT.md)
- 文档检查方法：[RUNBOOK.md](RUNBOOK.md)
- 归档：[history/README.md](history/README.md)
