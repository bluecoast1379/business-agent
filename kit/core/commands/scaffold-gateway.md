# /scaffold-gateway

## Goal

**这是本工作流唯一的实现闸门命令**(manifest 中 `implementation_gate: true`)。通过闸门检查后,把 `business-agent/scaffold/` 实例化为独立的 `agent-gateway/` 项目,并按蓝图与工具契约完成定制:toolpack、agent 定义、知识文件、`.env.example` 键名;最后以 mock provider 跑通冒烟测试。规划阶段(order 0~5)的任何命令都不授权写代码,只有本命令通过闸门后才可以。

## Required Inputs

- `agents/<slug>/00-blueprint.md`(闸门输入)
- `agents/<slug>/01-tool-contracts.yaml`(闸门输入)
- `business-agent/scaffold/`(网关骨架源;缺失说明 kit 安装不完整,先重跑初始化)
- `business-agent/core/knowledge/gateway-architecture.md`、`knowledge/tool-design.md`、`knowledge/guardrails.md`

## Execution Rules

- **闸门检查先行,不过不动手**,三条全过才继续,否则报告缺什么并退出:
  1. `agents/<slug>/00-blueprint.md` 存在且非模板空壳;
  2. `agents/<slug>/01-tool-contracts.yaml` 存在且结构合法;
  3. 蓝图「§8 待确认项」为空(无未勾选条目)——有残留就回 `/design-agent` 找责任人拍板。
- **复制而非引用**:把 `business-agent/scaffold/` 整目录复制为 `./agent-gateway/`(或用户指定目录);目标目录已存在且非空时必须先征得用户同意,默认不覆盖。复制后 `agent-gateway/` 就是用户自己的代码,后续升级 kit 不影响它。
- **按契约翻译 toolpack**:把 `01-tool-contracts.yaml` 逐条翻译成 `src/toolpacks/<slug>/index.js`——每条工具用 scaffold 的 `defineTool` 定义,参数校验来自 params,`scope_binding: injected` 的参数用 `withScope` 包装,`write: true` 的工具用 `wrapWriteTool` 包确认门。**保留 demo toolpack 不删**:先用 mock provider + demo 数据跑通全链路,再把真实后端接进来——这是排错成本最低的顺序。
- **按蓝图落地 agent 定义**:系统提示词按蓝图 §2 五段组装成**函数**(日期等时变信息每次求值);知识文件(术语表等)落到 `src/knowledge/` 并确认组装代码运行时读取;巡检式 agent 按蓝图触发计划注册 scheduler 任务。
- **`.env.example` 只增补键名与注释**:契约中出现的每个 `*_env` 键名都登记进去;**生成的一切代码与配置不得内置任何真实密钥、真实域名、真实数据**——冒烟阶段一律 `LLM_PROVIDER=mock`。
- 跑 `npm run smoke`(scaffold 自带)验证:mock 对话一轮、确认门两段式、scheduler 单次 tick、成本追踪读数大于 0。失败先修再报告,不得带病交付。
- 完成后向用户交底:哪些文件是生成的、`.env` 要填哪些键(只说键名)、如何 `npm start`、如何把 demo toolpack 换成真实后端。

## Required Structure

实例化完成后 `agent-gateway/` 的预期结构(以 scaffold 为基,新增/修改处标注):

```markdown
agent-gateway/
├── package.json
├── README.md
├── .env.example        # [修改] 增补本 agent 的 *_env 键名与注释
├── .gitignore          # .env / /local/ / node_modules/ / *.log
└── src/
    ├── index.js
    ├── config.js
    ├── runtime/        # llm / agent / tool / session-store / cost-tracker / scheduler
    ├── channels/       # http / webhook
    ├── guardrails/     # scoped-tool / confirm-gate
    ├── agents/
    │   ├── registry.js # [修改] 注册本 agent(交互式/巡检式)
    │   └── <slug>.js   # [新增] 蓝图 §2 提示词组装函数 + 模型分档 + 预算
    ├── toolpacks/
    │   ├── demo/       # [保留] mock 联调用
    │   └── <slug>/
    │       └── index.js  # [新增] 契约翻译的工具定义
    └── knowledge/
        └── <slug>-glossary.md  # [新增] 蓝图 §2.3 术语表,运行时读取
```

同时在对话中给出「实例化报告」:闸门检查结果 / 生成与修改文件清单 / smoke 输出摘要 / 用户下一步(填 .env → npm start)。

## Exit Criteria

- [ ] 闸门三条检查全部通过并在报告中留痕;未通过时未写任何代码。
- [ ] `agent-gateway/` 复制完整(含 `.gitignore` 等隐藏文件),demo toolpack 保留。
- [ ] `.gitignore` 根定位忽略 `/local/`,并用 `git check-ignore` 确认默认 `state.json` 以及 lock/tmp/bak 产物不可追踪。
- [ ] `01-tool-contracts.yaml` 中每条工具都有对应 `defineTool` 实现:scope 注入、写确认门、summary/raw 与契约一致。
- [ ] 系统提示词为运行时组装函数,知识文件被运行时读取(读不到会报错)。
- [ ] `.env.example` 覆盖全部所需键名;生成物中零真实密钥、零真实域名(自查 grep 通过)。
- [ ] `npm run smoke` 通过,输出已记录到实例化报告。

## Required Outputs

- `agent-gateway/`(或用户指定目录)完整可运行项目
- 对话内实例化报告(闸门留痕 + 文件清单 + smoke 摘要 + 用户待办)
- 对话内提示下一步:`/harden-agent <slug>`
