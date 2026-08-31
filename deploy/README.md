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

`aipay.localhost` is host-local and is not reachable by external design partners. A public deployment must replace the site address, use Caddy public ACME, configure DNS/firewall, move secrets to a service secret store, and rerun the smoke test from outside the host.
