# Closed-Test Deployment

The local closed-test environment runs:

- Node.js 24.19.0 API on loopback port 3101;
- built React console behind Caddy 2.11.4;
- HTTPS at `https://aipay.localhost:8443` using Caddy's internal CA;
- PostgreSQL 18.6 in the pinned development container;
- the Webhook Worker with the Caddy CA loaded through `NODE_EXTRA_CA_CERTS`.

Install Caddy 2.11.4 from its official GitHub release. The Linux amd64 archive SHA-512 is:

```text
8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9
```

Then run:

```bash
pnpm run deploy:local
pnpm run deploy:smoke
```

The installer writes user-systemd units under `~/.config/systemd/user`, enables them, and starts API, Caddy, then Worker. It does not modify system trust. The local CA is stored at `.local-state/caddy/data/caddy/pki/authorities/local/root.crt`; import that certificate only into clients intended for this closed-test host.

Inspect without exposing environment values:

```bash
systemctl --user status aipay-api aipay-caddy aipay-worker
journalctl --user-unit aipay-api --user-unit aipay-caddy --user-unit aipay-worker
```

`aipay.localhost` is host-local and is not reachable by external design partners.

## External Pilot Mode

External mode is only for an authorized design-partner host. Before starting it:

- assign a public FQDN whose DNS resolves to this host and allow inbound HTTPS/ACME traffic;
- set `AIPAY_PUBLIC_ORIGIN` to the bare `https://` port-443 origin;
- configure the protected `.env` with Alipay Web sandbox/production app ID, seller ID, PKCS8 RSA private key, Alipay public key and notify URL;
- make `AIPAY_ALIPAY_NOTIFY_URL` exactly `<origin>/v1/payments/alipay/webhook`;
- review callback destinations, partner authorization, incident contacts and secret custody.

Deploy and verify:

```bash
AIPAY_PUBLIC_ORIGIN=https://pilot.your-domain.cn pnpm run deploy:pilot
AIPAY_PUBLIC_ORIGIN=https://pilot.your-domain.cn pnpm run deploy:smoke:pilot
```

The installer renders one Caddy config from the explicit mode. `local` fixes internal CA + Fake Provider + loopback callback allowance. `external` rejects localhost/reserved/non-443 origins, uses Caddy public ACME + Alipay Web Provider, requires the exact notify URL and removes the Worker's loopback exception. API and Worker derive these choices again at runtime instead of trusting independent Provider/SSRF flags.

Do not use a temporary tunnel, Fake Provider or internal Agent/service to claim P11 external evidence. Run the smoke test from an external network before admitting a partner, then follow [the pilot runbook](../PILOT.md).
