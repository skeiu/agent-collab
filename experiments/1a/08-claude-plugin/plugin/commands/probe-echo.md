---
description: 对照：不用 ${CLAUDE_PLUGIN_ROOT} 的预执行，并回显正文里的插件根目录变量
allowed-tools: Bash(echo:*)
---
预执行结果：!`echo PREEXEC_OK`
正文变量：${CLAUDE_PLUGIN_ROOT}

原样回复上面两行（“预执行结果”和“正文变量”），不要做别的。
