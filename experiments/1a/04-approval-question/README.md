本文件：实验 04（§17 第 4 项）的说明。运行该实验或核对审批/提问的可观察性时读。

# 04 — 审批与提问的可观察性和应答

## 要回答的问题

1. 审批请求和结果能否通过 `ctx.on('session/event')` 收到；事件名和关键字段是什么。
2. “等待审批”能否从会话状态（如 `agent.status`）或事件里判断出来。
3. 插件能否用代码批准或拒绝审批；用的是哪个服务、哪个方法。
4. `ask_user_question` 的提问在插件里能否看到（工具调用事件，以及提问服务里的待答问题），插件能否用代码回答，回答后模型能否收到答案。

## 做法

- `run.mjs` 在临时 `DSH_HOME` 里初始化 `web` profile，从环境变量 `AC_REAL_DSH_HOME` 指定的真实 `DSH_HOME` 中**只读**读取 `profiles/<AC_REAL_DSH_PROFILE 或 web>/cordis.patch.yml`，挑出 `llm-*` 和 `agent-default-model` 两类顶层条目写进临时 profile；再建一个指向真实 `DSH_HOME/.env` 的符号链接，由被测 dsh 自己读密钥。
- 测试插件建三个会话，均挂 `standard` 预设，沙箱 `read-only`、审批策略 `ask`：
  - 批准：模型调用 `write` 并带 `sandbox_permissions: workspace-write`，插件以 `allowed-once` 批准；
  - 拒绝：同样的写文件请求，插件返回 `rejected`；
  - 提问：模型调用一次 `ask_user_question`，插件在 `user-questions/request` 里回答固定答案，再让模型复述。
- 每个会话只发一条用户消息，`whenIdle` 最多等 180 秒，超时后 `cancel({ kind: 'user' })`；单次运行固定为 3 个会话，避免对话轮数无限增长。
- 插件把 `session/event` 中的审批事件、工具调用/结果、状态采样和提问投影写入 `<临时 DSH_HOME>/exp-04.json`；`run.mjs` 读取后判断结论。

## 运行

```sh
AC_REAL_DSH_HOME="$HOME/.dsh" node experiments/1a/04-approval-question/run.mjs
```

可选环境变量：

- `AC_REAL_DSH_PROFILE`：真实 profile 名，默认 `web`；
- `AC_TEST_MODEL`：覆盖 `agent-default-model` 的模型名，用于换成便宜的模型。

最后一行输出 `RESULT: 成立|不成立|部分成立` 加一句结论。

## 隔离与安全

- 被测 dsh 的 `DSH_HOME` 是 `os.tmpdir()` 下的新建目录，`dsh web --port 0 --no-open`，从输出解析实际端口。
- 只读真实 profile 的 `cordis.patch.yml`；`.env` 只建符号链接，代码不打开、不读取、不打印其内容；清理时先删除链接本身，再删除临时目录。
- 只按自己 spawn 的 PID 停止被测 dsh；不访问 dsh 默认端口。
- 报告和输出不写网关名称、地址、服务商配置或模型 id，只写模型类别。

## 文件

- `run.mjs`：一条命令跑完，`try/finally` 清理，最后输出 `RESULT:`。
- `plugin/`：测试插件，记录事件并自动应答审批和提问。
