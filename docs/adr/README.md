# 架构决策记录

本目录保存影响 AIPay 架构、协议、安全或外部服务的已确认选型。开发清单中的决策记录保存全部选型流水，ADR 保存需要随代码共同演进的长期上下文。

## 留档规则

每项选型在实施前必须记录：

- 要解决的问题和不可妥协的约束；
- 至少两个候选及开发成本、运行成本、可靠性、安全性、生态、锁定和迁移难度；
- 推荐方案和否决其他方案的原因；
- 用户确认日期、决策状态和实施影响；
- 发生实质变化时，新建或修订 ADR，并保留被取代关系。

## 索引

| ADR                                                   | 状态   | 决策                                           |
| ----------------------------------------------------- | ------ | ---------------------------------------------- |
| [ADR-001](0001-modular-monolith-postgresql-outbox.md) | 已接受 | 模块化单体、PostgreSQL 与 Transactional Outbox |
| [ADR-002](0002-identifiers-money-time.md)             | 已接受 | 标识、金额与时间表示                           |
| [ADR-003](0003-contract-validation-zod.md)            | 已接受 | Zod 4 Contract 运行时校验与 JSON Schema 输出   |
| [ADR-004](0004-mandate-wire-signature-profile.md)     | 已接受 | Mandate Wire 与签名封装 Profile                |
| [ADR-005](0005-quote-pricing-signature-profile.md)    | 已接受 | Quote 固定计价、税费与签名 Profile             |
