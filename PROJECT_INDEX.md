# PROJECT_INDEX

本文件：项目定位与“任务 → 文件或章节”路由，并暂时承载 MAP（目录与位置）。需要定位时读；入口、职责或目录映射变化时更新。只放路由，不复制专题正文。

## 项目定位

agent-collab：让多个编程代理按“设计端 / 执行端”分工协作的 Claude Code 插件，目前设计已定稿、尚未实现。详细用途见 [README.md](README.md)。

## 任务路由

| 任务 | 去哪里 |
|---|---|
| 了解项目用途、状态、文档入口 | [README.md](README.md) |
| 长期规则、项目特有约定 | [AGENTS.md](AGENTS.md) |
| 当前目标、进展、阻塞、下一步 | [docs/context/NOW.md](docs/context/NOW.md) |
| 执行操作或验收前查步骤 | [docs/context/RUNBOOK.md](docs/context/RUNBOOK.md) |
| 查决策的确认状态、被否决的替代方案 | [docs/context/DECISIONS.md](docs/context/DECISIONS.md) |
| 查项目过程风险、验证缺口 | [docs/context/RISKS.md](docs/context/RISKS.md) |
| 追溯历史记录 | [docs/context/history/README.md](docs/context/history/README.md) |
| 定位目录、版本、配置、运行时位置 | 本文件“目录与位置” |
| 产品设计的任何专题 | 下表“PLAN.md 章节路由” |

## PLAN.md 章节路由

[docs/PLAN.md](docs/PLAN.md) 约 1000 行，先 `grep -n '^#' docs/PLAN.md` 找到章节，再只读该章节。

| 任务 | PLAN.md 章节 |
|---|---|
| 产品目标、硬性要求、不做的事 | §1 目标 |
| 设计原则 | §2 设计原则 |
| 产品设计决策 D1–D23 的正文 | §3 已定的决策 |
| 支持平台、依赖、运行时探测项 | §4 适用环境和前提 |
| dsh 行为事实（headless、沙箱、规则文件、插件、模型配置） | §5 dsh 关键事实；实测记录见附录 A |
| 架构、角色、数据流 | §6 整体架构 |
| 仓库目录规划、共享运行时目录 | §7 目录结构 |
| `/collab` 协作流程、运行目录和任务状态 | §8 协作流程 |
| dsh 桥接插件（ACP 兼容） | §9 dsh 桥接插件 |
| 环境自检 `doctor` | §10 环境自检 |
| 设计端、执行端适配器、权限级别对应 | §11 角色与适配器 |
| 配置项、配置页、看板 | §12 配置和可视化 |
| 汇报格式 | §13 汇报格式 |
| 安装、同步、卸载 | §14 安装与同步 |
| 分阶段计划、验收标准 T1–T26 | §15 分阶段计划和验收标准 |
| 产品风险与应对 | §16 风险 |
| 实现前需要先确认的点 | §17 实现时需要先确认的点 |
| 参考项目与许可 | §18 参考和许可 |
| 开发约定（仓库位置、设计与实现分工、测试隔离） | 附录 B 开发约定 |

## 目录与位置（MAP，暂并入本文件）

现状（2026-10-23 第 0 阶段后核对）：

```
agent-collab/
├── AGENTS.md            AI 长期规则
├── CLAUDE.md            Claude Code 入口，只含导入行 @AGENTS.md
├── PROJECT_INDEX.md     本文件
├── README.md            项目说明
├── package.json         脚本入口（npm test、npm run build），无依赖
├── .gitignore、.gitattributes
├── .github/workflows/ci.yml   三平台 × Node 20 与 LTS 的测试
├── scripts/build.mjs    构建脚本（第 0 阶段为骨架）
├── tests/               node --test 测试
└── docs/
    ├── PLAN.md          设计方案（权威）
    ├── dev-setup.md     开发前置条件、测试和构建命令
    └── context/         NOW、RUNBOOK、DECISIONS、RISKS、history/
```

- 产品代码、构建产物、部署位置：暂无（尚未实现）。规划中的仓库结构和安装后的共享运行时目录见 PLAN.md §7，均为规划，未实现。
- 版本：暂无版本号。规划为插件、运行时、桥接共用一个版本号，另设协议版本（PLAN.md §3 D22）。
- 拆分条件：出现代码目录或配置文件后，拆为 `docs/context/MAP.md`，并更新本文件的路由。

## 文件实际位置

| 职责 | 实际位置 |
|---|---|
| MAP | 本文件“目录与位置” |
| RISKS | [docs/context/RISKS.md](docs/context/RISKS.md)（独立；产品风险在 PLAN.md §16） |
| DECISIONS | [docs/context/DECISIONS.md](docs/context/DECISIONS.md)（独立；D 编号正文在 PLAN.md §3） |
