---
name: probe-allowed
description: 测试 skill 的 allowed-tools 能否放行运行插件脚本的 Bash 命令
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
用 Bash 工具依次运行下面两条命令，每条单独运行，不要改写、不要合并，然后原样回复两条命令的输出：

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs" skill-allowed-root`
2. 本 skill 目录下的 `scripts/probe.mjs`，参数为 `skill-allowed-relative`（用 node 运行，写出完整的绝对路径）
