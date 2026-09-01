# @aipay/sdk-ts

The public TypeScript SDK exposes separate `AgentClient` and `MerchantClient` roles plus the AIPay HTTP 402 profile. Applications import only this package and stable Contract types; they do not read AIPay server source.

`AgentClient` signs requests with the registered Ed25519 Agent key, discovers services, creates idempotent transactions, executes or queries payment, receives Payment Proof, and retries paid HTTP resources. `MerchantClient` creates and signs Quote, emits `Payment-Needed`, verifies and consumes Payment Proof, and signs/submits Delivery Receipt.

Proof consumption remains one-time. If a Merchant process crashes after AIPay consumed the exact Proof but before it durably saved the returned Delivery ID, `recoverPaymentProofConsumption` performs an owner-bound, signature/binding-checked read of that original consumption. It never consumes an active Proof or creates another Delivery.

Private keys remain in the caller process. Pass base64 PKCS8 Ed25519 values through a protected local environment or secret manager and never log client options.

See the [repository startup guide](../../README.md) and the standalone projects under `examples/paid-http-api` and `examples/paid-mcp-tool`.

For a named design partner, AIPay maintainers create a private, checksummed tarball kit with `pnpm run partner-kit:build -- <new-directory>`. The partner installs both included archives in an independent Node.js 24 project. The kit is not a public npm release or a license grant.
