# ADR-003：Zod 4 Contract 运行时校验

- 状态：已接受
- 日期：2026-08-26
- 关联决策：`D-017`
- 首次实施目标版本：`4.4.3`

## 背景

Mandate、Quote 和 Transaction 会接收不可信 JSON，并被 API、Worker、SDK、签名和审计共同使用。TypeScript 类型在运行时不存在，因此 Contract 需要唯一的运行时 Schema，同时需要可读错误、静态类型推导和跨语言可消费的 JSON Schema。

## 候选与权衡

| 维度     | Zod 4 严格 Schema             | TypeBox 1 与编译校验            | 手写 TypeScript 校验器   |
| -------- | ----------------------------- | ------------------------------- | ------------------------ |
| 开发成本 | 低，Schema 组合和类型推导直接 | 中等，需要管理 JSON Schema 语义 | 随字段和嵌套增长快速上升 |
| 运行成本 | MVP 可接受                    | 编译后较低                      | 单次校验低，但维护成本高 |
| 可靠性   | 错误路径清晰，组合能力强      | 标准表达直接                    | 容易遗漏未知字段和边界   |
| 安全性   | 可统一严格对象和拒绝策略      | 可使用严格 JSON Schema          | 每个校验器都需重复审计   |
| 生态     | TypeScript 与 API 工具成熟    | JSON Schema 和跨语言工具直接    | 无标准工具链             |
| 锁定     | 中等，可用 JSON Schema 降低   | 较低，Schema 接近开放标准       | 锁定自有实现             |
| 迁移     | 中低                          | 低                              | 高，需要重写和补兼容测试 |

## 决策

Contract 运行时校验采用 Zod 4，依赖使用精确版本并由 pnpm 锁文件固定。首次实施时已核对的稳定版本为 `4.4.3`。

- Wire Schema 使用严格对象并拒绝未知字段。
- 不对外部输入使用 coercion；错误类型和宽松输入不能改变签名语义。
- Wire Schema 只使用可以忠实导出 JSON Schema Draft 2020-12 的结构。
- 不在 Wire Schema 使用 `bigint`、`Date`、transform 或无法表达的自定义类型。
- Schema 校验成功后，再由显式映射函数转换为品牌 ID、金额和时间值对象。
- JSON Schema 输出纳入快照或结构测试，确保必填字段和 `additionalProperties: false` 不回退。
- 面向客户端的错误只包含稳定路径和错误码，不回显完整原始输入。

## 否决原因

TypeBox 更适合 JSON Schema 优先和高吞吐场景，但当前单人 TypeScript MVP 更重视实现速度和错误可读性。手写校验器已用于少量基础值对象，不适合扩展为嵌套、版本化的外部 Contract Schema。

## 后果

- `packages/contracts` 将新增精确固定的 Zod 运行依赖。
- Contract 类型由 Schema 推导，不再维护一份可能漂移的重复 interface。
- JSON Schema 是生成产物，不反向作为 Zod 的运行时输入。
- 若 Zod 的 JSON Schema 输出无法忠实表达某项协议规则，该规则必须拆分为可导出的结构校验和显式语义校验，并分别测试。
