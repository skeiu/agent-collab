---
name: probe-plain
description: 对照组：不声明 allowed-tools，看 Bash 命令会不会被拒
disable-model-invocation: true
---
用 Bash 工具运行这条命令，不要改写，然后原样回复输出；如果被拒绝，就回复“被拒绝”和拒绝原因：

`node "${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs" skill-plain`
