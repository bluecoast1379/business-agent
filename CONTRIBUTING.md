# 贡献指南

感谢参与 Business Agent Kit。本项目的目标是一套**任何业务都能复用**的 agent 规划工作流与运行骨架,因此贡献首先要守住三条原则。

## 三原则

### 1. core 通用

进入 `kit/core/` 的命令契约、模板、知识与清单必须与具体公司、行业、系统解耦:

- 规则要以「模式 + 反模式 + 守卫」的形式表述,不引用任何真实组织的流程细节;
- 需要举例时一律使用虚构公司 **Brewline**(精品咖啡豆 B2B 供应商,客户是咖啡馆)的合成语境;
- 公司专有的裁定、阈值、流程放进你自己的 fork 或目标工作区的 `business-agent/local/`,不要回流仓库。

### 2. 私有值本地化

- 密钥值、真实域名、内部主机名、真实客户 / 员工数据**永不进仓库**——包括代码、文档、示例、测试数据与提交历史;
- 配置与工具契约只引用环境变量**键名**(如 `BACKEND_API_KEY`),值由使用者在 `.env` 或部署环境提供;
- scaffold 不允许出现可用的默认密钥或默认内部地址;必填配置缺失必须 fail-fast。

### 3. 工具无关

- 方法论只写在 `kit/core/`;`kit/adapters/` 保持薄入口,只声明路径、格式与发现方式;
- 禁止在 adapter 或生成的命令入口里复制、改写、裁剪 core 规则——所有入口执行时统一回读 core;
- 新增工具支持 = 新增一个 adapter 描述 + 初始化器生成逻辑 + 支持矩阵条目,不新增第二份规则文本。

## 开发约定

- kit 的 `bin/`、`test/` 为纯 Node CommonJS(`.cjs`),scaffold 为纯 Node 18+ ESM(`.js`);两侧都**不引入任何 npm 依赖**。
- 文档以中文为主;命令 id、代码标识符、代码注释用英文。
- 新增或修改命令必须同步三处:`kit/core/command-manifest.yaml` 登记、`kit/core/commands/<id>.md` 契约、对应模板;`npm run check:manifest` 会拦截孤儿文件与漏登记。
- 影响产物结构时,同步更新 `examples/brewline/` 黄金样例与 `docs/methodology.md`。

## PR 检查清单

提交前逐项自查:

- [ ] `npm run check` 全绿(syntax / sanitized / manifest / scaffold / smoke);
- [ ] 无新增 npm 依赖;`engines.node >= 18` 下可运行;
- [ ] 新增 / 修改的命令已登记 manifest,entry 文档存在,模板同步;
- [ ] 受影响的 `examples/brewline/` 与 docs 已同步;
- [ ] 文档中文、标识符英文,示例全部 Brewline 合成语境;
- [ ] `CHANGELOG.md` 的 Unreleased 段已更新;
- [ ] 不包含任何真实业务数据、密钥、内部域名、真实人名(见下节)。

## 脱敏要求(强制)

- 提交前运行 `npm run check:sanitized`,必须零命中;
- 团队如有内部代号 / 域名 / 人名清单,放在**仓库之外**并用 `node bin/check-sanitized.cjs --extra-banned <file>` 一并扫描(示例见 [docs/private-denylist.example.txt](./docs/private-denylist.example.txt));
- 检查覆盖工作树,但**不含 Git 历史**——一旦敏感值已进入历史,按 [SECURITY.md](./SECURITY.md) 处理:立即轮换该凭证,再清理历史;
- Issue 与 PR 描述同样不得附任何真实业务数据或密钥。

## 提交流程

1. Fork 并创建特性分支;
2. 完成修改与上面的自查清单;
3. 发起 PR,说明动机、影响面与验证方式;
4. 维护者审查以三原则为第一优先级——违反三原则的 PR 即使功能正确也会被要求返工。
