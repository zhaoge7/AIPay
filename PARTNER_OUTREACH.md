# AIPay Design Partner Outreach

This package is ready to send after the repository revision and public pilot origin are authorized. Sending a message, publishing packages, pushing code, creating partner accounts, or exposing the local service are external actions and require the repository owner's approval.

## Selected Pair

### Merchant: Juhe Data

Juhe Data is the primary Merchant candidate because its current official catalog combines real API and MCP capabilities with explicit CNY per-call prices. Examples include IP risk at CNY 0.01/call, flight lookup at CNY 0.1/call, and train lookup at CNY 0.2/call. Its official site exposes both SSE and Streamable HTTP MCP endpoints, and its market-cooperation page publishes a business email and phone.

Official evidence:

- [API/MCP catalog and current prices](https://www.juhe.cn/docs/7)
- [MCP endpoint formats](https://www.juhe.cn/docs/api/id/1)
- [Company and capability profile](https://www.juhe.cn/about)
- [Sales and market-cooperation contacts](https://www.juhe.cn/contact)

Why it ranks first: exact P11 capability/price fit, CNY pricing, existing MCP distribution, China-hosted service, public commercial contact, and a useful low-risk data call that can support 1,000 legitimate Agent requests without handling sensitive identity data.

Recommended pilot service: a non-personal, non-financial data endpoint with a public per-call price, selected by Juhe. Do not choose identity, vehicle, phone, credit, or other personal-data APIs for the first pilot.

### Agent: FastGPT operator

FastGPT is the primary Agent candidate. Its official documentation supports consuming MCP tools and publishing applications through Streamable HTTP/SSE MCP. Its commercial page exposes a consultation form, promises a 1-3 business-day response, and explicitly offers paid third-party integration services.

Official evidence:

- [MCP tool consumption](https://doc.fastgpt.io/zh-CN/guide/build/tools/mcp_tools)
- [MCP application publishing](https://doc.fastgpt.io/zh-CN/guide/build/publish/mcp_server)
- [Commercial consultation and integration services](https://doc.fastgpt.io/zh-CN/guide/version/commercial)

Why it ranks first: China deployment fit, both sides of MCP, a visible operator/business path, and lower protocol impedance than a platform requiring a new language SDK.

The admitted Agent must be a FastGPT team or application operator outside AIPay, not an AIPay-maintained FastGPT instance. The operator owns its workload, private key, Mandate request, traffic attestation, and result acceptance.

### Agent fallback: Dify operator

Dify is the first fallback. Official documentation defines third-party Tool Plugins for Agent applications, and its partner program publishes `business@dify.ai` with a typical five-business-day response. It ranks below FastGPT for the first pilot because the current AIPay SDK is TypeScript while a native Dify plugin adds Python/plugin packaging work.

- [Dify Tool Plugin](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/tool-plugin)
- [Dify partner program](https://dify.ai/partners)

## Selection Score

| Candidate                | Role     | Real capability |     Explicit price |         Protocol fit | Reachable business path | First-pilot rank |
| ------------------------ | -------- | --------------: | -----------------: | -------------------: | ----------------------: | ---------------: |
| Juhe Data                | Merchant |            High |               High |     High (API + MCP) |                    High |                1 |
| SiliconFlow              | Merchant |            High | High (token based) |               Medium |                  Medium |                2 |
| FastGPT operator         | Agent    |            High |                N/A |           High (MCP) |                    High |                1 |
| Dify operator            | Agent    |            High |                N/A | Medium (Tool Plugin) |                    High |                2 |
| Unnamed TypeScript Agent | Agent    |         Unknown |                N/A |    High (direct SDK) |                None yet |                3 |

The score is an outreach priority, not admission evidence. P11 requires a named external operator to accept the pilot and later satisfy `PILOT.md`.

## Merchant Message

Subject: `设计伙伴邀请：聚合 API/MCP 的 Agent 按次人民币支付闭测`

> 聚合数据团队您好，
>
> AIPay 是面向 AI Agent 的人民币支付编排与审计层。我们希望邀请贵司作为首家 API/MCP 服务设计伙伴，用一个低风险、无个人信息的真实数据能力完成小额闭测。
>
> 试点保持贵司现有能力和定价为权威来源；贵司控制 Merchant 私钥、上游 API/MCP 凭据、履约结果和回调地址。AIPay 负责结构化授权、固定报价、支付宝沙箱/获批支付通道、幂等支付、Payment Proof、签名 Delivery Receipt、回调和审计。我们提供 Node.js 24 私有 SDK 套件、SHA-256、60 分钟接入支持和事故止付机制。
>
> 首期建议选择公开单次价格、无敏感个人数据的接口，先完成 1 笔端到端交易，再由真实 Agent 工作负载逐步达到 1,000 次有效调用。开发测试、循环和压测不计数。
>
> 希望确认：可试点的能力/单位/CNY 单价、技术对接人、可用 HTTPS 回调、是否允许以 AIPay Merchant 适配层交付，以及试点成功后对软件服务费或正式合作的意向。
>
> 技术材料：`PILOT.md`、私有 SDK kit、事故响应手册和试点记录模板可在确认保密渠道后提供。

Primary public routes: `info@juhe.cn` for pre-sales and `market@think-land.com` for market cooperation, as listed on Juhe's official contact page. Do not send credentials, tarballs, private repository links, or partner evidence in the first message.

## Agent Message

Subject: `设计伙伴邀请：FastGPT Agent 自主购买付费 API/MCP 闭测`

> FastGPT 团队/应用运营方您好，
>
> AIPay 为 AI Agent 提供结构化 Mandate、按次人民币支付、Payment Proof、交付签名和完整审计。我们希望邀请一个由贵方真实运营的 FastGPT Agent 作为首个 Agent 设计伙伴，调用一家外部付费 API/MCP 服务。
>
> 贵方 Agent 在 AIPay 仓库外运行并控制私钥与工作负载；用户明确签发 Merchant/品类/单笔/总预算/次数/有效期/人工确认阈值。AIPay 提供 Node.js 24 私有 SDK kit、HTTP 402/MCP 示例、全局止付和 60 分钟接入支持。
>
> 验收先完成 1 笔授权、非 Fake 支付、真实交付和审计，再在约定窗口内累计 1,000 次真实有用调用。自动循环、开发测试、重放和压测不计数。
>
> 希望确认：一个真实 Agent 场景、预期调用量、外部实现/部署证据、操作者、可接受的预算边界，以及试点成功后继续使用或付费集成的意向。

Use the FastGPT official commercial consultation form first. If no named operator accepts within three business days, send the fallback to `business@dify.ai` using the same evidence boundary and noting that a Dify-specific plugin would be scoped only after acceptance.

## Qualification Call

Accept a candidate only after a named authorized operator answers all of these:

1. What live capability or Agent workload is being operated, and who owns its result quality?
2. What exact unit and positive CNY price applies throughout the pilot window?
3. Which repository/deployed artifact is outside AIPay, and who controls its release and private keys?
4. Which requests are legitimate user/business work, and how are development, synthetic, loop, retry, and load-test calls excluded?
5. Can the operator provide an HTTPS callback or deployment, incident contact, and UTC availability window?
6. Are any personal, regulated, copyrighted, or confidential data involved? The first pilot must be low-risk and data-minimized.
7. Who can sign the pilot participation/paid-intent record, and what objective condition would trigger a software fee or formal commercial discussion?

Store answers in the private evidence system. Put only evidence URLs and hashes in `pilot/manifest.json`; do not commit names, emails, API keys, contracts, raw payloads, or signatures.

## Follow-up and Stop Rules

- Day 0: send one tailored message per primary role.
- Day 3: one factual follow-up if no response; activate Dify fallback for Agent.
- Day 5: close unresponsive lead and approach the next named operator. Do not repeatedly contact a person.
- Stop immediately if the candidate asks not to be contacted, cannot authorize the integration, proposes synthetic traffic, cannot name a price, requires sensitive-data scope, or will not control its own keys/workload.
- Once both roles accept, record evidence, obtain domain/payment authorization, deploy external mode, and start P11-01/P11-02 timers before sharing setup instructions.
