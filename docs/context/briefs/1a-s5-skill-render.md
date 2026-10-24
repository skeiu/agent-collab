本文件：第 1a 阶段实现第 S5 步中 dsh 负责的部分（skill 渲染、构建、插件清单、doctor 的流程配置）交给 dsh 的任务书原文。派任务时让 dsh 读本文件执行；验收时对照；任务书改版时更新。

> 状态：定稿 2026-10-25，由 Claude 按用户 2026-10-24 的授权（到 2026-10-25 08:00 由 Claude 自行派发和审核）定稿并在 dsh Web 派发，用户未逐份审阅。依据：PLAN.md §7.1、§8、§11.1、§12.2、§13、§15“1a”；protocol.md §6 的 `doctor`（本稿同时补了 `--designer` 和 `flow`）；1a 实现决定 5（skill 正文和模板由 Claude 写，渲染和构建由 dsh 写）。skill 正文和模板已由 Claude 写好：`skills/collab/SKILL.template.md`、`skills/collab/hosts/claude.md`、`skills/collab/references/brief-template.md`、`correction-template.md`。

你在 agent-collab 仓库根目录工作。先读 AGENTS.md、docs/context/RUNBOOK.md 的“派发 dsh 任务”、docs/context/1a-impl-plan.md 的“步骤”和 S5 的验收标准，再读 docs/protocol.md 的“通用约定”和第 6 节的 `doctor`，以及上面列的四个 skill 文件。docs/PLAN.md 只读 §7.1、§8 开头到“阶段 0”、§11.1（先用 `grep -n '^#' docs/PLAN.md` 定位，不要全文读）。

## 第 0 步：沙箱自检（必须先做）

同 S4 原任务书（docs/context/briefs/1a-s4-dsh-adapter.md）第 0 步：运行 `pgrep -af dsh` 和 `cat /proc/1/cmdline | tr '\0' ' '`，原样汇报；看到用户日常运行的 dsh Web 进程就停止。

## 任务

全部用 Node ≥ 20 的内置模块，ESM，不加依赖。

1. **`core/render-skill.mjs`**：导出纯函数 `renderSkill({ template, host, hostName, lang = 'zh' })`，返回渲染好的 `SKILL.md` 文本；另导出 `parseHost(text)` 便于测试。出错时抛 `code` 为 `render_error` 的错误，消息写明哪个占位符、哪个槽或哪一行。规则：
   - **host 文件**（`skills/collab/hosts/<hostName>.md`）：开头是 `---` 包起来的变量区，每行 `键: 值`，键匹配 `^[A-Za-z][A-Za-z0-9]*$`，值是冒号后一个空格之后到行尾的原文（不做引号或转义处理），键重复报错。变量区之后是若干槽：一行恰好为 `<!-- slot: 名称 -->` 开始一个槽，内容到下一个槽标记或文件末尾为止，去掉首尾空行；名称规则同键；槽名重复报错。变量区和第一个槽之间只能有空行。
   - **模板**（`skills/collab/SKILL.template.md`）：开头必须是 `---` 包起来的 frontmatter。占位符只有两种：`{{var.名称}}` 换成 host 的变量值，`{{slot.名称}}` 换成槽的内容。frontmatter 里也可以有占位符。替换只做一遍，替换进来的文字不再扫描占位符。
   - **报错**：模板里引用了 host 没有的变量或槽；host 里有变量或槽模板没用到；模板里出现其他形式的 `{{…}}`；`lang` 不是 `zh`（1a 只有中文）。
   - **输出**：frontmatter 的结束行 `---` 之后插入一行 `<!-- 本文件由 core/render-skill.mjs 从 SKILL.template.md 和 hosts/<hostName>.md 生成，不要直接修改；改了模板后运行 npm run build。 -->`，再接模板正文。换行一律 LF（输入里的 CRLF 先转成 LF），文件以一个换行结尾。
2. **构建**：`scripts/build.mjs` 的“生成 SKILL.md”这一步改为实际执行：读模板和 `hosts/claude.md`，渲染后写到 `skills/collab/SKILL.md`（在仓库里，不受 `--out` 影响，内容没变时不重写文件）。加 `--check` 参数：只渲染并和仓库里的 `skills/collab/SKILL.md` 比较，不写任何文件、不打包桥接；不一致或文件不存在时以退出码 1 结束并说明。其余步骤的行为不变。改完运行一次 `npm run build`，生成的 `skills/collab/SKILL.md` 放进本次改动（构建产生的 `dist/` 删掉）。
3. **插件清单** `.claude-plugin/plugin.json`：`name` 为 `agent-collab`，`version` 与根目录 `package.json` 一致，`description` 用一句中文说明，`license` 为 `MIT`，`repository` 为 `https://github.com/skeiu/agent-collab`。不写 commands、hooks（1b 才有）。
4. **doctor 的流程配置**（protocol.md §6，Claude 已写好）：`doctor` 加 `--designer <名称>` 参数（也接受 `--designer=<名称>`），`--json` 输出加 `flow` 字段：`{ designer, executor, confirmBeforeDispatch, maxCorrectionRounds, commitOnAccept, warnSameAgentPair }`，取全局和项目两级合并后的配置（用 `core/config.mjs` 现有的读取函数，项目级只能收紧的规则照旧生效）；`executor` 为 `executorByDesigner[designer]`，没给 `--designer` 时 `designer`、`executor` 都是 `null`。配置读不出来或校验失败时 `flow` 为 `null`，并加一条 `id` 为 `config`、`level` 为 `warn` 的检查项说明原因（现在只往 stderr 打一行，改成检查项；配置正常时不出这一项）。不带 `--json` 时多打一行 `flow` 的摘要。

## 测试

- 新增 `tests/render-skill.test.mjs`：
  - 规则逐条一个用例：变量和槽的替换；替换进来的文字含 `{{var.x}}` 时不再展开；未知变量、未知槽、未用的变量、未用的槽、其他形式的 `{{…}}`、重复键、重复槽、变量区和第一个槽之间有非空行、模板没有 frontmatter、`lang` 为 `en`，各报 `render_error`；CRLF 输入得到 LF 输出。
  - 仓库里的 `skills/collab/SKILL.md` 和渲染结果完全一致（CI 用它发现忘了重新生成）。
  - 渲染出的 `SKILL.md`：frontmatter 有 `name: collab`、`disable-model-invocation: true`，`allowed-tools` 恰好是 `Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs":*)`；正文没有残留的 `{{`；正文提到的 `references/brief-template.md`、`references/correction-template.md` 文件存在。
  - `.claude-plugin/plugin.json` 是合法 JSON，`name`、`version` 符合第 3 条。
- `tests/build.test.mjs`：`--check` 一致时退出码 0 且不写文件（比较前后的修改时间和 `dist/` 是否出现）；在临时副本里改一个字的模板后 `--check` 退出码 1。
- `tests/doctor.test.mjs`：`--designer claude` 时 `flow.executor` 为 `dsh`（默认配置），全局配置改了 `executorByDesigner.claude` 时跟着变；项目配置把 `confirmBeforeDispatch` 改松（比如全局 `always`、项目 `never`）时仍为 `always`；没给 `--designer` 时 `designer`、`executor` 为 `null`；全局配置文件不是合法 JSON 时 `flow` 为 `null`、有 `config` 检查项、顶层 `ok` 不受影响。

## 验收标准

- SA1 渲染：`tests/render-skill.test.mjs` 全部通过。反证：在副本里把“替换只做一遍”改成循环替换到没有占位符为止，对应用例失败，汇报断言原文。
- SA2 构建：`npm run build` 退出码 0，`skills/collab/SKILL.md` 生成且第二次运行不改它的修改时间；`node scripts/build.mjs --check` 退出码 0；`tests/build.test.mjs` 通过。
- SA3 插件清单：第 3 条的测试通过。
- SA4 doctor：`tests/doctor.test.mjs` 全部通过（原有用例不改断言，只因输出多了 `flow` 字段而补充）；`node tests/integration/adapter-dsh.mjs` 仍然 `RESULT: 通过`（按 S4 原任务书的方式运行）。
- SA5 回归：`npm test` 连跑 3 次全部通过，每次跑完没有 `fake-executor`、`fake-dsh-cli`、`run.mjs --worker` 进程（用 `pgrep` 时别匹配到命令自己所在的 shell）；`npm run build` 后 `dist/` 删掉；仓库仍然没有任何依赖；每个新文件开头有一行职责说明（`SKILL.md` 例外，它的第一行必须是 frontmatter 的 `---`，说明在插入的那行注释里）。
- `claude --plugin-dir` 加载后 `/agent-collab:collab` 是否可用、`allowed-tools` 是否生效，由 Claude 在你交付后自己实测，你不用做。

## 非目标

- 不改 Claude 写的 skill 文件（`SKILL.template.md`、`hosts/claude.md`、`references/*-template.md`）；发现它们的问题（例如和 protocol.md 的命令或字段对不上）写进汇报。`report-schema.json` 也不改。
- 不做英文模板和 `i18n/`、`hosts/dsh.md`、`hosts/codex.md`（第 3 阶段）、`marketplace.json`、`commands/`、`hooks/`（1b）、`setup.mjs`。
- 不改 `core/run.mjs`、`core/worker.mjs`、`core/adapters/`、`dsh-bridge/`。

## 隔离和安全（违反任何一条都算不通过）

- 遵守 RUNBOOK“派发 dsh 任务”的全部规定。被测 dsh 只在临时 `DSH_HOME` 里运行，`--port 0 --no-open`，不访问 dsh 的默认端口；不读写 `~/.dsh`，不读 `.env`；不调用真实模型。不运行 `claude` 命令。
- 测试只在系统临时目录下建 git 仓库、`AGENT_COLLAB_HOME`、`DSH_HOME`；不在本仓库里运行 `run start`。
- 只停止自己 spawn 的进程（按 PID）；不执行 kill/pkill/killall/fuser 按名字或端口找进程。
- 遇到需要越权（审批）的操作：不要申请，记为发现。
- 不在本仓库执行 git commit、git push、切分支；不修改 docs/ 下的任何文件和 AGENTS.md。发现与它们不一致的地方，写进汇报。

## 汇报

在对话里汇报：
- 第 0 步的原样输出；
- 新建或修改的文件清单；
- 逐条 SA 的结果和证据（命令及输出摘要），反证的断言原文；
- 渲染出的 `skills/collab/SKILL.md` 的前 12 行原文；
- `npm test` 的结果和本步新增测试的耗时；
- 你开过的所有后台任务及其结束情况；
- 和 PLAN.md、protocol.md 不一致或没写清楚的地方；skill 文件里你看到的问题；没做完的项和疑问。
