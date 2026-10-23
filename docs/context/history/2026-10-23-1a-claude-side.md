# 2026-10-23 第 1a 阶段技术验证：Claude 侧

本文件：PLAN.md §17 第 8、16、17 项（Claude 自己做的部分）的做法、验收标准和验收记录归档。追溯这部分怎么验的时候读；归档后不再更新。结论见 [experiments/1a/REPORT.md](../../../experiments/1a/REPORT.md) 末节，已回填 PLAN.md。

## 结果摘要

CLI 部分和 Desktop 关会话后的存活都已验证；Desktop 里插件相关的几项经用户同意推迟到 T20，Windows 留到第 2 阶段。提交 `9518a66`，2026-10-23 经用户授权推送，CI 运行 39949503364 通过。

## 做法与验收标准（AI 拟定，2026-10-23）

### 做法

- 测试插件放在 `experiments/1a/08-claude-plugin/` 等目录，用 `claude -p --plugin-dir <目录>` 临时加载，不安装插件、不改 `~/.claude` 的设置。每次调用都加 `--permission-mode default --no-session-persistence --strict-mcp-config --max-budget-usd 0.5`；hook 和脚本只写临时目录。
- 第 8 项：从 `stream-json` 的 init 消息读出加载到的命令、skill 名和工具清单，看有没有插件名前缀、有没有 Monitor；分别实测 `/collab` 短名和带前缀的命令能否调用；skill 里用 `${CLAUDE_PLUGIN_ROOT}` 和相对路径各引用一个脚本，看哪种能跑；SessionStart hook 是否运行（写标记文件）、输出出现在哪里。
- 第 16 项：skill frontmatter 的 `allowed-tools` 放行运行插件脚本的 Bash 命令，在 `default` 权限模式的 `-p` 下调用（没人批准，未放行的工具直接被拒），看能否执行；对照组不写 `allowed-tools`。
- 第 17 项：让 `claude -p` 通过 Bash 启动一个脱离父进程的工作进程（`detached` + `unref`，每秒写一次心跳，持续 60 秒），`claude -p` 退出后检查心跳是否还在继续；对照组用普通的 `&` 后台运行。
- 需要用户在 Desktop 里操作的部分：Code 标签页里 hook 是否运行、输出在哪；`/plugin` 怎么操作；Monitor 能不能用；关掉会话后工作进程是否存活。Claude 给出步骤、核对结果。Windows 上怎么脱离父进程，本机测不了，标【未验证】。

### 验收标准

1. 每项一个目录，有一条命令可重跑的脚本和 README，结论附关键输出摘录；汇总写进 `experiments/1a/REPORT.md` 新增的一节。
2. 不改 `~/.claude` 的设置、插件安装和权限；所有写入都在临时目录；结束后不留进程。
3. 模型调用控制在 10 次左右，每次有花费上限，总花费写进报告。
4. 无本机信息（按 [RUNBOOK.md](../RUNBOOK.md)“提交前检查本机信息”扫描）。
5. Desktop 部分写明由用户操作及日期；做不了的标【未验证】并说明原因。
6. PLAN.md 回填先给用户审阅 diff，确认后再改。

## 验收记录

- 2026-10-23 Claude 侧验证（§17 第 8、16、17 项）CLI 部分完成，结论见 [REPORT.md](../../../experiments/1a/REPORT.md) 末节，【已验证】2026-10-23：
  - 命令带 `agent-collab:` 前缀，短名不可用；`${CLAUDE_PLUGIN_ROOT}` 在 skill、命令和 `allowed-tools` 里都会替换；`-p` 下 SessionStart hook 运行、有 Monitor。
  - `allowed-tools` 窄规则只放行一个脚本；detached 工作进程在 `claude -p` 退出后存活，`run_in_background` 会让 `-p` 等它结束。
  - 调用模型 11 次，约 0.035 美元；无遗留进程和临时目录。
  - Desktop：用户新开 Code 会话启动 detached 工作进程后删除会话，进程继续运行、父进程变为 `systemd --user`，【已验证】2026-10-23。
  - 结论经用户审阅 diff 后回填 PLAN.md（D20、§8、§15、§17）。Desktop 里插件的 hook、`/plugin` 操作和短名，用户同意推迟到 1b 的 T20；Windows 留到第 2 阶段。
