# AIPay Private Partner Release 0.2.0

Source artifacts are identified by both semantic version and the exact clean Git revision/SHA-256 in `KIT.json` and `SHA256SUMS`. They are private pilot packages, not npm publications or license grants.

## Packages

- `@aipay/contracts@0.2.0`: payment Contracts plus strict pilot Manifest, per-Transaction traffic ledger and review evidence Contracts.
- `@aipay/sdk-ts@0.2.0`: Agent/Merchant roles, HTTP 402/MCP protocol, Payment Proof consumption recovery and Provider action history.
- `@aipay/agent-mcp-bridge@0.2.0`: partner-hosted Streamable HTTP start/resume/deliver flow with URL-bound HMAC tokens.
- `@aipay/merchant-http-adapter@0.2.0`: partner-hosted fixed JSON GET 402/Proof/upstream/Receipt flow with durable PostgreSQL replay.

## Compatibility

- Node.js 24.x only.
- AIPay database migrations through `1787788831000` must be applied before the real pilot window.
- 0.2 artifacts must be installed together. Do not mix a 0.1 Contracts/SDK tarball with a 0.2 adapter.
- Distribute only the role adapter admitted for that partner, plus Contracts/SDK, through the approved private channel.

## Verification

Run `pnpm run partner-kit:test`, verify every tarball with `sha256sum --check SHA256SUMS`, and confirm `KIT.json.sourceDirty` is false before distribution. Preserve the kit directory and hashes with the partner evidence.
