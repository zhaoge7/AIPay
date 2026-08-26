# ADR-004：Mandate Wire 与签名封装 Profile

- 状态：已接受
- 日期：2026-08-26
- 关联决策：`D-019`

## 背景

Mandate 是可携带的授权凭证，会被 API、策略引擎、数据库、异步任务和 SDK 共同处理。它必须在离开原始 HTTP 请求后仍可独立验签，并保持字段可读、可查询和可审计。

规划阶段的示例使用了松散 JSON 和单一 `signature` 字符串，尚未规定字段命名、规范化、算法标识、签名密钥或签名输入。直接对原始 JSON 字节签名会受到属性顺序和空白影响，只依赖 HTTP Message Signatures 又无法保护持久化后的 Mandate。

## 候选与权衡

| 维度     | 可读 JSON、JCS 与 Ed25519 Proof | JWS 签名封装                     | 仅 HTTP Message Signatures |
| -------- | ------------------------------- | -------------------------------- | -------------------------- |
| 开发成本 | 中等，需要规范化和测试向量      | 中高，需要 JOSE 封装和解码       | 初期低                     |
| 运行成本 | 低                              | 低                               | 低                         |
| 可靠性   | 规范化后签名输入稳定            | 标准封装成熟                     | 凭证脱离 HTTP 后无独立签名 |
| 安全性   | 域隔离、固定算法和严格输入      | 需严格防止算法降级和 Header 误用 | 持久化及异步传递保护不足   |
| 生态     | JCS、Ed25519 均有跨语言实现     | JOSE 生态最广                    | 适合请求和响应传输         |
| 锁定     | 中等，存在 AIPay Profile        | 中等，绑定 JOSE 数据模型         | 高度绑定 HTTP 传输         |
| 迁移     | JSON 持续可读和可查询           | 所有消费者需要理解 JWS           | 后续必须重做可携带凭证     |

## 决策

Mandate V1 使用严格 camelCase JSON 和嵌套 Money 对象。运行时结构由 Zod 严格 Schema 验证，未知字段一律拒绝。

| 字段                     | 规则                                                   |
| ------------------------ | ------------------------------------------------------ |
| `schemaVersion`          | 固定为字符串 `1`                                       |
| `mandateId`              | `mdt_` UUIDv7                                          |
| `principalId`            | MVP 固定为 `dev_` UUIDv7；组织主体留待新 Schema 版本   |
| `agentId`                | `agt_` UUIDv7                                          |
| `purpose`                | 1 至 500 个 Unicode 码点，不接受控制字符或孤立代理项   |
| `allowedMerchantIds`     | 1 至 100 个唯一 `mch_` UUIDv7，不支持隐式通配          |
| `allowedCategories`      | 1 至 50 个唯一小写分类标识                             |
| `maxPerTransaction`      | ADR-002 Money，不能超过 `totalBudget`                  |
| `totalBudget`            | ADR-002 Money                                          |
| `approvalRequiredAbove`  | ADR-002 Money；允许 `0`，是否触发由策略任务定义        |
| `maxTransactions`        | 1 至 1,000,000 的 JSON 安全整数                        |
| `issuedAt`、`validUntil` | ADR-002 UTC 时间，且 `issuedAt < validUntil`           |
| `instructionHash`        | `sha256:` 加 64 位小写十六进制摘要                     |
| `proof.scheme`           | 固定为 `aipay-jcs-ed25519-v1`                          |
| `proof.keyId`            | `key_` UUIDv7                                          |
| `proof.value`            | 64 字节 Ed25519 签名的规范无填充 base64url，共 86 字符 |

金额的精确 PostgreSQL `BIGINT` 上限、真实日历日期、唯一数组和字段间关系由显式语义校验补充；这些规则不使用无法忠实导出 JSON Schema 的 Zod transform。

## 签名输入

签名视图包含完整 Mandate，但 `proof` 中只保留 `scheme` 和 `keyId`，不包含 `proof.value`。签名输入按以下顺序构造：

1. 使用 RFC 8785 JCS 把签名视图规范化为 UTF-8 字节；
2. 在其前面拼接 UTF-8 编码的域隔离字符串 `AIPAY-MANDATE-V1\0`；
3. 使用 `proof.keyId` 对应的 Ed25519 私钥签名；
4. 把 64 字节签名编码为无填充、规范 base64url 并写入 `proof.value`。

验证时必须先执行结构和语义校验，再按固定 `scheme` 解析密钥并验证签名。任何未知 Scheme、无效 Unicode、非规范编码、缺失密钥或签名失败都必须拒绝，不能降级为未签名 Mandate。

本任务只固定签名 Profile、签名视图和测试接口。JCS 与 Ed25519 的具体实现库在 `P4-02` 实现签发和验签前按选型门禁单独确认并留档。

## HTTP Message Signatures 的边界

HTTP Message Signatures 保留给 `P3-04` 的 Agent 请求验签，可覆盖方法、路径、时间戳、nonce 和摘要。它保护传输请求，但不替代 Mandate 自身的可携带 Proof。

## 后果

- 策略和审计可以直接读取 Mandate JSON，无需先解码 JWS Payload。
- SDK 必须保持字段、数组顺序和 Unicode 内容，不得在签名前做未规定的规范化。
- 新增主体类型、算法、金额结构或字段需要新的 `schemaVersion` 或明确兼容规则。
- `P4-02` 必须加入跨实现测试向量、篡改测试和未知算法拒绝测试。
