# AIPay Merchant HTTP Adapter

This private pilot adapter lets an external API/MCP provider expose one real JSON GET capability through AIPay without changing its upstream service. The partner deploys and operates the adapter outside AIPay, owns the Merchant key, upstream credential, price, result quality, callback and evidence, and remains the service provider.

The adapter:

- returns a signed AIPay `Payment-Needed` requirement for the exact public GET URL;
- consumes a bound Payment Proof once and recovers the original Delivery after a crash;
- forwards only allowlisted query fields to one fixed public HTTPS upstream GET;
- injects one operator-held upstream API key in a configured header or query field;
- serializes each Proof with a PostgreSQL advisory lock and persists claim, consumption, result and receipt completion;
- retries from durable state without another charge, forwards `Idempotency-Key`, caps JSON at 256 KiB, forbids redirects, and signs a failed Receipt when upstream delivery fails.

Use only a low-risk, non-personal, non-financial capability for the first pilot. The persisted result exists solely for idempotent replay; protect the database and apply a reviewed retention policy after the pilot.

## Configuration

Run Node.js 24 behind an authorized HTTPS reverse proxy with a partner-controlled PostgreSQL database:

```dotenv
AIPAY_BASE_URL=https://pilot.your-domain.cn
AIPAY_MERCHANT_API_KEY=<aipay-api-key>
AIPAY_MERCHANT_ID=mch_<uuidv7>
AIPAY_MERCHANT_KEY_ID=key_<uuidv7>
AIPAY_MERCHANT_PRIVATE_KEY=<base64-pkcs8-ed25519>
AIPAY_SERVICE_ID=svc_<uuidv7>

AIPAY_ADAPTER_DATABASE_URL=postgresql://adapter:<password>@db.example.cn/adapter
AIPAY_ADAPTER_PUBLIC_ORIGIN=https://merchant.your-domain.cn
AIPAY_ADAPTER_RESOURCE_PATH=/v1/paid/weather
AIPAY_ADAPTER_QUERY_KEYS=city,date

AIPAY_UPSTREAM_ORIGIN=https://upstream.example.cn
AIPAY_UPSTREAM_PATH=/api/weather
AIPAY_UPSTREAM_API_KEY_LOCATION=query
AIPAY_UPSTREAM_API_KEY_NAME=key
AIPAY_UPSTREAM_API_KEY_VALUE=<partner-upstream-key>

AIPAY_ADAPTER_HOST=127.0.0.1
AIPAY_ADAPTER_PORT=3300
```

The upstream key never enters a model, AIPay, Payment Proof, result, error or committed file. The configured key name cannot overlap a model-controlled query field.

Start the adapter:

```bash
node --env-file=.env dist/index.js
```

Register the exact public resource URL in the external Agent bridge. Confirm a no-Proof request returns 402, one Proof returns real JSON plus a signed Receipt, replay returns the same stored JSON, a process restart recovers the same Delivery, and an upstream failure triggers the configured refund path.
