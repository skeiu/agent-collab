# NOW

本文件：当前目标、验收标准、进展、阻塞、下一步和证据入口。修改类和接续任务时读；状态实质变化时，以及每个任务结束、被中断或交接前更新。保持约 100 行以内。

## 当前目标

第 0 阶段：仓库准备（[PLAN.md](../PLAN.md) §15）。用户 2026-10-23 要求开始实施，分工为 dsh 写代码、Claude 检查验收。之后是第 1a 阶段（先做技术验证）。

## 验收标准

第 0 阶段（AI 按 PLAN.md §15 细化，2026-10-23）：

1. 项目根是 git 仓库，默认分支 `main`；`core.fileMode=false`（开发分区没有权限位，见 [RISKS.md](RISKS.md) R2）；有 `.gitignore` 和 `.gitattributes`（文本统一 LF）。
2. 根目录 `package.json`：`"type": "module"`、`engines.node >= 20`，没有任何依赖；`npm test` 跑 `node --test`，`npm run build` 跑 `node scripts/build.mjs`；不需要 `npm install`。
3. `scripts/build.mjs` 能运行并退出 0，只用内置模块，用 `import.meta.url` 定位仓库；本阶段没有可构建的内容，逐项说明未实现的步骤。
4. `tests/` 下至少有冒烟测试（包括 build 能跑通、package.json 没有依赖），临时文件只用 `os.tmpdir()`；Linux 本机 `npm test` 通过。
5. `.github/workflows/ci.yml`：Linux、Windows、macOS 三个平台 × Node 20 和一个当前 LTS 版本，只跑测试，不 `npm install`。本地只能核对 YAML 能解析；三平台实际运行要推送到远程仓库后才能验证，在此之前标【未验证】。
6. 代码和配置里没有写死的路径、端口或机器相关的值（grep 检查）。
7. 新建 `docs/dev-setup.md`：开发前置条件和跑测试的命令；1a 的手动安装步骤到 1a 再补。
8. 执行端不提交、不推送，不改 PLAN.md 和 `docs/context/`，不碰 dsh 进程和 `~/.dsh`（RISKS.md R6）；首次提交在验收后由用户授权。

第 1a、1b 阶段：见 PLAN.md §15“验收”表（T1–T26）。

## 进展

- 2026-10-23 设计定稿（PLAN.md 头部）。尚未开始实现。
- 2026-10-23 建立基础文档：AGENTS.md、PROJECT_INDEX.md、README.md 和 `docs/context/` 下各文件，未改动 PLAN.md。
  - 验收标准：各文件职责清楚且开头有职责说明；AGENTS.md“通用规则”与模板逐节一致；无重复的权威来源；AGENTS.md 约 150 行以内、NOW.md 约 100 行以内；新增相对链接都能指到文件。
  - 结果：【已验证】2026-10-23，方法为行数统计、模板逐行比对、链接存在性检查（见 [RUNBOOK.md](RUNBOOK.md)“文档维护”）。用户验收：尚未进行。
- 2026-10-23 按用户要求新建根目录 `CLAUDE.md`，全文只有导入行 `@AGENTS.md`（按用户指令不写职责说明行）。导入路径能指到 AGENTS.md；用 `claude -p` 实测新会话能加载 AGENTS.md，【已验证】2026-10-23（[RISKS.md](RISKS.md) R4，步骤见 [RUNBOOK.md](RUNBOOK.md)）。

- 2026-10-23 第 0 阶段由 dsh 实现，Claude 按上面 8 条验收：
  - 通过（第 1–4、6、8 条）：【已验证】2026-10-23。方法：查看全部新文件；`git config --local --list`、`git check-attr`；把工作区复制到 tmpfs 临时目录新建仓库，跑 `npm test`（3/3 通过）和 `npm run build`（退出 0、不产出文件）；原仓库里 `node --test` 也是 3/3；grep 检查无写死路径或端口；从 dsh 会话日志核对执行过的全部命令，没有 commit、push、kill，也没碰 `~/.dsh`。只在 Linux、Node 22 上跑过。
  - 第 5 条部分通过：`ci.yml` 能被 PyYAML 解析，矩阵为三平台 × `[20, 'lts/*']`，不跑 `npm install`；三平台实际运行【未验证】，要等推送。
  - 第 7 条：初验不通过，`docs/dev-setup.md` 把只在 Node 22 上跑过的结果写成“在 Node.js ≥ 20 上通过”。按用户要求由 Claude 改为“Linux、Node.js 22 上通过；Node 20 及 Windows、macOS 由 CI 验证【未验证】”。复验通过，【已验证】2026-10-23：首行有职责说明，前置条件、测试和构建命令齐全，1a 小节写“暂无”，文中命令实跑 3/3 通过、build 退出 0，无 CR。
  - 偏离：dsh 会话执行任务时权限是 `danger-full-access`、审批 `never`，任务结束后才切到 `workspace-write`（会话日志 `permission/preset` 事件）。这次没有越界操作，但 R6 依赖的沙箱保护并未生效（[RISKS.md](RISKS.md) R6）。

- 2026-10-23 按用户要求抹除仓库里的本机信息（[DECISIONS.md](DECISIONS.md)“项目决策”），涉及 PLAN.md 附录 A.1、A.2 末条、附录 B 第 1 条，以及 AGENTS.md、NOW.md、RISKS.md、RUNBOOK.md、dev-setup.md。PLAN.md 由本会话按用户指令修改，只做泛化，不改设计内容。【已验证】2026-10-23：对全部待提交文件 grep 用户名、个人路径、网关、端口、分区、邮箱、会话 ID，除 PLAN.md §4.3 泛泛列举的“nvm”外无命中。
- 2026-10-23 PLAN.md 曾按用户要求移出仓库、改用本地独立仓库管理；同日用户改为随仓库公开，已加回主仓库并删除本地独立仓库（[DECISIONS.md](DECISIONS.md)“已被替代的决策”）。公开前复查 PLAN.md：只有产品通用路径、公开项目链接和回环地址，无本机信息。

## 阻塞与待核实

- 【待核实】`package.json` 写了 `"license": "MIT"`，但 LICENSE 文件还没建；版权人署名需用户提供（PLAN.md §7.1、§18）。
- 【待核实】PLAN.md §3 中 D1–D19 的确认人（见 [DECISIONS.md](DECISIONS.md)）。
- 【待核实】本次文档结构（MAP 并入 PROJECT_INDEX.md，RISKS 和 DECISIONS 独立）是 AI 采用的方案，待用户认可。

## 下一步

1. 第 0 阶段除第 5 条（三平台 CI，待推送）外全部通过；用户验收：尚未进行。
2. 远程仓库：用户 2026-10-23 新建 `https://github.com/skeiu/agent-collab.git`。【已验证】2026-10-23：匿名 `git ls-remote` 成功、没有任何引用，即公开的空仓库。推送用的认证还没配置。
3. 首次提交已完成：`442c9c7`，18 个文件，作者署名按用户指定，用户授权于 2026-10-23；尚未推送。推送认证已配置（SSH 密钥，2026-10-23 `ssh -T` 认出账号），已添加远程 `origin`（SSH 地址），`git ls-remote origin` 连通且远程为空。推送须用户再次授权；推送后查看三平台 CI 结果，完成标准第 5 条。
4. 第 1a 阶段先做技术验证，结论回填 PLAN.md（§15“进入 1b 的条件”）；开工前把 R6 的隔离要求写进任务书；dsh 会话要在发任务书**之前**切到 `workspace-write`，并先确认沙箱是否真的隔离了宿主进程。

## 证据入口

- 阶段计划与验收标准：PLAN.md §15
- 开发机实测记录：PLAN.md 附录 A
- 文档检查方法：[RUNBOOK.md](RUNBOOK.md)
