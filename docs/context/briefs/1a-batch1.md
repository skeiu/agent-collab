本文件：第 1a 阶段技术验证第 1 批交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行（或从下一段起粘贴）；验收时对照；任务书改版时更新。

> 已执行（2026-10-23）。文中提到的 NOW.md“R6 隔离要求”现在在 [RUNBOOK.md](../RUNBOOK.md)“派发 dsh 任务”，“验收标准（第 1 批）”已归档到 [history/2026-10-23-1a-batch1.md](../history/2026-10-23-1a-batch1.md)；正文保留原样。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md，再读 docs/context/NOW.md 的“R6 隔离要求”和“验收标准（第 1 批）”。docs/PLAN.md 只读这些章节：§5、§9.1、§9.5、§11.4、§11.5、§15“1a：核心闭环”、§17（先用 grep -n '^#' docs/PLAN.md 定位，不要全文读）。

## 第 0 步：沙箱自检（必须先做）

运行下面两条命令，把输出原样写进汇报：

    pgrep -af dsh
    cat /proc/1/cmdline | tr '\0' ' '

如果输出里有用户日常运行的 dsh Web 进程（不是你自己沙箱里的进程），说明沙箱没有隔离进程：立即停止，只汇报这一步，不要继续。

## 任务：§17 第 2、1、3、6、7、18、12 项的最小实验

每项一个目录 experiments/1a/<两位编号>-<短名>/，编号用 §17 的编号（02、01、03、06、07、18、12）。建议按这个顺序做，后面的实验可以复用前面写的测试插件。

每个目录包含：
- run.mjs：只用 Node 内置模块。一条命令 `node experiments/1a/<目录>/run.mjs` 跑完全部流程：建临时环境 → 启动被测 dsh → 检查 → 清理（用 try/finally，失败也要清理）。每个子进程都要设超时。最后一行输出 `RESULT: 成立|不成立|部分成立|需要模型`，以及一句结论。
- README.md：目的、对应 §17 编号、运行方法、前置条件、结论及其依据。
- 需要测试插件时，插件源码放在该目录下，用 npm pack 打成 .tgz，再用 `dsh plugin --profile <临时 profile> add <tgz>` 装进临时 DSH_HOME。插件格式见 PLAN.md §5.4、§5.6。

各项要回答的问题：
- 02：agentPresets 服务有哪些预设 id，mount 的签名是什么。在被测 dsh Web 里用测试插件实际取到并打印出来，再与源码对照。
- 01：能否在插件的 bundle 补丁里基于 `standard` 派生一个去掉 `tool-ask-user` 的工具预设，而不是整份复制 standard 的插件列表。实际装进去，验证新预设存在、不含 tool-ask-user、其余与 standard 一致。
- 03：对已存在的路径调用 workspaceRegistry.create 时，是复用还是报错；attachSession 是否可用。workspaceRegistry 只能用 ctx.get 按需获取，不能写进 inject。
- 06：能否给单个会话的 shell 注入环境变量（例如 AGENT_COLLAB_ROLE=executor），只影响这个会话。先读源码找注入点，再尽量不经过模型实际验证；必须跑一轮模型才能验证的部分，标“需要模型”。
- 07：装插件、更新插件（版本号加一、行为改变）之后，正在运行的被测 dsh Web 是否不重启就生效（热重载），还是必须重启。
- 18：`dsh plugin add <tgz>` 需要什么：pnpm 从哪里来（本机没有全局 pnpm，只有 corepack）；安装一个没有依赖的 .tgz 时是否需要联网。离线用“registry 指向不可达地址 + pnpm 的离线参数”来模拟，并说明模拟的局限。
- 12：在临时 DSH_HOME 里手工写一个假的 web profile 用户层（一个 llm-* 服务商条目，base URL 指向不可达地址、不写任何 key；外加 agent-default-model），按 PLAN.md §11.5 挑出条目生成 acp 覆盖层，用 `dsh --profile acp --patch <覆盖层>` 验证：覆盖层能否正常加载，ACP 的 initialize / session/new 返回的当前模型是否就是覆盖层指定的模型。不需要真正调用模型。

## 隔离和安全（违反任何一条都算不通过）

- 遵守 NOW.md 的 R6 隔离要求，尤其是：
  - DSH_HOME 必须是 os.tmpdir() 下新建的目录，run.mjs 在运行任何 dsh 命令前断言这一点；
  - dsh web 要加 `--port 0 --no-open`；
  - COREPACK_HOME、npm_config_cache、PNPM_HOME、XDG_CACHE_HOME、XDG_DATA_HOME 都指向临时目录。
- 只停止自己 spawn 出来的进程（按 PID）。不执行 kill/pkill/killall/fuser 按名字或端口找进程，不访问 dsh 的默认端口。
- 不读写 ~/.dsh，不复制任何凭据；可以只读查看 dsh 的安装目录和源码（用 `command -v dsh` 加 realpath 定位，不写死路径）。
- 遇到需要越权（审批）的操作：不要申请，把它记为发现。
- 文件名不能被 node --test 当成测试：不叫 *.test.*、test-*、*-test.*、*_test.*，也不放在名为 test 的目录下。完成后 npm test 仍须是 3/3。
- 代码、README、报告里不得出现用户名、个人路径、本地网关名称和地址；端口只能写 dsh 默认值；路径用 $DSH_HOME、<dsh包目录>、<临时目录> 等占位。
- 不执行 git commit、git push；不修改 docs/PLAN.md、AGENTS.md 和 docs/context/ 下的任何文件。
- 发现与 PLAN.md 不一致的地方，写进报告，不要自行改设计。

## 汇报

1. 写 experiments/1a/REPORT.md：一张表，列为“编号 | 问题 | 结论（成立/不成立/部分成立/需要模型） | 关键证据摘录 | 不成立时对 PLAN.md 的影响（§15 表格里的后备方案涉及哪些章节）”；表后写每项的说明和未解决的问题。
2. 在对话里汇报：
   - 第 0 步的原样输出；
   - 新建文件清单；
   - 每个 run.mjs 的最后几行输出（含 RESULT 行）；
   - npm test 的结果；
   - 实验结束后，确认没有遗留你启动的进程和临时目录的检查方法和结果；
   - 没做完的项、遇到的审批、和你的疑问。
