# OMP Remote relay

A blind WebSocket relay implementing PROTOCOL.md §2 (wire-compatible with omp's collab `local-relay.ts`).
Two interchangeable implementations of the same contract:

| File | Runtime |
|---|---|
| `src/room.ts` | Pure room logic (no I/O) shared by both |
| `src/node.ts` / `src/cli.ts` | Node server (`ws`) — embeddable or standalone |
| `src/worker.ts` + `wrangler.toml` | Cloudflare Worker + one Durable Object per room (WebSocket Hibernation) |

## Contract summary

`GET /r/<roomId>?role=host|guest` (`roomId` = `[A-Za-z0-9_-]{10,64}`), `GET /healthz` → `200 ok`.

| Close code | Meaning |
|---|---|
| 4001 | room closed (host left; preceded by TEXT `{"t":"room-closed"}`) |
| 4004 | guest joined a nonexistent room |
| 4008 | room full (16 guests) — addition |
| 4009 | a host is already connected |
| 1009 | binary frame > 1 MiB |

Binary frames: `[uint32 BE peerId][payload]`. Host→relay: `0` broadcast, `N` targeted, forwarded unchanged.
Guest→relay: first 4 bytes overwritten with the sender's peer id. Host receives TEXT `peer-joined`/`peer-left`.
TEXT frames from clients are ignored. Peer ids are never reused within a room.

## Node server

```sh
npm install                 # in relay/
node src/cli.ts --port 7466 --host 127.0.0.1 [--trust-proxy] [--rate-limit 120]
curl localhost:7466/healthz
```

Embedding:

```ts
import { startRelay } from "./relay/src/node.ts";
const relay = await startRelay({ port: 7466, host: "127.0.0.1" }); // port 0 = ephemeral
relay.port; await relay.close();
```

Options beyond `port`/`host`: `rateLimit {max, windowMs}` (default 120 new connections / 60 s / IP → HTTP 429),
`maxGuestsPerIp` (default 8: simultaneous guest sockets per client IP, further ones → HTTP 429; hosts are not counted; CLI `--max-guests-per-ip`), `trustProxy` (use first `X-Forwarded-For` hop; enable ONLY behind your own proxy), `idleMs` (120 000: silent
connections are pinged), `pongTimeoutMs` (20 000: no pong → terminated), `maxGuests`, `maxFrameBytes`.

### VPS + systemd + Caddy

```sh
# as a normal user (never root)
git clone <repo> ~/omp-remote && cd ~/omp-remote/relay && npm ci --omit=dev
```

`/etc/systemd/system/omp-relay.service`:

```ini
[Unit]
Description=OMP Remote relay
After=network.target

[Service]
User=ompremote
WorkingDirectory=/home/ompremote/omp-remote/relay
ExecStart=/usr/bin/node src/cli.ts --port 7466 --host 127.0.0.1 --trust-proxy
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now omp-relay
```

Caddy (automatic TLS; WebSockets proxied by default) — `/etc/caddy/Caddyfile`:

```
relay.example.com {
    reverse_proxy 127.0.0.1:7466
}
```

nginx equivalent: terminate TLS (certbot) and in the `location /` block use
`proxy_pass http://127.0.0.1:7466; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade"; proxy_set_header X-Forwarded-For $remote_addr; proxy_read_timeout 3600s;`.
Clients then use `wss://relay.example.com`. Node needs ≥ 22.6 (type stripping); 26 is what was tested.

## Cloudflare Worker

Requires a free Cloudflare account (Durable Objects with SQLite storage are available on the free plan).

```sh
cd relay
npm install
npx wrangler login
npx wrangler deploy          # prints https://omp-remote-relay.<subdomain>.workers.dev
curl https://omp-remote-relay.<subdomain>.workers.dev/healthz
```

Use `wss://omp-remote-relay.<subdomain>.workers.dev` as the relay URL. Optional custom domain: add a
`routes = [{ pattern = "relay.example.com", custom_domain = true }]` entry to `wrangler.toml`.
Type-check: `npm run typecheck`.

Worker differences: no app-level ping timer (Cloudflare's edge handles liveness; hibernated rooms cost nothing),
and per-IP rate limiting and the per-IP concurrent-guest cap (`maxGuestsPerIp`) are NOT done in code: the Worker has no
reliable client-IP-scoped state, so add a Cloudflare dashboard rate-limiting rule on `URI Path starts with /r/`
(e.g. 120 requests/min per IP) and, if you can, a concurrent-connection limit. Room state is wiped when the host leaves.
The Worker was type-checked but could not be deployed/run in this environment (no Cloudflare account).

## Security model

The relay is **blind and untrusted**. All application traffic is end-to-end encrypted between phone and bridge
(PROTOCOL.md L1); the relay only forwards opaque ciphertext.

Can see: source IP/timing of connections, the room id (derived from key material, not a secret by itself),
frame sizes and timing, how many guests are connected and their relay-assigned peer ids, when the host connects.

Cannot see: any plaintext, session content, keys, device identity, or tool approvals. It never parses payloads
(only the 4-byte peer-id header). It cannot forge traffic: frames are authenticated/sealed under keys it never has,
so a malicious or compromised relay can drop, delay, or replay-attempt frames (replay is rejected by the protocol's
counters) but cannot read or inject. It can deny service. The peer-id rewrite means a guest cannot impersonate
another guest id at the transport level.

Operational hygiene: the node server logs nothing about frames; run it as an unprivileged user; keep it behind TLS
so the connection metadata and ciphertext are not exposed to the network path; use `--trust-proxy` only behind a proxy
that overwrites `X-Forwarded-For`.
