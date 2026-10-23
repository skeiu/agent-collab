# 08 / 16 — Claude Code 插件：命令前缀、插件目录引用、hook、Monitor、allowed-tools

对应 PLAN.md §17 第 8、16 项。

## 目的

确认 Claude Code 插件的几项行为：命令和 skill 名是否带插件名前缀、短名能否调用；skill 和命令里怎么引用插件目录；SessionStart hook 是否运行、输出在哪里；Monitor 工具是否可用；skill frontmatter 的 `allowed-tools` 能否放行运行插件脚本的 Bash 命令，以及能否写成只放行一个脚本的窄规则。

## 运行方法

    PROBE_MODEL=<可用的模型名> node experiments/1a/08-claude-plugin/run.mjs [用例名...]

用例：`init`、`short-name`、`prefixed-name`、`preexec-echo`、`skill-allowed`、`skill-plain`、`skill-narrow`。不给用例名时全部运行。

## 前置条件

- PATH 上有 `claude`（实测 Claude Code 2.1.309），能访问模型；从继承了不同模型设置的环境里运行时，用 `PROBE_MODEL` 指定模型。
- 用 `claude -p --plugin-dir` 临时加载 `plugin/`，不安装插件、不改 `~/.claude` 的设置；每次调用加 `--permission-mode default --no-session-persistence --strict-mcp-config --max-budget-usd 0.5`。探针只往临时目录写标记。
- 每个用例调用一次模型，全部用例约 0.02 美元（Haiku）。

## 结论（2026-10-23，CLI `-p` 模式）

- 命令和 skill 名带插件名前缀：`agent-collab:probe-cmd`；短名 `/probe-cmd` 不可用。
- `${CLAUDE_PLUGIN_ROOT}` 在 skill 正文、命令正文和 `allowed-tools` 里都会被替换成插件的绝对路径；hook 运行时环境变量里也有它。skill 目录下的相对路径也能用。
- SessionStart hook 会运行，输出出现在 stream-json 的 `hook_response` 事件里。
- 工具清单里有 Monitor。
- 命令正文里的 `!` 预执行在 `-p` 下没有执行，原样留在文本里。
- `allowed-tools: Bash(node:*)` 在 default 权限模式下放行；不写的对照组被拒（“This command requires approval”）。窄规则 `Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs":*)` 只放行这一个脚本，同插件里的其他脚本仍被拒。
