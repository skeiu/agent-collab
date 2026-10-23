本文件：第 1a 阶段 S2（dsh 桥接）验收后交给 dsh 的返工任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-23，用户同日派发；RW1–RW5 同日验收通过。依据：S2 验收（[1a-impl-plan.md](../1a-impl-plan.md)“进展”）。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”和 S2 原任务书 docs/context/briefs/1a-s2-bridge.md（隔离和安全规则照旧有效）。docs/protocol.md 只读第 2 节。

## 第 0 步：沙箱自检（必须先做）

同 S2 原任务书第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 背景

S2 的 AC1–AC5、AC7 经 Claude 重跑通过：`npm test` 77/77，`npm run build` 默认输出和 `--out` 都对，两个集成脚本在外层 bwrap 下都是 `RESULT: 通过`。审读代码后有下面四处要改。

## 任务

1. **截断的耗时随长度平方增长**（`dsh-bridge/lib/acp-server.js` 的 `truncateText`）。现在每次去掉一个字符就把整个前缀重新算一遍字节数。Claude 用原函数实测：32 KiB 46 ms，64 KiB 196 ms，128 KiB 777 ms，按这个趋势 1 MiB 约 50 秒。桥接跑在 dsh Web 进程里，工具输出大一点（`cat` 一个大文件、跑一次测试），dsh Web 就要卡住几十秒甚至几分钟。
   - 改成和长度成线性的做法（例如按字节截取 `Buffer`，再退回到完整的 UTF-8 字符边界）。截断后不超过 8 KiB，不能切坏多字节字符，结果里不能出现 U+FFFD。
   - 单元测试加：4 MiB 的 ASCII 字符串和 4 MiB 左右的中文字符串，各截断一次，断言字节数不超过 8192、没有 U+FFFD、各自在 200 ms 内完成。
2. **dsh 的会话对象也要经 dsh-api 访问**（原任务书第 2 步“`index.js`、`acp-server.js` 只调用它导出的函数，不直接碰 ctx 和 dsh 的服务对象”，AC6）。现在 `acp-server.js` 直接调用 dsh 的 agent 和 session 对象：`agent.followup`、`agent.cancel`、`agent.whenIdle`、`agent.status`、`session.seq`、`session.eventAt`、`session.header`、`session.requestHeader()`。其中 `eventAt` 已被 dsh 的 dsh-session README 标为新代码禁止使用，dsh 改掉它时，要改的就不止 `dsh-api.js` 一个文件。
   - 把这些操作移进 `dsh-api.js`，由它导出函数（或返回一个只含桥接所需方法的包装对象）；`acp-server.js` 不再读写 dsh agent、session 对象上的任何属性和方法。
   - 扩充 `tests/bridge.test.mjs` 里的自动检查：除了 `ctx`，还要能查出 `acp-server.js`、`index.js` 里对上面这些成员的直接使用（检查办法你定，在汇报里说明能查出哪些写法）。
3. **集成测试不从 `experiments/` 导入**（原任务书开头“不要从 experiments/ 导入，需要的部分复制过来”）。`tests/integration/bridge-dsh.mjs` 现在从 `experiments/1a/_shared/harness.mjs` 导入了 `createSandbox`、`startWeb` 等函数。把用到的部分复制到 `tests/` 下（放在 `tests/integration/` 里的一个辅助模块即可，开头写一行职责说明），隔离用的环境变量（`COREPACK_HOME`、`npm_config_cache`、`PNPM_HOME`、`XDG_*` 等）保持不变。`acp-client-dsh.mjs` 不用改。
4. **同一进程里重连后，补发的 `turn_end` 丢了 `stoppedBy`**。protocol.md §2.7 只允许“桥接重启后”补发的 `stoppedBy` 为 `null`。现在最后一个连接断开、又没有进行中的 prompt 时，桥接会丢掉这个会话的状态；客户端再 `session/resume` 时重新扫描日志，历史上的 `turn_end` 一律成了 `null`，哪怕桥接进程一直没停。另外，这段时间里没有客户端连着，人在 Web 里点停止也不会被记下来。
   - 改为：桥接进程活着期间，它 `session/new` 或 `session/resume` 过的会话，即使当前没有连接，也继续跟踪事件，补发和实时通知里的 `stoppedBy` 相同（`client`、`human`、`null` 的判定不变）。只有 `session/close` 关掉的会话可以丢掉状态。
   - 单元测试加：(a) 连接 A 新建会话、prompt、`session/cancel`，得到 `stoppedBy: "client"`；A 断开后连接 B 带 `sinceSeq` 恢复，补发的 `turn_end` 也是 `client`。(b) 没有连接时假 dsh 产生一轮以“被取消”结束的事件，之后重连补发，`stoppedBy` 为 `human`。

## 验收标准

- RW1：截断用例按第 1 条通过；原有截断用例（工具输入输出截断、回复文字不截断）仍然通过。
- RW2：`acp-server.js`、`index.js` 里不出现对 dsh agent、session 对象成员的直接使用；扩充后的自动检查通过。Claude 会故意在 `acp-server.js` 里加一行 `state.agent.followup(x)` 试一下检查能不能查出来（不提交）。
- RW3：`grep -rn "experiments/" tests/` 没有输出；`bridge-dsh.mjs` 在外层 bwrap 下最后一行仍是 `RESULT: 通过`。
- RW4：第 4 条两个用例通过。
- RW5：回归：`npm test` 全部通过；`npm run build` 退出码 0；`tests/integration/acp-client-dsh.mjs` 仍然通过；`lib/jsonrpc.js` 仍与 `core/jsonrpc.mjs` 相同；仓库没有依赖，新文件开头有职责说明。

## 不用改

下面几项是 S2 汇报里列出的和 PLAN.md、protocol.md 的出入，按现在的实现保留，由 Claude 回填文档：`read-only` 权限预设、`assistant/message` 代替 `assistant/chunk`、只转发 `source.kind` 为 `user` 的 `user/message`、用量字段、`endReason` 的取值、`stoppedBy` 由桥接根据连接状态判定。

## 隔离和安全

同 S2 原任务书“隔离和安全”，违反任何一条都算不通过。不执行 git commit、git push；不修改 docs/PLAN.md、docs/protocol.md、AGENTS.md 和 docs/context/ 下的任何文件。

## 汇报

在对话里汇报：第 0 步的原样输出；改动的文件清单；逐条 RW 的结果和证据（命令及输出摘要）；`npm test` 的结果；集成脚本最后一行；第 2 条自动检查能查出哪些写法；没做完的项和疑问。
