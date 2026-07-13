# /define-tools

## Goal

把蓝图工具清单编译成**机器可读的工具契约目录** `agents/<slug>/01-tool-contracts.yaml`:每个工具的参数、scope 绑定、summary/raw 形态、写操作确认要求全部显式化。这份 YAML 是 `scaffold-gateway` 生成 toolpack 代码的直接输入,写得越精确,生成的代码越少返工。

## Required Inputs

- `agents/<slug>/00-blueprint.md`(前置产物,§3 工具清单)
- `agents/_portfolio/00-discovery.md`(§2 系统与 API 清单:路径、认证键名)
- `business-agent/core/templates/tool-contracts.template.yaml`
- `business-agent/core/knowledge/tool-design.md`(summary/raw、hint、scope 工厂模式)

## Execution Rules

- **read 优先**:先把全部只读工具契约写完并核对,再处理写工具;蓝图未列的写工具不得私自增加。
- 每条工具契约字段:`name`(snake_case 英文)、`description`(**面向 LLM 撰写**:说清何时该用、返回什么内容、与相邻工具的区别)、`method` + `path`(HTTP 后端)或 `script`(本地脚本)、`params`(每个参数 name/type/required/desc,枚举给 enum)、`scope_binding`、`mode`、`write`。
- **description 是给模型看的路标**:坏例「查询订单」;好例「按客户与日期区间查询订单汇总(件数、金额、履约率),默认返回 summary;需要逐单明细时传 mode=raw」。模糊的 description 直接导致模型选错工具。
- **scope 绑定防越权**:凡是按租户/客户/门店隔离的数据,对应参数(如 `tenant_id`)必须声明 `scope_binding: injected`——运行时由网关强制注入,模型传入的同名参数被覆盖;不允许「让模型自己填租户号」。
- **summary/raw 双形态省 token**:列表与明细类工具声明 `mode: summary|raw`,summary 为默认(裁剪字段、截断行数、给聚合);raw 需显式请求且注明行数上限。单值查询可只有一种形态,注明 `mode: summary`。
- **所有 `write: true` 的工具必须 `confirm: human`**,无例外;同时在 `effect` 字段用一句话写清副作用(如「创建一张贷记单」),供确认摘要展示。
- **认证只引用环境变量名**(如 `auth_env: BACKEND_API_KEY`),严禁出现任何密钥值或真实域名;`path` 用相对路径,主机名来自 `BACKEND_URL` 环境变量。
- 每个工具与蓝图能力清单双向核对:能力没有工具支撑 → 补工具或降能力;工具没有能力使用 → 删除(工具越少,模型选择越准)。

## Required Structure

`agents/<slug>/01-tool-contracts.yaml` 的完整骨架:

```yaml
# tool contracts for <slug> (input of /scaffold-gateway)
agent: <slug>
backend:
  base_url_env: BACKEND_URL          # 主机名来自环境变量,不写真实域名
  auth_env: BACKEND_API_KEY          # 只登记键名
tools:
  - name: get_order_summary
    description: "按客户与日期区间查询订单汇总(件数、金额、履约率)。默认 summary;要逐单明细传 mode=raw(上限 50 行)。"
    method: GET
    path: /api/orders/summary
    params:
      - name: customer_id
        type: string
        required: false
        desc: "客户编号;缺省时返回全部客户的聚合"
      - name: date_from
        type: string
        required: true
        desc: "起始日期 YYYY-MM-DD"
      - name: date_to
        type: string
        required: true
        desc: "结束日期 YYYY-MM-DD"
    scope_binding:
      tenant_id: injected            # 网关强制注入,模型传入被覆盖
    mode: summary|raw
    write: false
  - name: create_credit_note
    description: "为指定发票创建贷记单(写操作,需人工确认)。返回贷记单编号。"
    method: POST
    path: /api/credit-notes
    params:
      - name: invoice_id
        type: string
        required: true
        desc: "发票编号"
      - name: amount
        type: number
        required: true
        desc: "贷记金额,不得超过发票余额"
      - name: reason
        type: string
        required: true
        desc: "开具原因,将出现在确认摘要中"
    scope_binding:
      tenant_id: injected
    mode: summary
    write: true
    confirm: human
    effect: "在账务系统创建一张贷记单"
```

## Exit Criteria

- [ ] 蓝图能力清单与工具目录双向核对通过:无失配能力、无孤儿工具。
- [ ] 每条 description 面向 LLM(何时用 / 返回什么 / 与相邻工具区别),无一句话敷衍。
- [ ] 所有租户/客户级数据工具声明了 `scope_binding: injected`。
- [ ] 列表/明细类工具具备 summary/raw 双形态且 summary 为默认、raw 有行数上限。
- [ ] 所有 `write: true` 均带 `confirm: human` 与 `effect`;认证与主机名只有环境变量键名。
- [ ] YAML 可被解析(结构合法),无密钥值、无真实域名。

## Required Outputs

- `agents/<slug>/01-tool-contracts.yaml`
- 对话内提示下一步:`/scaffold-gateway <slug>`(并预告闸门条件:蓝图待确认项须为空)
