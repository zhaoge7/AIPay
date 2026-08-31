# AIPay Agent MCP Bridge

This private pilot bridge lets an externally operated FastGPT-compatible Agent use AIPay through MCP Streamable HTTP. It is not an AIPay-hosted Agent: the partner deploys the bridge outside the AIPay repository, owns its Agent private key and workload, and configures the MCP URL/Bearer header in its Agent platform.

The bridge exposes three tools:

- `aipay_start_paid_get` requests one preconfigured HTTPS resource path and starts the exact Quote/Transaction/payment flow;
- `aipay_resume_payment` queries a payment after a provider redirect/action and issues a Payment Proof only after success;
- `aipay_deliver_paid_get` presents the signed proof to the original resource URL and returns a bounded JSON result.

Resume and delivery tokens are HMAC authenticated, expire, and bind the Payment Attempt/Transaction/Proof to the exact resource URL. The model cannot select another origin, path, or query key. The AIPay Mandate independently restricts Merchant, category, amount, count, validity, and confirmation threshold.

## Configuration

Run on Node.js 24 behind an authorized HTTPS reverse proxy. Keep this protected environment outside Git:

```dotenv
AIPAY_BASE_URL=https://pilot.your-domain.cn
AIPAY_AGENT_ID=agt_<uuidv7>
AIPAY_AGENT_KEY_ID=key_<uuidv7>
AIPAY_AGENT_PRIVATE_KEY=<base64-pkcs8-ed25519>
AIPAY_MANDATE_ID=mdt_<uuidv7>

AIPAY_RESOURCE_ORIGIN=https://merchant.example.cn
AIPAY_RESOURCE_PATHS=/v1/paid/weather
AIPAY_RESOURCE_QUERY_KEYS=city,date

AIPAY_BRIDGE_BEARER_TOKEN=<high-entropy-secret>
AIPAY_BRIDGE_HOST=127.0.0.1
AIPAY_BRIDGE_PORT=3200
AIPAY_BRIDGE_ALLOWED_HOSTS=bridge.your-domain.cn
AIPAY_BRIDGE_ALLOWED_ORIGINS=bridge.your-domain.cn
```

`AIPAY_RESOURCE_ORIGIN` must resolve only to public-unicast addresses. Paths and query names are exact comma-separated allowlists. Tool input cannot add headers, credentials, methods, bodies, arbitrary URLs, or redirects. Results must be JSON and are capped at 256 KiB.

Start the bridge:

```bash
node --env-file=.env dist/index.js
```

Configure the external Agent's Streamable HTTP MCP endpoint as `https://bridge.your-domain.cn/mcp` with `Authorization: Bearer <token>`. Do not put the token in a URL, prompt, tool argument, repository, screenshot, or evidence record.

When a payment action is required, show the returned redirect URL only to the authorized user. Call `aipay_resume_payment` with the opaque token after completion, then pass its delivery token to `aipay_deliver_paid_get`. Do not let the model infer, edit, decode, or persist token contents.
