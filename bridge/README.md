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
  "allowedApprovalModes": ["always-ask", "always-ask-cached", "write"], // yolo is OFF by default; add "yolo" here to allow it. Reported in host.info, so the app only offers these
  "inhibitSleepWhileWorking": true,  // hold systemd-inhibit sleep:idle while a managed session is mid-turn
  "fcm": { "serviceAccountPath": "/path/to/firebase-service-account.json" }, // optional, see Push
  "maxManagedSessions": 16,
  "tui": { "enabled": true, "control": false }, // attach to live TUI sessions; control=false uses read-only (--view) links
  "peer": {                          // optional companion PC to mirror sessions to, see "Peer sync"
    "ssh": "my-server",              // key-based `ssh my-server` + rsync on both machines
    "ompBin": "~/.local/bin/omp",    // omp on the peer (needs `omp session lease`)
    "syncProjects": true,            // also mirror each session's project folder
    "intervalSec": 300               // periodic catch-up; 0 = only on turn end, session close, startup
  },
  "backup": {                        // optional local-disk backup of sessions + blobs, see "Backups"
    "dir": "/mnt/hdd/ompr-backup",   // absolute path of an EXISTING writable folder; never created for you
    "intervalSec": 3600,             // 0 = only at startup and after finished turns
    "keep": 7                        // daily snapshots to keep (1..365)
  }
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

### Peer sync (keep working while this PC is off)

With `peer` set, the bridge mirrors omp's session files (`~/.omp/agent/sessions`), their image blobs and, optionally, each
session's project folder to a second always-on machine over SSH + rsync. Run a bridge on that machine too (paired with the
phone as another PC) and you can open the same session from the phone while this PC is off. When this PC comes back it
pulls whatever the peer advanced. Sync runs at startup, after every finished turn, when a session closes, and every
`intervalSec`. `ompr sync` does one run and exits.

Rules the sync follows:

- **Lease-safe, fails closed.** A session held by a running omp (`omp session lease`, on either machine) is never overwritten
  on that machine, and ids the lease check cannot classify count as held. If the lease check cannot run at all, nothing is synced.
- **Longer transcript wins** (same length: later mtime). Transcripts are append-only, so this never drops entries unless
  both machines appended while disconnected; in that case the shorter fork is replaced, so do not edit one session on both
  machines at once.
- **Projects:** files newer on the sender overwrite (`rsync --update`), nothing is deleted, and `node_modules`, `build`,
  `.gradle`, `target`, `.venv`, `__pycache__`, `.wrangler` are skipped. A folder is mirrored only when it is under `roots`,
  is not a root itself (`~`, `/tmp`) and has no dot-directory component (`.ssh`, `.config`, `.omp`, ...). `.git` is mirrored
  as plain files, so commit/push from one machine at a time.
- The peer needs `rsync`, `python3`, `omp` and the same absolute path for `~` (session headers store absolute `cwd`).
- Login is **not** synced. Sign in on the peer separately: run `ssh -tt peer '~/.local/bin/omp auth-broker login anthropic'`, open the URL it prints,
  approve, and paste the address of the page that fails to load (`http://localhost:54545/callback?code=...`) into the waiting prompt. This needs no port
  forwarding, so it works when the peer's sshd has `AllowTcpForwarding no`; `login --via=user@peer` does need forwarding, and a non-interactive ssh may not have `omp` on `PATH`.
  Copying the vault would let two machines refresh the same OAuth token and invalidate each other.

**From the phone.** A bridge with `peer` advertises `peer-sync`, and the app's session menu offers **Continue on \<other PC\>**:
it stops the session where it runs (a running session holds the lease and syncs skip held sessions), runs `peer.sync` on a
PC that advertises `peer-sync` (the destination when both do), then opens the session file on the destination. The bridges
must be configured as each other's `peer`, and both need the same session directory (`omp.sessionsDir`) path. If neither
bridge has a `peer`, the app says so and stops nothing. Terminal (TUI) sessions cannot be moved: they cannot be stopped from the
phone. `peer.sync` always runs a sync that starts after the request, waits up to 15 min, and reports
`sync with the peer failed: …` (one line) when ssh or rsync fail.

### Backups (a second copy on a local disk)

With `backup` set, the bridge copies omp's `sessions` folder and its sibling `blobs` folder into daily snapshot folders
`<dir>/YYYY-MM-DD/{sessions,blobs}` with `rsync -a --link-dest=<newest older snapshot>`: files that did not change are hard
links, so a snapshot costs only what changed, and every snapshot is a complete, browsable copy. It runs at startup, every
`intervalSec`, and a few seconds after a finished turn or closed session; today's snapshot is updated in place. `ompr backup`
does one run and exits; `ompr status` shows the last result.

- The source is only read. Nothing inside a snapshot is deleted: a session you delete today is still in today's snapshot and is
  absent from tomorrow's. Retention removes only folders named exactly `YYYY-MM-DD` beyond the newest `keep`; anything else in
  `dir` is never touched.
- `dir` must exist: the bridge creates only the final `<dir>/YYYY-MM-DD` folder, never `dir` or its parents. It refuses to
  start the backup (one log line, backup stays off until restart) when `dir` is not an absolute path, does not exist, is not a
  writable folder, is inside omp's sessions or blobs folder, or contains them. If the disk is unmounted later, a run fails with
  "does not exist" and the next one retries. Mind that a mount point that exists while nothing is mounted is just a folder on the
  system disk.
- A transcript that is still being written can be copied up to a half-written last line; the next run copies the rest, and a
  finished turn triggers one.
- Needs `rsync`. Login credentials are not part of `sessions`/`blobs` and are not backed up.

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

### Push without Google (UnifiedPush)

Nothing to configure on the PC: any paired phone whose app registers a UnifiedPush endpoint (see `android/README.md`) gets the same
content-free wake over plain HTTPS, via the distributor app on the phone (ntfy is the usual one; the public `ntfy.sh` works, and the
message contains no session data). Only public `https` endpoints are accepted, so a paired phone cannot make the bridge call anything
on your network. `ompr status` shows the push line; a registration the push service reports as gone is dropped automatically.

### Usage, files and git

Three optional features, listed in `host.info` `features` only when they can work, so the app shows the matching menu entries
only for hosts that offer them (details: docs/PROTOCOL.md §6.10):

- **`usage`**: account quota windows. The bridge runs `<omp.bin> usage --json` (60 s timeout, answers cached for 60 s) and maps it
  to accounts with per-limit used fraction and reset time. Listed when `omp usage --help` exits 0 at startup, so an old omp simply
  does not offer it. The output contains your account e-mails; the bridge never logs it.
- **`files`**: `fs.read` shows a text file (128 KiB by default, 256 KiB at most; binary files are reported, not sent) from under `roots`.
- **`git`**: `git.status` / `git.diff` for a session's folder. Listed when `git --version` works. Needs git on the PC's `PATH`
  (`/usr/local/bin:/usr/bin:/bin` is what the bridge hands to git). Submodules are not descended into, and clean/smudge filters
  defined in a repository's own config are disabled for these calls (git-lfs from your global config keeps working).

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
- `fs.read`, `git.status` and `git.diff` (the phone's Files and Changes screens) are read-only, go through the same `realpath` check,
  cap file reads at 256 KiB and git output at 200 KiB, and spawn git with fixed argv and a scrubbed environment. A repository's own
  config cannot run programs through them (`core.fsmonitor`, `core.pager`, `diff.external`, textconv, `filter.*` clean/smudge/process
  are all switched off for these calls; `test/files.test.ts` proves it with marker files). A repository whose work-tree root lies
  outside `roots` is refused.
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
