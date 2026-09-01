# AIPay

AIPay 是面向 AI Agent 的人民币支付编排与信任层。它把 Agent 身份、结构化 Mandate、固定报价、幂等交易、支付通道、Payment Proof、可验证交付和审计时间线组合成一个可暂停、可恢复的闭环。

当前仓库已经实现 HTTP API、React 管理控制台、异步 Worker、PostgreSQL 状态机、支付宝网页支付与 AI 按量付费沙箱、Agent/Merchant TypeScript SDK、HTTP 402/MCP 示例、安全/故障/备份/监控门禁，以及 P11 设计伙伴的自托管 Agent bridge、Merchant adapter、逐笔流量证据和 MVP 复盘工具。

## 当前状态

- P8-P10 工程和 Gate 已完成；本机闭测环境运行于 `https://aipay.localhost:8443`。
- 私有伙伴工件版本为 `0.2.0`，包含 Contracts、SDK、Agent MCP bridge 和 Merchant HTTP adapter。
- P11 的真实伙伴交易仍必须由仓库外 Merchant/Agent、公网 HTTPS 环境、非 Fake 支付、真实工作负载和签署商业证据完成；内部示例、循环或测试流量不计入。
- 0.2.0 正式本地工件位于 `.local-state/partner-kit-0.2.0`，以 `KIT.json` 中的 clean Git revision 和 `SHA256SUMS` 为准。

核心入口：

- [SDK 与独立示例](./packages/sdk-ts/README.md)
- [闭测部署](./deploy/README.md)
- [设计伙伴闭测与证据规则](./PILOT.md)
- [0.2.0 伙伴工件说明](./PARTNER_RELEASE.md)
- [安全模型](./SECURITY.md)与[事故响应手册](./INCIDENT_RESPONSE.md)
- [伙伴招募方案](./PARTNER_OUTREACH.md)、[参与/付费意向模板](./PARTNER_INTAKE_TEMPLATE.md)和[MVP 最终复盘模板](./MVP_REVIEW_TEMPLATE.md)

## 环境要求

- Git
- Node.js 24 LTS（仓库通过 `.nvmrc` 固定主版本）
- Corepack
- pnpm 11（精确版本由根目录 `package.json` 固定）

数据库任务需要 Docker Engine；仓库脚本不依赖 Docker Compose 或本机 `psql`。

## 从新环境启动

以下命令假设已安装 NVM，且 GitHub SSH 访问已经配置：

```bash
git clone git@github.com:zhaoge7/AIPay.git
cd AIPay
nvm install
nvm use
corepack enable pnpm
pnpm install --frozen-lockfile
cp .env.example .env
```

先执行完整检查，确认本地工具链和依赖正常：

```bash
pnpm run check
pnpm run test
```

启动固定版本的本地 PostgreSQL 并应用迁移：

```bash
pnpm run db:up
pnpm run db:migrate
```

`db:reset` 只允许重建回环地址上以 `_dev` 或 `_test` 结尾的数据库。停止容器会保留开发数据卷：

```bash
pnpm run db:reset
pnpm run db:down
```

首次运行先生成本地 issuer/备份/metrics 配置：

```bash
pnpm --filter @aipay/api prepare:env
```

不涉及真实资金的 SDK 快速沙箱使用 Fake Provider。先构建并启动 API：

```bash
pnpm run build
pnpm --filter @aipay/api sdk:sandbox
```

终端 B 创建一天有效、权限受限且 Git 忽略的快速开始身份，然后启动独立 HTTP Merchant 示例：

```bash
pnpm run quickstart:setup
node --env-file=examples/.env.quickstart examples/paid-http-api/dist/index.js
```

终端 C 运行 HTTP Agent 客户端；随后可停止 HTTP Merchant，并运行会自行拉起 stdio Server 的 MCP Agent 客户端：

```bash
node --env-file=examples/.env.quickstart examples/paid-http-api/dist/client.js
node --env-file=examples/.env.quickstart examples/paid-mcp-tool/dist/client.js
```

完整 HTTPS 控制台和 Worker 环境要求受保护的支付宝沙箱配置、Caddy 与 user systemd，按[闭测部署文档](./deploy/README.md)执行：

```bash
pnpm run deploy:local
pnpm run deploy:smoke
```

成功后访问 `https://aipay.localhost:8443`。Caddy internal CA 不会自动写入系统信任库。

开发 API 默认监听 `.env` 中的地址，并提供开发者注册和登录：

```bash
curl -i http://127.0.0.1:3000/v1/auth/register \
  -H 'content-type: application/json' \
  --data '{"email":"developer@example.com","password":"replace-with-a-long-local-password"}'

curl -i http://127.0.0.1:3000/v1/auth/login \
  -H 'content-type: application/json' \
  --data '{"email":"developer@example.com","password":"replace-with-a-long-local-password"}'
```

成功响应通过 `Set-Cookie` 返回 HttpOnly、SameSite=Lax 会话 Cookie。HTTPS 环境同时增加 Secure；数据库只保存 Argon2id 密码哈希和会话 Token 的 SHA-256 摘要。控制台源码位于 `apps/web`，本地 Vite 入口为 `pnpm --filter @aipay/web dev`。

登录后可通过会话 Cookie 管理 API Key：

| 方法     | 路径                            | 用途                                  |
| -------- | ------------------------------- | ------------------------------------- |
| `POST`   | `/v1/api-keys`                  | 创建 Key；完整 Token 只在本次响应显示 |
| `GET`    | `/v1/api-keys`                  | 列出脱敏 Key 元数据                   |
| `POST`   | `/v1/api-keys/:apiKeyId/rotate` | 原子吊销旧 Key 并创建替代 Key         |
| `DELETE` | `/v1/api-keys/:apiKeyId`        | 幂等吊销 Key                          |

API Key 默认 90 天到期，可在创建或轮换请求中通过 `expiresInDays` 设置 1 至 365 天。数据库只保存完整 Token 的 SHA-256 摘要。

Agent 密钥对必须由 Agent 客户端生成，AIPay 只接收规范 base64url 编码的 32 字节 Ed25519 公钥：

| 方法    | 路径                         | 用途                       |
| ------- | ---------------------------- | -------------------------- |
| `POST`  | `/v1/agents`                 | 注册 Agent 名称和签名公钥  |
| `GET`   | `/v1/agents`                 | 列出当前开发者的 Agent     |
| `PATCH` | `/v1/agents/:agentId/status` | 在 enabled/disabled 间切换 |

Agent 私钥不得发送给 AIPay，也不得写入项目 `.env`、日志或数据库。

Agent 请求验签采用 RFC 9421。当前验证端点为 `POST /v1/agent/verify`，签名标签固定 `aipay`，必须按顺序覆盖 `@method`、`@target-uri`、`content-digest`、`content-type` 和 `x-aipay-agent-id`，并携带 `created`、`expires`、128-bit `nonce`、`keyid`、`alg="ed25519"`、`tag="aipay-agent-v1"`。签名窗口最长 300 秒；正文摘要格式为 RFC 9530 风格 `sha-256=:base64:`。

商户资料端点为 `POST /v1/merchants`、`GET /v1/merchants` 和 `PATCH /v1/merchants/:merchantId`。回调地址必须使用 HTTPS；只有 localhost 和回环 IP 可使用 HTTP。保存回调地址不代表已通过后续 Webhook 出站安全检查。

商户服务端点为 `POST/GET /v1/merchants/:merchantId/services` 和 `PATCH /v1/merchants/:merchantId/services/:serviceId`。服务类型支持 `api`、`mcp`、`skill`；V1 只接受固定 CNY 最小单位字符串价格，以及 `full_on_delivery_failure` 或 `non_refundable` 退款规则。HTTP JSON 校验不执行类型强制转换。

签名 Agent 通过 `GET /v1/catalog/services` 查询 active 商户下的 enabled 服务。可按 `type`、`category`、`merchantId` 过滤，并使用 `limit`（1-100 的十进制字符串）和 `svc_` `cursor` 分页。GET 空正文仍须按 Agent Profile 签署空字节 Content-Digest。

开发者通过 `POST /v1/mandates` 创建结构化 Mandate 草稿。草稿必须显式提供 Agent、商户/品类白名单、三类 CNY Money、次数、有效期和指令摘要；状态为 draft 且没有 proof，不能用于策略执行。签发在后续独立端点完成，不依赖 LLM。

首次启动签发服务前生成本地 issuer 配置，并将输出加入本地 `.env`（禁止提交）：

```bash
pnpm --filter @aipay/api prepare:env
```

所有者通过 `POST /v1/mandates/:mandateId/issue` 把 draft 原子签发为 active Mandate；`POST /v1/mandates/verify` 使用数据库中的 system 公钥独立验证 JCS Ed25519 proof。issuer 私钥只存在于 `AIPAY_MANDATE_SIGNING_PRIVATE_KEY` 或后续密钥服务，不写数据库。

`GET/POST /v1/mandates/:mandateId/lifecycle` 用于查询及执行 pause、resume、revoke。交易入口必须额外调用 lifecycle guard；proof 验真不等于授权仍有效。guard 在 `now >= validUntil` 时先原子落库 expired，再拒绝使用。

最终消费计数通过 `MandateUsageService` 在 Mandate 行锁内更新 `spent_amount_minor` 和 `completed_transaction_count`，固定检查单笔、次数、累计预算；支付前在途额度不得调用该接口冒充完成，必须使用后续 reservation 流程。

`BudgetReservationService` 在支付前创建 `rsv_` held 预占，Mandate 同步维护 reserved 金额/次数；数据库强制 `spent + reserved` 和 `completed + reservedCount` 不超过授权上限。同一 Mandate 并发预占通过行锁串行。

Reservation 终结固定为 released（payment_failed/cancelled）、expired（timeout）或 confirmed（payment_succeeded）。失败/超时归还 reserved，成功原子转入 spent/count；重复同一终态幂等，终态之间不可转换。`expireDue` 复用同一终结事务回收到期 held 记录。

金额严格大于 `approvalRequiredAbove` 时，`ManualApprovalService` 只创建 requires_confirmation Transaction，不预占、不创建 PaymentAttempt。所有者通过 `POST /v1/transactions/:transactionId/confirmation` approve/reject；批准只进入 authorized，后续支付前仍必须重新预占。

商户通过 `POST /v1/merchants/:merchantId/quotes` 创建 unsigned Quote draft，只提交 service、quantity、税费行为/税额和 30-900 秒有效期。unit/固定单价来自服务目录，subtotal/total 由服务端 bigint 计算；客户端不能提交派生价格字段。

商户客户端通过 `POST /v1/merchants/:merchantId/signing-key` 只登记 Ed25519 公钥，再对 `AIPAY-QUOTE-V1\\0 || JCS(signingPayload)` 签名并调用 `POST /v1/quotes/:quoteId/activate`。`POST /v1/quotes/verify` 可独立验签；私钥不得发送给 AIPay。

签名 Agent 通过 `POST /v1/transactions` 提交 active quoteId/mandateId。服务同时检查授权生命周期、Agent、商户/品类、Quote 状态/时效和预算容量，并由数据库复合外键锁定所有引用；创建只进入 authorized 或 requires_confirmation，不执行支付。

同一请求 body 还必须携带 16-128 字符 `idempotencyKey`，该字段受 Agent Content-Digest 签名保护。数据库只保存 key/request SHA-256 和 Transaction 引用；并发相同请求返回同一交易，不同 payload 复用 key 返回冲突。

每次 Payment Provider create/retry/query 都先写 `pcl_` started 账本，再在网络调用后记录 Provider status/reference、稳定错误和耗时；PaymentAttempt 只汇总当前状态。残留 started 代表可能的崩溃中调用，必须查询恢复，不能覆盖或静默删除。

Transaction 在创建时持久化不可变 `confirmation_required`，PaymentAttempt 在 Provider 曾返回 redirect/action 后单调持久化 `action_required`。后续状态或主动查询不会清除这两个事实；P11 报告据此区分 AIPay 人工批准、Provider 人工动作和 fully autonomous 调用，而不是从最终状态猜测。

PaymentAttempt 首次进入 succeeded、failed 或 unknown 时，Transaction 状态与 `transaction.paid`、`transaction.failed` 或 `transaction.payment_review` Outbox 事件在同一数据库事务提交；同状态 retry/query 不重复产生事件。Worker 再从 Outbox 投递商户通知，API 不在支付结果事务内执行外部 HTTP。

异步事件必须在业务 `DatabaseTransaction` 内调用 `enqueueOutboxEvent`；Dispatcher 用 `FOR UPDATE SKIP LOCKED` claim processing lease，支持 published、指数退避、dead_letter 和 stale lease 恢复。交付语义为 at-least-once，消费者必须按 `obx_` event ID 幂等。

商户 Webhook 使用系统 Ed25519 密钥签署原始 JSON body，固定发送 `x-aipay-event-id`、`x-aipay-key-id`、`x-aipay-timestamp` 和 `x-aipay-signature`；接收方必须在解析 JSON 前按原始字节验签，并按 `obx_` event ID 去重。每个事件保留 `whd_` 投递及逐次 `wha_` 尝试，HTTP 状态、稳定错误、耗时、退避和 dead_letter 均可查询。出站传输在每次连接前解析 DNS，只接受公网单播地址、固定连接解析后的 IP、保留原 Host/TLS SNI 且不跟随重定向；明文 HTTP 仅可通过显式开发选项访问纯回环地址。

## 支付宝沙箱路线

首个真实通道选择支付宝 [AI 网页应用收款](https://aipay.alipay.com/docs/ai-web-app-payment-qianyi/api-list/alipay-trade-page-pay.html)：使用 `alipay.trade.page.pay` 生成用户支付动作，`alipay.trade.query` 主动查单，`alipay.trade.refund`/`alipay.trade.fastpay.refund.query` 全额退款及查询。沙箱固定使用 `https://openapi-sandbox.dl.alipaydev.com/gateway.do`、RSA2、独立沙箱 appId/应用私钥/支付宝公钥和买卖家测试账户；密钥不得进入 Git、日志或数据库。

支付宝通知是 form-urlencoded POST。处理方必须先验 RSA2，再绑定 `app_id`、`seller_id`、`out_trade_no`、`total_amount`，只把 `TRADE_SUCCESS`/`TRADE_FINISHED` 视为支付成功；按 `notify_id` 和订单状态幂等，成功后返回纯文本 `success`。回调可能丢失，因此必须同时实现 `alipay.trade.query`。退款重试固定复用 `out_request_no`，`code=10000` 不等于退款成功，需检查 `fund_change=Y` 或主动查询。

回调只接受 RSA2、无重复参数且 `notify_time` 距接收时间不超过 26 小时（未来漂移不超过 5 分钟）。验签后仍须在数据库事务中锁定 `provider + out_trade_no` 对应 PaymentAttempt 并核对精确金额；`provider_webhook_events` 按 `provider + notify_id` 唯一记录 payload digest 和 applied/ignored，状态更新与商户 Outbox 同事务。重复、终态迟到通知返回 `success` 但不重复更新，订单/金额不匹配返回 `failure`。

主动查询使用稳定 merchant `out_trade_no` 调用 `alipay.trade.query`，并再次核对返回的 out_trade_no 与精确金额；`provider_reference` 保存可重复查询的 merchant order，`provider_transaction_id` 单独保存支付宝 trade_no，二者不互相覆盖。`ACQ.TRADE_NOT_EXIST` 保持 pending；查询网络/协议失败进入 unknown/review，但已 succeeded/failed 的终态永不被后续查询或回调回退。每次查询及支付宝交易号都写入 `payment_provider_calls`。

支付宝外部错误不得穿透核心。适配器只输出稳定码：`CHANNEL_UNAVAILABLE`（可重试系统/网络故障）、`PAYMENT_DECLINED`（余额/限额/风控等用户拒绝）、`INVALID_CHANNEL_REQUEST`（参数/金额）、`CHANNEL_CONFIGURATION_ERROR`（权限/APP_ID/签约/密钥）、`CHANNEL_RESPONSE_INVALID`（验签或订单金额错绑）、`CHANNEL_REJECTED`（未知非重试拒绝）和 `INVALID_PROVIDER_REFERENCE`。供应商 `code/sub_code/sub_msg` 与 SDK 文案不写数据库、不返回客户端。

V1 退款只允许 `full_on_delivery_failure` 服务对 paid/delivery_review/delivered 交易执行一次全额退款；Refund 通过复合外键绑定原 Transaction 金额和 succeeded PaymentAttempt。`rfd_` 稳定派生支付宝 `out_request_no`，create 的 `fund_change=Y` 才算成功，N/缺失进入 refund_review 并调用 `alipay.trade.fastpay.refund.query`，仅 `REFUND_SUCCESS` 恢复成功。每次 create/query 写独立 `refund_provider_calls`，Refund/Transaction/商户 Outbox 同事务；重复 create 返回同一 rfd_，不执行第二次退款。

退款状态机同时接受 Delivery failed/timed_out 产生的 refund_pending，并使用 Delivery 快照 refundPolicy；Service 后续改价/改策略不影响在途退款。Provider 明确失败或未知均进入 refund_review，`retryCreate` 以同一 rfd_/out_request_no 回到 refund_pending，成功终结 refunded；已 succeeded 不可回退。`non_refundable` 的 delivery_review 不可创建 Refund。V1 API/服务没有部分金额参数，`refunds` 的 transaction amount 复合外键和 transaction_id 唯一约束再强制一次全额退款。

`ReconciliationService` 按 Provider + UTC business date 创建唯一每日 run，主动查询所有已有外部引用的 PaymentAttempt 与 Refund，并复用生产 QueryObserved/调用账本。内部 pending/unknown 与通道明确终态差异可自动修复；已 succeeded/failed 与通道冲突只记录 manual_review，绝不回退资金终态；查询错误记录 query_failed。run/items 保存内部前后状态、通道观察、resolution 和稳定错误码，completed 同日重跑直接返回原 run，不重复调用通道。

开发者通过 `GET /v1/transactions/:transactionId/timeline` 获取权威只读时间线。投影直接来自 Mandate、Quote、Transaction、PaymentAttempt、每次 Payment/Refund Provider call、Payment Proof、Delivery、Refund、Outbox 和 Reconciliation item，按 occurredAt + eventId 稳定排序；每项只有固定 phase/type/object/time/status/provider/operation/errorCode，不返回 Provider 原文或自由 metadata。Principal owner 与 Merchant owner 可读，其他开发者统一拒绝。

当前沙箱只验证单一自营测试商户。生产多商户模式必须由实际收款商户完成产品签约，并通过服务商应用授权 `app_auth_token` 代调用；AIPay 不使用一个自有商户号代收第三方资金。支付宝 [AI 按量付费](https://aipay.alipay.com/docs/ai-receive/MACHINE_PAY.html) 已接入 `GET /v1/a2m/resources/:serviceId`：首次请求返回 402 `Payment-Needed`，携带 `Payment-Proof` 重试后完成验付、履约确认并返回 `Payment-Validation`。A2M 与通用 Agent Transaction/PaymentAttempt Provider 路径并存，不互相冒充。

## Payment Proof V1

Payment Proof 是最多 15 分钟有效的一次性交付凭证，不替代 Mandate。严格 V1 Contract 绑定 `ppf_`、Transaction、成功 PaymentAttempt、Merchant、Service、精确 CNY Money、issuedAt/expiresAt；AIPay system issuer 对 `AIPAY-PAYMENT-PROOF-V1\0 || JCS(signingPayload)` 做 Ed25519 签名，签名 payload 移除 `proof.value`。Proof 不携带 Provider 原始报文、支付账号或用户身份数据。

所有者通过 `POST /v1/transactions/:transactionId/payment-proof` 对 paid Transaction 幂等取得 Proof；`POST /v1/payment-proofs/verify` 公开验证密码学签名与当前有效期。商户所有者通过 `POST /v1/merchants/:merchantId/payment-proofs/consume` 一次消费：服务端再次锁定并核对 Transaction/Attempt/Merchant/Service/Money/key/signature，原子标 consumed、推进 delivery_pending 并写 `transaction.delivery_started` Outbox。跨商户、跨服务、跨交易、金额替换和重复消费均拒绝；过期消费会持久化 expired。

若 Merchant 在 consume 成功后、保存 `deliveryId` 前崩溃，可调用 `POST /v1/merchants/:merchantId/payment-proofs/recover` 或 SDK `recoverPaymentProofConsumption`。恢复端点只允许同 owner 提交完全相同、签名有效且已 consumed 的 Proof，并只读返回原 Delivery；它不会重新消费 Proof、创建第二个 Delivery 或改变一次性 replay 拒绝语义。

消费 Payment Proof 时服务端在同一事务创建 pending `dlv_`，商户不能自选 Delivery ID。商户对 `AIPAY-DELIVERY-RECEIPT-V1\0 || JCS(payload)` 做 Ed25519 签名并提交严格 Delivery Receipt：绑定 dlv/txn/ppf/mch/svc、succeeded/failed、SHA-256 结果摘要、deliveredAt 和失败码。公开 `/v1/deliveries/verify` 验签；商户 owner 的 receipt 提交再次锁定所有绑定，成功转 delivered，失败转 refund_pending，并与 `transaction.delivered`/`transaction.delivery_failed` Outbox 同事务。完全相同 Receipt 重试幂等，不同终态冲突。

pending Delivery 默认 5 分钟截止，并快照 Proof 消费时的 refundPolicy；`now >= expiresAt` 即超时。多 Worker 以 `FOR UPDATE SKIP LOCKED` 扫描：`full_on_delivery_failure` 原子进入 timed_out + refund_pending，`non_refundable` 进入 timed_out + delivery_review，并写 `transaction.delivery_timed_out` Outbox。Receipt 提交也在行锁内先检查 deadline，因此扫描与迟到 Receipt 竞争只产生一个终态；超时后 Receipt 一律拒绝。

## 环境变量

本地开发从 `.env.example` 创建 `.env`。`.env` 已被 Git 忽略，不要在其中提交真实密钥、Token 或用户数据。

| 变量                                                                                        | 用途                                                         | 当前示例         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------- |
| `NODE_ENV`                                                                                  | 运行环境，可选 `development`、`test`、`production`           | `development`    |
| `AIPAY_API_HOST` / `AIPAY_API_PORT`                                                         | API 绑定地址与端口                                           | `127.0.0.1:3000` |
| `AIPAY_WORKER_CONCURRENCY`                                                                  | Worker 最大并发数，必须为正整数                              | `1`              |
| `AIPAY_DATABASE_URL`                                                                        | PostgreSQL 连接 URL                                          | 本地开发 URL     |
| `AIPAY_MANDATE_SIGNING_KEY_ID` / `AIPAY_MANDATE_SIGNING_PRIVATE_KEY`                        | system issuer 的 `key_` UUIDv7 与 base64 PKCS#8 Ed25519 私钥 | 本地生成         |
| `AIPAY_BACKUP_KEY`                                                                          | AES-256-GCM 数据库备份密钥                                   | 本地生成         |
| `AIPAY_METRICS_TOKEN`                                                                       | `/internal/metrics` Bearer Token                             | 本地生成         |
| `AIPAY_DEPLOYMENT_MODE` / `AIPAY_PUBLIC_ORIGIN`                                             | `local` 或获批 `external` 部署及其裸 HTTPS origin            | 本地模式自动设置 |
| `AIPAY_ALIPAY_MODE` / `AIPAY_ALIPAY_APP_ID` / `AIPAY_ALIPAY_SELLER_ID`                      | 支付宝网页支付模式、应用与收款方                             | 沙箱配置         |
| `AIPAY_ALIPAY_PRIVATE_KEY` / `AIPAY_ALIPAY_PLATFORM_PUBLIC_KEY` / `AIPAY_ALIPAY_NOTIFY_URL` | RSA2 应用私钥、支付宝公钥与精确回调 URL                      | 沙箱配置         |

配置无效时，程序只报告变量名，不回显变量值。支付宝 AI 按量付费项目配置从权限为 `0600` 且 Git 忽略的 `.alipay-sandbox.json` 加载；不得把其中内容复制到 README、日志或提交记录。Agent bridge 和 Merchant adapter 的独立变量见各自 README。

## 常用命令

| 命令                                                                                                      | 作用                                                        |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm run build` / `pnpm run check` / `pnpm run test`                                                     | 构建；类型/Lint/格式；全部 workspace 测试                   |
| `pnpm run security:scan`                                                                                  | Gitleaks Git/文件扫描与 AST/Schema 敏感 sink 审计           |
| `pnpm run test:faults` / `pnpm run incident:drill`                                                        | 确定性支付/Webhook 故障矩阵；止付/隔离/恢复/通知演练        |
| `pnpm run monitoring:check` / `pnpm run gate:p10`                                                         | 校验 Prometheus 规则；执行完整 P10 闭测门禁                 |
| `pnpm run db:up` / `pnpm run db:migrate` / `pnpm run db:down`                                             | 启动数据库、应用 forward-only 迁移、停止并保留数据卷        |
| `pnpm run db:reset`                                                                                       | 仅重建回环地址且以 `_dev`/`_test` 结尾的数据库              |
| `pnpm run db:backup <新文件>`                                                                             | 创建不覆盖的 0600 AES-GCM PostgreSQL custom dump            |
| `pnpm run quickstart:setup`                                                                               | 创建受限、短期且 Git 忽略的 SDK 快速开始身份                |
| `pnpm run deploy:local` / `pnpm run deploy:smoke`                                                         | 安装并验证本机 Caddy/internal-CA/API/Worker/PostgreSQL      |
| `AIPAY_PUBLIC_ORIGIN=https://... pnpm run deploy:pilot`                                                   | 在域名/DNS/支付宝配置已获批时部署公共 HTTPS/Alipay Web 模式 |
| `AIPAY_PUBLIC_ORIGIN=https://... pnpm run deploy:smoke:pilot`                                             | 从公共 origin 验证 Web、Cookie、DB、metrics 和签名 callback |
| `pnpm run partner-kit:build -- <新目录>` / `pnpm run partner-kit:test`                                    | 生成 0.2.0 私有四包与仓库外 npm 安装验收                    |
| `pnpm run pilot:report -- pilot/manifest.json pilot/traffic.json pilot/reports/report.json`               | 逐笔核验真实流量、支付、交付、安全与接入指标                |
| `pnpm run pilot:review -- pilot/reports/report.json pilot/review-evidence.json pilot/reports/review.json` | 按固定门槛生成继续编排或收缩计量/账单的建议                 |

Agent/Merchant SDK 的角色边界见 [SDK README](./packages/sdk-ts/README.md)；可执行 HTTP/MCP 流程位于 `examples/paid-http-api` 与 `examples/paid-mcp-tool`。

## 目录结构

```text
apps/
  api/          HTTP API
  web/          管理控制台
  worker/       异步任务处理
examples/
  paid-http-api/          独立 HTTP 402 Merchant/Agent 示例
  paid-mcp-tool/          独立 MCP Merchant/Agent 示例
  agent-mcp-bridge/       外部 Agent 自托管 Streamable HTTP 支付桥
  merchant-http-adapter/ 外部 Merchant 自托管固定 JSON GET 适配器
packages/
  config/       运行配置加载与校验
  database/     PostgreSQL 访问、迁移与本地生命周期
  contracts/    共享接口契约
  payment/      支付通道抽象
  policy/       确定性授权策略
  sdk-ts/       TypeScript SDK
deploy/         Caddy、user-systemd、本地/外部闭测安装与 smoke
ops/            Prometheus 告警规则
pilot/          可提交示例；真实 Manifest/ledger/report/review 默认忽略
```

架构和选型记录按仓库策略仅保存在本地开发清单，不上传 `docs/` 目录。

## 常见问题

`pnpm` 不可用时，先确认 `node --version` 为 24.x，再运行 `corepack enable pnpm`。如果使用 NVM，新终端需要先在仓库根目录执行 `nvm use`。

依赖安装必须使用 `pnpm install --frozen-lockfile`。锁文件与依赖声明不一致时应修正并明确更新锁文件，不要在 CI 中关闭冻结检查。

API 或 Worker 抛出 `ConfigurationError` 时，按错误中列出的变量名检查 `.env`；错误不会包含被拒绝的原始值。

浏览器不信任 `aipay.localhost` 时，只把 `.local-state/caddy/data/caddy/pki/authorities/local/root.crt` 导入专用于本机闭测的客户端；不要关闭 TLS 校验，也不要把 internal CA 当作外部伙伴证书。

P11 条目保持未完成并不表示工程测试失败。P11 要求仓库外 Merchant/Agent、公共 HTTPS、非 Fake 支付、逐笔真实 workload ledger 和签署商业证据；`pnpm run test`、内部 adapter 或自动循环不能替代这些事实。具体准入与解除阻塞材料见 [PILOT.md](./PILOT.md)。

架构选型流水保存在本地 `DEVELOPMENT_CHECKLIST.md` 与 `docs/adr`；这两个路径按仓库策略不上传。可提交的长期边界同时体现在根安全/运行文档、独立小条目 Git 提交和 0.2.0 release 说明中。

## 持续集成

GitHub Actions 会在 push 和 pull request 上使用 Ubuntu 24.04 执行冻结安装、类型检查、Lint、格式检查、Gitleaks/敏感 sink 审计、Prometheus 规则校验和全部测试。Gitleaks、Promtool 与 Actions 均固定版本/提交和校验值；工作流只有仓库内容读取权限，不使用项目密钥，也不执行需要本机 CA/私有配置的部署 smoke。
