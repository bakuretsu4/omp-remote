# ompr — the OMP Remote bridge

`ompr` is the daemon that lets the OMP Remote phone app see and control your [omp](https://github.com/can1357/oh-my-pi)
sessions on this PC. It

- spawns `omp --mode rpc-ui` sessions on request (so you can start work from the phone even when no omp is running),
- attaches to live TUI sessions as a collab guest,
- speaks the end-to-end encrypted protocol in [`docs/PROTOCOL.md`](../docs/PROTOCOL.md) through a **blind relay**.
  Phone and PC both connect *out*; no VPN, no open inbound port (the embedded LAN listener is optional).

Node ≥ 24 (it runs `.ts` directly), no build step. Runtime dependencies: `ws`, `qrcode-terminal`.

```sh
cd bridge && npm install
node src/cli.ts init            # or: npm link  → `ompr init`
```

## Quick start

```sh
ompr init --name "Desk PC" --lan          # identity + ~/.config/ompr/config.json; --lan enables LAN-direct
ompr run                                  # the daemon (foreground), or install the service below
ompr pair                                 # prints a link + QR, valid 10 minutes, single use
```

Scan the QR in the app. `ompr pair` asks `Pair "<phone>"? [y/N]` on the terminal before it accepts the phone;
`ompr pair --no-confirm` skips the question (the link itself is the secret, treat it like a password for 10 minutes).
`ompr pair` talks to the running daemon through a unix socket (`ctl.sock`, mode 0600), so start `ompr run` first.

### Always-on (systemd user service)

```sh
ompr install-service
systemctl --user daemon-reload && systemctl --user enable --now ompr.service
loginctl enable-linger $USER              # keep it running when you are logged out
journalctl --user -u ompr.service -f
```

The unit bakes in the current `PATH` (so `omp` is found) and `OMPR_HOME` if set.

### Commands

| command | what |
|---|---|
| `ompr init [--force] [--name N] [--lan] [--relay URL]…` | create identity + default config (`--force` replaces the identity and un-pairs everyone) |
| `ompr pair [--no-confirm]` | pairing link + terminal QR |
| `ompr devices` | list paired devices (`[connected]`, `[push]`, `[REVOKED]`) |
| `ompr revoke <did>` | revoke immediately (unique prefix is enough); works with the daemon stopped too |
| `ompr status` | relays, connected phones, sessions |
| `ompr run` | the daemon |
| `ompr install-service` | write `~/.config/systemd/user/ompr.service` |
| `ompr doctor` | omp present and runnable, roots, relay reachability + host connect, FCM service account, `systemd-inhibit` |

State lives in `$OMPR_HOME` (default `~/.config/ompr`): directory `0700`, files `0600`.

## Config reference (`config.json`)

```jsonc
{
  "name": "Desk PC",                 // shown in the app
  "relays": ["wss://relay.example.com"], // WAN relays the bridge connects to AND advertises to the phone
  "lan": false,                      // also listen on 0.0.0.0:<lanPort>; advertise ws://<lan ip>:<lanPort> first
  "lanAddress": "192.168.1.20",      // override the detected LAN address in pairing links
  "localPort": 7466,                 // embedded relay, 127.0.0.1 only
  "lanPort": 7470,
  "roots": ["~"],                    // trees the phone may browse / start sessions in (realpath-checked)
  "omp": {
    "bin": "omp",
    "sessionsDir": "~/.omp/agent/sessions", // where `recent` sessions are listed from
    "sessionDir": null,              // pass --session-dir to every managed omp (also used for listing when set)
    "extraArgs": []                  // appended to every managed omp command line
  },
  "defaultApprovalMode": "always-ask", // always-ask | always-ask-cached | write | yolo (must be in allowedApprovalModes)
  "allowedApprovalModes": ["always-ask", "always-ask-cached", "write"], // yolo is OFF by default; add "yolo" here to allow it
  "inhibitSleepWhileWorking": true,  // hold systemd-inhibit sleep:idle while a managed session is mid-turn
  "fcm": { "serviceAccountPath": "/path/to/firebase-service-account.json" }, // optional, see Push
  "maxManagedSessions": 16,
  "tui": { "enabled": true, "control": false } // attach to live TUI sessions; control=false uses read-only (--view) links
}
```

Unknown or mistyped keys fail loudly at start. The bridge always passes `--approval-mode` explicitly; the phone chooses it
per session. Changing the approval mode of a running session restarts that session's omp process (same session file)
and is refused while a turn, dialog or tool is in flight (`busy`).

### Relays

The bridge always runs an embedded relay on `127.0.0.1:7466` and connects to it as the room host. With `lan: true` a second
relay listens on `0.0.0.0:7470` for the phone on the same Wi-Fi. WAN access needs a public relay (`relay/` in this repo;
deployable as a Cloudflare Worker or `node relay/src/cli.ts`) listed in `relays`. The relay only ever sees the room id,
connection timing and frame sizes.

### Attaching TUI sessions

TUI sessions are visible when their collab host talks to the **local** relay. In omp's settings:

```yaml
collab:
  relayUrl: ws://127.0.0.1:7466
  autoStart: control
```

By default `tui.control` is `false`, so the bridge attaches with a read-only (`--view`) link (`caps: ["stats"]`). Set
`"tui": { "enabled": true, "control": true }` to let a paired phone prompt, abort and answer dialogs in your live TUI sessions.
When the TUI releases the session lease (`sessions.handover`), the phone can continue it as a managed session.

### Push (optional, needs a Firebase project)

Set `fcm.serviceAccountPath` to a Firebase service-account JSON. When an attention item appears and **no phone is connected**,
the bridge sends one content-free FCM data message `{"w":"1","h":"<hostId>"}` to each device that registered a token
(`push.register`). The app wakes, connects, reads `attention.list` and builds notifications locally. Tokens FCM reports as
`UNREGISTERED` are dropped. Without the file, push is off and `ompr doctor` says so.

## Security model

- **Root of trust** is the per-device key `K_dev` derived at pairing (ECDH P-256 + HKDF over a one-time token). Every connection
  re-authenticates with it and adds an ephemeral ECDH, so a leaked `roomSecret` alone gives nothing (frames fail AEAD) and past
  traffic stays safe.
- A phone that is stolen or leaked equals remote code execution on this PC (it can start sessions and answer approvals). Use the app's
  biometric lock, keep `defaultApprovalMode` at `always-ask`, and `ompr revoke <did>` at once: revocation wipes `K_dev` on disk,
  stops processing frames from that device mid-connection, and the device gets **silence** (no error, no reply) from then on.
- Replay protection: HELLO checks `|now − ts| ≤ 5 min` and a 10-minute `nonceA` cache, and a channel is not counted as connected
  (push suppression, `lastSeen`, host-tool routing) until its first authenticated DATA frame. DATA frames carry a per-direction
  counter `q`; replays/out-of-order frames are dropped and three failures block that relay peer for the life of the relay connection.
  The AAD carries direction, so reflected frames fail. Frames are limited to 512 KiB plaintext.
- Pairing links (`v=2`) carry the derived `roomId` (never `roomSecret`), live in memory for 10 minutes, and are single-use.
  Both sides display a 6-digit code (`sasOf(pt, dpk, bpk)`) that binds the device public key to the prompt, so an observer who
  photographed the QR cannot substitute their own key undetected. Unauthenticated or malformed frames never burn the token and get no reply.
- By default `allowedApprovalModes` excludes `yolo`, so a compromised phone cannot silently switch a session to approval-free
  execution unless you explicitly add `"yolo"` to `config.json`.
- Known scope boundaries: all paired devices share one privilege tier; the relay host seat is unauthenticated (a party who learns
  `roomId` can cause a denial of service on that room, never decrypt or forge frames).
- Secrets are compared in constant time (`timingSafeEqual`), never logged (keys, plaintext, pairing token, FCM tokens).
- Filesystem access is limited to `roots`: every path is `realpath`-resolved and must stay under a root (symlinks and `..` cannot
  escape; links pointing out are hidden from listings). Uploaded files land in `<session cwd>/.ompr-inbox/` (0700, files 0600,
  sanitized names, never overwriting, symlinked inboxes refused, added to `.git/info/exclude`).
- Session files opened from the phone must live in omp's session directory and belong to a cwd under a root. `sessions.open` also refuses (`busy`)
  a session that another running omp still holds (typically an open terminal), using `omp session lease`, so two writers never share one session file.
- The daemon refuses to run as root.

## What the phone can do per session kind

| | managed | tui | recent |
|---|---|---|---|
| prompt / steer / abort | yes | prompt, abort | – |
| approvals + `ask` dialogs | yes | yes | – |
| model, thinking, fast, approval mode, compact, goal, todos, fork, btw | yes | no | – |
| queue remove/promote, subagent cancel/steer | yes | no / subagents | – |
| voice (`live.*`), phone tools | yes | no | – |
| `sessions.open` | – | – | → managed |

The summary's `caps` is authoritative; the bridge never advertises what it cannot do.

## Development

```sh
node --test bridge/                  # unit + hermetic daemon tests (fake omp, real relay, reference client)
npx tsc -p bridge/tsconfig.json      # typecheck
node bridge/e2e/live.ts              # live run against a running daemon + the real omp (spends a few tokens)
```

`test/e2e-client.ts` is a complete reference *app*: pairing, handshake, req/res/events on `protocol/src/crypto.ts` only.
