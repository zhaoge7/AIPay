# AIPay Prometheus Rules

`aipay-alerts.yml` contains the closed-test alert rules. Validate changes with:

```bash
pnpm run monitoring:check
```

Prometheus 3.14.0 `promtool` is the validation baseline. CI downloads the official Linux amd64 release and verifies SHA-256 before use.

Configure the AIPay API target with a 15-30 second scrape interval. Store the Bearer value in a root-readable file outside the repository and use Prometheus `authorization.credentials_file`; do not place `AIPAY_METRICS_TOKEN` in Prometheus YAML or command arguments. Load `aipay-alerts.yml` via `rule_files` and send rule alerts to Alertmanager. Notification receivers and secrets belong in the deployment secret store.

The endpoint is `/internal/metrics`. It intentionally exposes aggregate values only and returns 401 without the correct Bearer token.
