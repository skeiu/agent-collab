本文件：第 1a 阶段技术验证第 2 批交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行（或从下一段起粘贴）；验收时对照；任务书改版时更新。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md，再读 docs/context/NOW.md 的“R6 隔离要求”（注意第 6 条的例外）和“第 2 批”。docs/PLAN.md 只读这些章节：§5.2、§5.4、§9.3、§11.9、§17 第 4 项（先用 grep -n '^#' docs/PLAN.md 定位，不要全文读）。可以参考 experiments/1a/ 下第 1 批的实验，尤其是 _shared/harness.mjs（复用它）、06-session-shell-env（会话的创建和 mount）、12-acp-overlay（服务商条目的格式）。

## 第 0 步：沙箱自检（必须先做）

运行下面两条命令，把输出原样写进汇报：

    pgrep -af dsh
    cat /proc/1/cmdline | tr '\0' ' '

如果输出里有用户日常运行的 dsh Web 进程（不是你自己沙箱里的进程），说明沙箱没有隔离进程：立即停止，只汇报这一步，不要继续。

## 任务：§17 第 4 项的实验

目录 experiments/1a/04-approval-question/，内容与第 1 批相同：run.mjs（一条命令跑完，try/finally 清理，子进程设超时，最后一行 `RESULT: 成立|不成立|部分成立` 加一句结论）、README.md、测试插件。

要回答的问题：
1. 审批请求和结果能否通过 `ctx.on('session/event')` 收到；事件名和关键字段是什么。
2. “等待审批”能否从会话状态（如 agent.status）或事件里判断出来。
3. 插件能否用代码批准或拒绝审批；用的是哪个服务、哪个方法。分别试一次批准、一次拒绝。
4. `ask_user_question` 的提问在插件里能否看到（工具调用事件，以及提问服务里的待答问题）；插件能否用代码回答；回答后模型能否收到答案。

做法：
- 被测 dsh Web 用临时 DSH_HOME，加 `--port 0 --no-open`，按 harness 的做法启动和停止。
- 模型配置：真实 DSH_HOME 的路径从环境变量 `AC_REAL_DSH_HOME` 读（没有设置就报错退出，不要猜默认值），profile 名从 `AC_REAL_DSH_PROFILE` 读（默认 web）。
  - 只读 `<真实 DSH_HOME>/profiles/<profile>/cordis.patch.yml`，挑出 `llm-*` 和 `agent-default-model` 两类顶层条目，写进临时 DSH_HOME 的 web profile。
  - 在临时 DSH_HOME 里建符号链接 `.env`，指向 `<真实 DSH_HOME>/.env`，让被测 dsh 自己读取密钥。
  - 设置了环境变量 `AC_TEST_MODEL` 时，用它覆盖 agent-default-model 的 model。
- 会话：测试插件建一个会话，cwd 为临时目录下的工作区，挂 `standard` 预设。
  - 审批：沙箱设为 `read-only`，审批策略设为 `ask`。让模型在工作区里写一个文件，触发审批；第一次批准，第二次拒绝。
  - 提问：让模型调用一次 `ask_user_question`，由插件回答一个固定答案，再让模型复述这个答案。
  - 给模型的指令要写得明确、可执行；单次运行的对话轮数要设上限。
- 插件把观察到的事件（名称、关键字段，去掉长文本）写进临时目录的 JSON 文件，run.mjs 读出来判断结论。

## 隔离、密钥和安全（违反任何一条都算不通过）

- 遵守 NOW.md 的 R6 隔离要求。第 6 条的例外只允许两件事：只读那一个 cordis.patch.yml；建 `.env` 符号链接。
- **不得以任何方式打开、读取、打印、复制或 grep `.env` 文件的内容**，包括查看链接是否指向正确文件时，只能用 `ls -l` 或 fs.lstat / fs.readlink。代码里不得出现读取 `.env` 的语句。
- 汇报、README、REPORT.md、日志摘录里不得出现密钥、网关名称、网关地址；模型只写类别（例如“网关上的某个对话模型”），不写服务商配置。
- 不写真实 DSH_HOME 里的任何文件。清理时只删临时目录（删除链接本身，不能跟随链接删除原文件；用 fs.rmSync 删临时目录前，先确认它在 os.tmpdir() 下）。
- 只停止自己 spawn 出来的进程（按 PID）；不执行 kill/pkill/killall/fuser 按名字或端口找进程；不访问 dsh 的默认端口。
- 遇到需要越权（审批）的操作：不要申请，把它记为发现。（注意：这里说的是你自己所在的 dsh 会话的审批，与实验里被测 dsh 的审批无关。）
- 文件名不能被 node --test 当成测试；完成后 npm test 仍须是 3/3。
- 不执行 git commit、git push；不修改 docs/PLAN.md、AGENTS.md 和 docs/context/ 下的任何文件。发现与 PLAN.md 不一致的地方，写进报告。
- 运行实验时需要环境变量 `AC_REAL_DSH_HOME`，它的值由用户在对话里告诉你；不要自己去找。

## 汇报

1. 在 experiments/1a/REPORT.md 末尾新增一节“第 2 批：§17 第 4 项”：一张表（问题 | 结论 | 关键事件摘录 | 对 PLAN.md 的影响），表后写说明、用的模型类别、运行次数和轮数。
2. 在对话里汇报：第 0 步的原样输出；新建或修改的文件清单；run.mjs 的最后几行输出（含 RESULT 行）；npm test 的结果；清理检查的方法和结果；没做完的项、遇到的问题和你的疑问。
