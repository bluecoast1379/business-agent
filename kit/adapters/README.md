# kit/adapters — 多工具接入层

本目录声明每个 AI 工具的**薄 adapter**:`init-workspace.cjs` 据此在目标工作区生成命令入口文件。方法论内核只有一份(`kit/core/`),adapter 一律是薄入口——执行时按序读取:

1. 根 `AGENTS.md` 的 business-agent 栅栏块(总入口与使用约定)
2. `business-agent/business-profile.yaml`(业务画像)
3. `business-agent/core/command-manifest.yaml`(命令清单与产物契约)
4. `business-agent/core/commands/<id>.md`(对应命令的阶段契约)

## 支持矩阵

| 工具 | 状态 | 生成位置 | 格式 | 发现方式 |
| --- | --- | --- | --- | --- |
| Claude Code | generated | `.claude/commands/<id>.md` | Markdown + front-matter(description / argument-hint) | 斜杠命令自动发现 |
| Cursor | generated | `.cursor/commands/<id>.md` | 纯 Markdown | 命令面板 / 斜杠命令 |
| GitHub Copilot | generated | `.github/prompts/<id>.prompt.md` | 纯 Markdown(prompt file) | prompt files |
| Codex CLI | via-AGENTS.md | 不生成文件 | — | 根 `AGENTS.md` 栅栏块 |

其他工具(如 trae / kiro / codebuddy)暂不支持:`init-workspace --tools` 传入不支持的工具会明确报错并指向 `docs/support-matrix.md`。

## adapter 描述文件字段

| 字段 | 含义 |
| --- | --- |
| `tool` | 工具 id(与 `--tools` 参数取值一致) |
| `status` | `generated`(生成项目级命令文件)或 `via-AGENTS.md`(仅靠根 AGENTS.md) |
| `output_dir` | 命令入口生成目录(相对目标工作区根;空 = 不生成) |
| `file_pattern` | 文件名模板,`{id}` 会替换为命令 id |
| `frontmatter` | 是否在文件头生成 YAML front-matter |
| `discovery` | 工具如何发现这些命令(人读说明) |

## 人工验收口径

对每个声明为 `generated` 的工具,初始化后逐项确认:

1. **文件齐全**:生成目录下的命令文件数量 = `command-manifest.yaml` 的命令条数,文件名与命令 id 一一对应;
2. **薄入口内容**:每个文件包含「按序读取」四步清单,且第 4 步指向自己的 `business-agent/core/commands/<id>.md`;
3. **工具可发现**:在工具内输入 `/` 能看到全部命令(Claude Code / Cursor),或在 prompt 选择器中能看到(Copilot);
4. **指纹在位**:文件头部有 `generated-by: business-agent` 注释——手工改过的文件在升级时不会被覆盖,而是生成 `*.business-agent-new` 供人工比对;
5. **codex 口径**:根 `AGENTS.md` 栅栏块内命令总览完整,栅栏外的既有内容一个字符都不能被改动。
