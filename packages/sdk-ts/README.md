# @aipay/sdk-ts

The public TypeScript SDK exposes separate `AgentClient` and `MerchantClient` roles plus the AIPay HTTP 402 profile. Applications import only this package and stable Contract types; they do not read AIPay server source.

`AgentClient` signs requests with the registered Ed25519 Agent key, discovers services, creates idempotent transactions, executes or queries payment, receives Payment Proof, and retries paid HTTP resources. `MerchantClient` creates and signs Quote, emits `Payment-Needed`, verifies and consumes Payment Proof, and signs/submits Delivery Receipt.

Private keys remain in the caller process. Pass base64 PKCS8 Ed25519 values through a protected local environment or secret manager and never log client options.

See [the repository quickstart](../../docs/quickstart.md) and the standalone projects under `examples/paid-http-api` and `examples/paid-mcp-tool`.
