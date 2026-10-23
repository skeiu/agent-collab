---
name: probe-narrow
description: 测试 allowed-tools 里能否用 ${CLAUDE_PLUGIN_ROOT} 写只放行一个脚本的窄规则
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs":*)
---
用 Bash 工具依次运行下面两条命令，每条单独运行，不要改写；被拒绝的就记下“被拒绝”，然后继续下一条。最后原样回复每条的输出或“被拒绝”：

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs" narrow-allowed`
2. `node "${CLAUDE_PLUGIN_ROOT}/skills/probe-allowed/scripts/probe.mjs" narrow-outside`
