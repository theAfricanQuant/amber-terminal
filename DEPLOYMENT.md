# Deployment notes

Amber Terminal is a local Node.js application. The normal mode binds to `127.0.0.1` and keeps layout, watchlists, portfolio data and alerts in the local `data/` directory. Do not expose normal mode directly to the internet.

The public demo is an explicit, read-only deployment mode. It is not enabled by default and this repository change does not deploy it, change DNS, or change any production proxy/service configuration.

**Data-rights gate:** public mode can serve results from many third-party data and news providers, including (but not limited to) Yahoo Finance, Coinbase, Kraken, Binance, Nasdaq, Bloomberg RSS, CNBC, CBOE, SEC/EDGAR and FRED. A public host must not serve any provider's feed until the applicable terms and any required redistribution permissions have been confirmed, or that feed is removed/replaced with an appropriately licensed source. Passing tests and the repository MIT licence do not grant data rights.

## No-deploy preparation runbook

Run these checks on the candidate host without pointing public traffic at it:

```sh
cd /srv/amber-terminal
node --version                         # Node.js 18 or newer
node scripts/test.js                    # deterministic fixture/fake-network suite
node scripts/check.js
PUBLIC_DEMO=1 PUBLIC_DEMO_HOST=amber.sisengai.com \
HOST=127.0.0.1 PORT=3787 \
node server.js
```

`node scripts/test.js` deliberately launches each test file in a separate Node process and clears test-owned mode variables from the child environment. The tests that need fixture-only `QT_OFFLINE` behavior set it themselves; do not prefix the whole runner with `QT_OFFLINE=1`, because that disables fake-network regression cases that are still fully local.

The last command is a foreground rehearsal only. Stop it with `Ctrl+C`; do not run it while the production service is already using the port. The public-mode server must remain on loopback and should only be reachable through a TLS reverse proxy after the owner has separately reviewed the host, firewall, DNS, service, and provider terms.

## Public-demo environment

Use an environment file outside the repository, with permissions appropriate for the service account:

```dotenv
PUBLIC_DEMO=1
PUBLIC_DEMO_HOST=amber.sisengai.com
HOST=127.0.0.1
PORT=3787

# Optional bounded-load tuning; the defaults are deliberately conservative.
PUBLIC_RATE_LIMIT_MAX=120
PUBLIC_RATE_LIMIT_WINDOW_MS=60000
PUBLIC_CACHE_TTL_MS=5000
PUBLIC_CACHE_MAX=128
PUBLIC_CACHE_ENTRY_BYTES=524288
PUBLIC_CACHE_BYTES=8388608
PUBLIC_RATE_MAX_KEYS=10000
```

`PUBLIC_DEMO=1` refuses to start without a valid `PUBLIC_DEMO_HOST`. The request `Host` must match that configured hostname; arbitrary forwarded or direct host headers are not accepted. Public mode binds to `127.0.0.1` regardless of `HOST` so the application port is not a public listener.

Anonymous demo preferences are kept in each visitor's browser `localStorage`. The public server does not expose the shared `/api/state` route, and it must not be given a writable shared state directory for guest data. `PUBLIC_DEMO` is read when the server module is imported and cannot be switched by the exported `start()` override. Set it in the service environment before process startup; public-mode startup conditionally omits the local state, alert, and PTQ modules.

## Caddy example (not applied here)

Terminate TLS at Caddy and proxy only to the loopback listener:

```caddyfile
amber.sisengai.com {
    reverse_proxy 127.0.0.1:3787 {
        # The app accepts the configured Host and trusts client-IP forwarding
        # only because the connection peer is the loopback proxy.
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
    }
}
```

Do not publish `:3787`, bind the Node process to `0.0.0.0`, or trust `X-Forwarded-For` from an internet-facing peer. Keep the Caddy and Node processes on the same host and restrict the application port with the host firewall.

## Service, logs and rollback

A service manager is optional and must be reviewed before installation. A systemd shape is:

```ini
[Unit]
Description=Amber Terminal public demo
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=amber
Group=amber
WorkingDirectory=/srv/amber-terminal
EnvironmentFile=/etc/amber-terminal/public-demo.env
ExecStart=/usr/bin/node /srv/amber-terminal/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict


[Install]
WantedBy=multi-user.target
```

If a service is installed, inspect it before starting and use the service manager's normal commands. For systemd, logs are available with `journalctl -u amber-terminal-public-demo`; keep the environment file out of Git and redact credentials from copied logs.

Rollback is a controlled code change, not a data deletion:

1. Stop the service and leave `/var/lib/amber-terminal` intact.
2. Check out or restore the last reviewed application revision.
3. Run `node scripts/test.js` and `node scripts/check.js`.
4. Verify the candidate binds to loopback and rejects an incorrect `Host` header.
5. Start the service and inspect logs and the local health endpoint before any proxy/DNS change.
6. If the public demo must be disabled immediately, remove `PUBLIC_DEMO=1` from the service environment and keep the listener private; normal mode is not a public-safe fallback.

Do not use `git reset --hard` or delete the data directory as a rollback shortcut without an explicit backup and data-retention decision.

## Public-mode limits and provider caveats

Public mode permits only configured read-only market-data routes and bounded non-stateful computations. It denies shared state, alerts and alert SSE, webhooks, custom JavaScript, PTQ, shutdown, local diagnostics and document-body URL fetching. It also hides the corresponding UI functions and does not start alert polling/SSE in public mode.

The built-in controls are intentionally finite:

- 120 requests per client IP per 60 seconds by default, with bounded in-memory buckets.
- 5-second bounded response cache, capped by entry count and bytes.
- 500 chart bars per request.
- 25 quote symbols per request.
- 20 symbols, 6 rules and 8 indicators per public scan.
- Public backtests accept preset strategies only and daily or weekly bars.

These controls reduce, but do not eliminate, upstream load. Binance, Coinbase, Kraken, Nasdaq, Yahoo Finance, CBOE, SEC/EDGAR, Forex Factory, FRED and other providers can rate-limit, change, or withdraw endpoints. Their own terms, attribution rules and redistribution restrictions apply. Keep the app's provider notes accurate and do not promise live, complete, exchange-grade or permanently available data.

## Rights and attribution

Keep `LICENSE`, `NOTICE`, `public/vendor/lightweight-charts.LICENSE`, and the TradingView attribution/logo intact when copying or hosting the app. The repository's `LICENSE` identifies Amber Terminal as MIT-licensed Copyright (c) 2026 Lewis Jackson. `NOTICE` identifies TradingView Lightweight Charts as a separate Apache-2.0 component and states that the project is independent of TradingView. Market-data providers retain their own terms; the MIT license for this repository does not grant rights to provider data, feeds, trademarks, or third-party content.

This hardening review confirms that those files and chart attribution are present in the repository. It does **not** independently confirm the provenance or licensing history of every upstream/source archive, vendor payload, or provider dataset; that provenance remains uncertain and must be reviewed before a public launch. Do not overstate redistribution rights.
