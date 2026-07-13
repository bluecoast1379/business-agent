# 安全策略

## 支持版本

| 版本 | 状态 |
| --- | --- |
| 0.1.x | 接收漏洞报告(当前开发线,Unreleased) |

## 私密报告漏洞

**请勿通过公开 Issue 报告安全漏洞。**

- 首选:GitHub 仓库的 **Security → Report a vulnerability**(Private Vulnerability Reporting / Security Advisories)私密提交;
- 报告请包含:影响版本或 commit、复现步骤、影响评估;**不要附任何真实密钥或真实业务数据**,凭证用占位符表示;
- 维护者在 **7 天内**确认收到,并在评估后同步修复计划;修复发布前请勿公开细节。

## 关注的漏洞类型

- 初始化器越界写文件(逃逸 `--target`)、覆盖 preserveOnUpgrade 文件、破坏 `AGENTS.md` 栅栏外内容;
- 检查脚本或初始化器的命令注入 / 路径穿越;
- scaffold 的鉴权绕过(`/chat`、`/status`、`/jobs/*` 未持 `GATEWAY_AUTH_TOKEN` 可达)、webhook 验签绕过、写操作确认闸(confirm-gate)绕过、scope 绑定失效(越权租户);
- 成本 / 预算护栏失效(预算超限仍继续调用);
- 仓库内容中的敏感信息泄漏(词面或密钥形态)。

## 发布前脱敏义务(维护者)

任何对外分发(tarball、push、registry publish)之前必须:

```bash
npm run check:sanitized
```

- 必须**零命中**才可分发;命中输出只含 `文件:行号` 与掩码片段(前 3 后 3 字符),不回显全值;
- 有内部私有词表的团队,追加仓库外 denylist 一并扫描:

```bash
node bin/check-sanitized.cjs --extra-banned /path/outside-repo/private-denylist.txt
```

- 该检查扫描工作树,不含 Git 历史;若发现敏感值已进入历史:**先轮换该凭证**(视同已泄漏),再做历史清理与强制推送评估。

## 使用者的安全基线

scaffold 的运行时安全边界(fail-fast 配置、无兜底密钥、写操作人工确认、最小权限后端角色、webhook 验签)见 [docs/security-baseline.md](./docs/security-baseline.md);`harden-agent` 命令会对照「网关十大事故清单」逐项审查你的实例。
