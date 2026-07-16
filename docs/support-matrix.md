# 工具支持矩阵与人工验收口径

初始化器 `--tools` 当前支持四个工具。所有 adapter 都是薄入口:执行时按序读取根 `AGENTS.md` 栅栏块 → `business-agent/business-profile.yaml` → `business-agent/core/command-manifest.yaml` → `business-agent/core/commands/<id>.md`;方法论内容只存在于 core,adapter 不复制规则。

## 支持矩阵

| 工具 | `--tools` 值 | 项目级生成入口 | 发现方式 | 结构状态 | 对外认证状态 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | `.claude/commands/<id>.md`(front-matter `description`) | 输入 `/` 后的命令菜单 | generated | native_not_yet_manually_certified |
| Cursor | `cursor` | `.cursor/commands/<id>.md` | Agent 输入框 `/` 菜单 | generated | native_not_yet_manually_certified |
| GitHub Copilot | `copilot` | `.github/prompts/<id>.prompt.md` | Prompt picker;部分客户端支持 slash prompt | generated | native_not_yet_manually_certified |
| Codex | `codex` | **不生成项目级 prompts 文件** | 根 `AGENTS.md` 栅栏块内的命令索引 | via-AGENTS.md | native_not_yet_manually_certified |

状态语义:

- `generated`:初始化器生成入口文件并通过结构检查(`test:smoke` 断言存在性与「按序读取」内容);
- `via-AGENTS.md`:不落独立入口文件,依赖工具自身读取根 `AGENTS.md` 的约定。

**`generated` / `via-AGENTS.md` 都不等于「已在每个真实客户端版本人工认证」**——工具的命令发现机制随版本演进,正式启用前按下面的口径人工验收一次并记录版本。

仓库中的 JSON 验收记录与检查脚本处在同一信任域,只能标记为 `self-reported-manual-check`,**不能把上表提升为 certified**。在实现仓库外受信策略、发行者公钥 allowlist、canonical evidence 脱离签名、签名验证及 adapter/source digest 绑定前,所有 adapter 对外状态始终是 `native_not_yet_manually_certified`。

## 暂不支持的工具

`trae`(及别名 `trea`)、`kiro`、`codebuddy` 等传入 `--tools` 会直接报错并指向本文件。原因:v0.1 只为已验证过命令发现机制的四个工具生成入口,宁缺勿滥。欢迎按 [CONTRIBUTING.md](../CONTRIBUTING.md) 的「工具无关」原则提交新 adapter:一个 `kit/adapters/<tool>.yaml` 描述 + 初始化器生成逻辑 + 本矩阵条目。

## 人工验收口径

对每个启用的工具,在**初始化过的目标工作区根目录**(必须与 `--target` 指向同一目录)执行:

1. **入口可见**:打开工具,输入 `/`(或打开 Prompt picker),能看到全部 10 个命令(`agent-status` … `operate-agent`);codex 场景改为确认工具已读取根 `AGENTS.md`,能按栅栏块内索引响应命令名;
2. **薄入口生效**:运行 `/agent-status`,观察工具确实读取了 `business-agent/core/command-manifest.yaml` 与对应命令契约(输出里应体现 manifest 中的阶段与产物路径,而非入口文件里的只言片语);
3. **产物落点正确**:运行 `/discover-business` 走一小段,确认产物写到 `agents/_portfolio/00-discovery.md` 而不是工具自己的默认位置;
4. **记录证据**:记下工具名称、客户端版本、日期与上述三步结果,存入团队自己的验收记录(建议放 `business-agent/local/`,不进公共仓库)。

任一步不符,先检查:工具是否打开了 `--target` 指向的同一项目根(父目录的入口不会自动变成子仓库入口);入口文件是否带 `generated-by: business-agent` 指纹(手工改名 / 挪动会脱离升级管理)。

## 多工具共存

- 四个工具可同时启用,共享同一份 `business-agent/core/` 与根 `AGENTS.md` 栅栏块;
- 升级时各入口按指纹刷新;你在入口文件之外的自定义内容(如自建命令)不受影响;
- `AGENTS.md` 栅栏块外的内容永远不被初始化器改动,可放团队自己的通用说明。
