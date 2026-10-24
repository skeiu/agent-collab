<!-- 本文件：设计端写任务书用的模板（PLAN.md §8 阶段 1）。设计端按它填写后，整份作为任务书交给执行端；`<task>` 这类英文标签保留，尖括号里的中文是填写说明，填完删掉；本行注释也删掉。 -->

<task>
需求原文：<用户的原话，照抄>

计划：<分几步做、每步改哪里；只写执行端需要知道的>

相关文件：<要读或要改的文件和函数，带路径>

要遵循的约定：<项目里的命名、风格、目录约定；有 AGENTS.md、CLAUDE.md 等规则文件的，写明先读它>

参考图片：<没有就删掉这一行；有就列出文件路径，执行端是 dsh 时写“用 read_image 读取”>
</task>

<environment>
- 执行端在仓库根目录工作，权限为 workspace-write：工作区内可以读写；工作区外的写入、联网等越权操作会弹出审批，由人在 dsh Web 里批准或拒绝，被拒绝时换别的做法或汇报 blocked。
- <有无网络；哪些目录只读；已知跑不了的检查（例如需要真实服务、特定平台）；缓存要重定向到哪里>
</environment>

<acceptance_criteria>
- AC1：<一条能用命令或可观察的行为验证的标准，写出验证方法>
- AC2：<……>
</acceptance_criteria>

<non_goals>
- <这次不做什么，避免执行端扩大范围>
</non_goals>

<protected_paths>
<不许修改的路径，一行一个，例如设计端预先写好的验收测试；没有就删掉整个块>
</protected_paths>

<verification_loop>
收尾前依次运行下面的检查，全部通过再汇报；失败就修，修不好的写进汇报的 blocked_checks：
- <命令 1，例如 npm test>
- <命令 2>
</verification_loop>

<action_safety>
- 不提交、不切分支、不改 git 配置；只改完成任务所需的文件，不顺手重构或格式化无关代码。
- 不读写仓库外的文件，除非任务明确需要；不读取密钥和凭据文件。
- 只结束自己启动的进程。
- <从项目规则、用户要求里抄过来的其他规则>
</action_safety>

<when_blocked>
遇到产品决策、需求有歧义、缺权限或缺工具时，不要直接问人，也不要猜：停下来，最后一条消息按下面的汇报格式输出，status 写 "blocked"，在 open_questions 里写清要谁决定什么。
</when_blocked>

<output_contract>
最后一条消息只输出一个 ```json 代码块，前后不要有别的文字。JSON 是一个对象，字段全部必填、不能多：
- "status"："done"、"partial" 或 "blocked"
- "summary"：字符串，改了什么、为什么
- "criteria"：数组，每条 AC 一项 { "id": "AC1", "met": true 或 false, "evidence": "证据：命令和结果摘要" }
- "commands"：数组，实际跑过的命令 { "command": "…", "exit_code": 整数或 null, "result": "结果摘要" }
- "files_changed"：数组，改动的文件路径（字符串）
- "deviations"：数组，偏离任务书的地方及原因（字符串）
- "blocked_checks"：数组，没能跑的检查 { "check": "检查名或命令", "error": "具体错误" }
- "open_questions"：数组，需要设计端决定的问题（字符串）
- "human_inputs"：数组，执行过程中收到的人的插话 { "message": "插话原文", "handling": "你怎么处理的" }
</output_contract>
