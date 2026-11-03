# OMP Remote — Protocol v1 (normative)

Three pieces: **Android app** ⇄ (blind **relay**) ⇄ **bridge daemon** on the PC. The bridge spawns
`omp --mode rpc-ui` sessions and attaches to live TUI sessions as a collab guest. The relay never sees
plaintext. This file is the contract; `protocol/src/index.ts` holds the typed message shapes.
Where the two disagree, fix the disagreement in the same change.

## 1. Layers

| Layer | What | Where specified |
|---|---|---|
| L0 | Relay transport (WebSocket rooms, peer ids) | §2 |
| L1 | Secure channel: pairing, handshake, AES-GCM frames | §3–§5 |
| L2 | Application protocol: req/res/ev JSON | §6 + `protocol/src/index.ts` |

## 2. L0 — Relay transport (wire-compatible with omp's collab relay)

Exactly the contract of omp's `local-relay.ts`, so one relay implementation also serves TUI collab hosts.

- `GET /r/<roomId>?role=host|guest` → WebSocket. `roomId` matches `[A-Za-z0-9_-]{10,64}`.
- First host owns the room. A second host is closed with **4009**. A guest joining a missing room is closed with **4004**.
- Binary frames carry `[4B uint32 BE peerId][payload]`.
  - Host→relay: `peerId 0` broadcasts to all guests, `N` targets guest N. Forwarded unchanged.
  - Guest→relay: the relay overwrites the 4 bytes with the sender's peer id, then forwards to the host.
- Relay→host TEXT control: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
- Host disconnect: TEXT `{"t":"room-closed"}` to every guest, then close **4001**; the room is deleted.
- Clients never send TEXT. The relay ignores it.
- Additions (do not break collab compatibility): `GET /healthz` → `200 ok`; max binary frame **1 MiB** (larger → close 1009);
  max **16** guests per room; guests that send nothing for 120 s are pinged, then dropped if no pong;
  rooms are garbage-collected when the host leaves. Per-IP connection rate limiting is the relay's choice.

The embedded relay in the bridge listens on `127.0.0.1:7466` (for TUI collab hosts and the bridge itself)
and optionally on `0.0.0.0:7470` (LAN direct for the app). Same contract.

## 3. L1 — Primitives

- ECDH: **P-256**. Public keys travel as 65-byte uncompressed points `04‖X‖Y`, base64url (no padding).
  The shared secret is the 32-byte X coordinate.
- KDF: **HKDF-SHA256** (RFC 5869).
- AEAD: **AES-256-GCM**, 12-byte random IV, 16-byte tag. `sealed = IV ‖ ciphertext ‖ tag`.
- Hash: SHA-256. base64url = RFC 4648 §5 without padding.

### AAD
`AAD = "ompr1" ‖ type(1B) ‖ dir(1B) ‖ (type==0x01 && dir=='C' ? did(8B) : empty)`
where `dir` is ASCII `C` (app→bridge) or `B` (bridge→app).

### Frame payload (the bytes after the relay's 4-byte peer id)

| type | direction | layout |
|---|---|---|
| `0x00` PAIR | both | `00 ‖ sealed(pairKey)` |
| `0x01` HELLO | app→bridge | `01 ‖ did(8B) ‖ sealed(K_dev)` |
| `0x01` HELLO | bridge→app | `01 ‖ sealed(K_dev)` |
| `0x02` DATA | app→bridge | `02 ‖ sealed(K_c2b)` |
| `0x02` DATA | bridge→app | `02 ‖ sealed(K_b2c)` |

Plaintext of every sealed frame is UTF-8 JSON. Maximum **512 KiB** of plaintext per frame. Larger payloads
are an application problem: uploads are chunked (§6.5) and bridge results are paged or truncated.

## 4. Identity, room and pairing

**Bridge identity** (created by `ompr init`, stored `0600` in `~/.config/ompr/identity.json`):
- P-256 keypair `B`; `bpk` = public key.
- `roomSecret`: 32 random bytes.
- `hostId` = base64url(SHA-256(bpk))[0:11].
- `roomId` = base64url(HMAC-SHA256(key=roomSecret, msg="ompr/v1/room"))[0:22].
- The bridge connects to every configured relay as `role=host` on `/r/<roomId>`.

**Pairing link** (shown by `ompr pair` as text and QR; valid 10 minutes; single use):
```
ompr://pair?v=2&name=<url-encoded host name>&rid=<roomId>&bpk=<b64url bpk>&pt=<b64url 32B pairing token>&r=<relay wss/ws url>[&r=<another relay>...]
```
`rid` is the 22-character derived `roomId`; the permanent `roomSecret` never leaves the bridge. `v=1` links are rejected.
`r` repeats, ordered by preference (LAN first when available). The app tries them in order, concurrently
after 1.5 s.

**Pairing handshake** (the app first confirms the host name and relay list with the user, then connects as guest):
1. `pairKey = HKDF(ikm=pt, salt="ompr/v1/pair", info="pair", L=32)`.
2. App generates a device keypair `D` and sends PAIR frame, sealed with `pairKey`:
   `{"t":"pair-req","dpk":"<b64url D.pub>","label":"Pixel 8","ts":<ms>}`.
3. Both derive a 6-digit short authentication string `sas = HKDF(ikm=pt, salt=SHA-256(D.pub) ‖ bpk, info="ompr/v1/sas", L=4) mod 1_000_000`
   formatted `123 456`. The phone displays it while waiting. The bridge checks: token unused and unexpired, `ts` within ±5 min.
   Malformed or unauthenticated PAIR frames never consume the token. Unless started with `--no-confirm`, the bridge prompts
   `Pair "<label>" — code 123 456 — it must match the code shown on the phone. [y/N]` on the `ompr pair` terminal.
4. On accept it marks the token used and replies PAIR, sealed with `pairKey`:
   `{"t":"pair-ok","did":"<b64url 8B device id>","hostId":"…","name":"<host name>"}` (or `{"t":"pair-no","reason":"…"}`).
5. Both derive `K_dev = HKDF(ikm=ECDH(D.priv, bpk), salt=pt, info="ompr/v1/device", L=32)`. They then discard `pt`.
   The bridge stores `{did, label, dpk, K_dev, createdAt, lastSeen, revoked:false, push?}`.
6. The app stores `{hostId, name, roomId, bpk, did, K_dev, relays[]}`. `K_dev` is wrapped by an Android Keystore key.

## 5. Connection handshake (every connect)

The app connects as guest to `/r/<roomId>` on a relay, and then:

1. App → bridge HELLO: `{"t":"hello","eph":"<b64url A_eph.pub>","n":"<b64url 16B nonceA>","ts":<ms>,"caps":[…],"app":"0.1.0","label":"Pixel 8"}`
   sealed with `K_dev`; header carries `did`. Unknown or revoked `did`, `|now − ts| > 5 min`, a replayed `nonceA`
   (tracked for 10 min), or a HELLO for a different `did` on an already-open channel → the bridge closes the peer in silence.
2. Bridge → app HELLO: `{"t":"hello-ok","eph":"<b64url B_eph.pub>","n":"<b64url 16B nonceB>","host":{…HostInfo…}}` sealed with `K_dev`.
3. `okm = HKDF(ikm=ECDH(A_eph.priv, B_eph.pub), salt = K_dev ‖ nonceA ‖ nonceB, info="ompr/v1/session", L=64)`;
   `K_c2b = okm[0:32]`, `K_b2c = okm[32:64]`.
4. All further frames are DATA. Every plaintext JSON object carries `"q"`: a per-direction counter starting at 1.
   The receiver rejects `q` ≤ the last seen (replay) and blocks the peer for the life of the relay connection after 3 failures.
   The bridge does not mark the device connected (status, `lastSeen`, push suppression, host-tool routing) until the first
   authenticated DATA frame arrives, so a replayed HELLO cannot create a ghost connection.
5. The bridge keys sessions by relay peer id. When the relay reconnects or the peer id changes, the app must
   redo the handshake. The app reconnects with exponential backoff capped at 30 s.
6. Either side sends `{"t":"ping"}` every 25 s of silence. The peer answers `{"t":"pong"}`. 70 s of silence means dead.

Security notes: `K_dev` is the root of trust. A stolen phone is handled by `ompr revoke <did>` (immediate) and the
app's biometric lock. A leaked `roomSecret` alone gives nothing: frames fail authentication. Forward secrecy per
connection comes from the ephemeral ECDH. The relay learns only the room id, connection timing and frame sizes.

## 6. L2 — Application protocol

Plaintext message kinds (all JSON objects with `q`):

- `{"t":"req","id":<n>,"op":"<name>","a":{…}}` — app→bridge.
- `{"t":"res","id":<n>,"ok":true,"d":{…}}` or `{"t":"res","id":<n>,"ok":false,"e":{"code":"…","message":"…"}}` — bridge→app.
- `{"t":"ev","sid":"<session id>","n":<per-session index>,"e":{…SessionEvent…}}` — bridge→app, only for subscribed sessions.
- `{"t":"hev","e":{…HostEvent…}}` — bridge→app host-level events.
- `{"t":"ping"}` / `{"t":"pong"}`.

Error codes: `unauthorized`, `forbidden`, `not_found`, `invalid`, `busy`, `unsupported`, `forbidden_path`, `readonly`,
`session_closed`, `timeout`, `internal`.

Operations, argument/result shapes, event shapes and capability names are defined in `protocol/src/index.ts`
(`Ops`, `SessionEvent`, `HostEvent`, `Cap`). Behavioural rules follow.

### 6.1 Sessions
- `kind: "managed"` — the bridge spawned `omp --mode rpc-ui`. Full control.
- `kind: "tui"` — a live TUI attached as a collab guest (collab protocol v3). Limited to prompt, abort, UI
  answers, subagent chat/kill/revive, uploads, and read-only state. The summary's `caps` says exactly which.
  The bridge must never advertise a cap it can't honor.
- `kind: "recent"` — a persisted session file with no live process. `sessions.open` turns it into `managed`.
- `sessions.handover {sid}` (tui → managed): only when the TUI has released the session lease
  (`get_session_lease`). It opens the same session file in an RPC process and returns the new `sid`.
  When the TUI still holds it, it fails with `busy`.
- Session ids: managed `m_<random>`, tui `t_<instanceId>`, recent `r_<hash of file path>`.

### 6.2 Snapshot + subscribe (the only resume mechanism)
`session.open {sid}` returns `{snapshot, n}` and starts streaming `ev` frames with index `n+1…` to that peer.
The snapshot holds the normalized transcript tail (default last 200 messages, truncated blocks flagged),
state, queue, todos, goal, pending UI requests, and subagents.
The bridge may drop the oldest messages (`hasMore:true`) so the response fits one frame. `n` is the index of the last
event the bridge had emitted for that session when it started building the snapshot; events issued while the snapshot was
being built are delivered after the response with their own indices, so a client may see an event whose effect is
already inside the snapshot. Events are idempotent snapshots (`msg` carries the whole message, `state`/`queue`/`todos`
carry whole values) and `tool.*`/`ui.*` are keyed by id, so clients dedupe by key. A `ui.request` that was already
pending when the session was opened is in `snapshot.pendingUi` and is NOT re-sent as an event. `session.open` of a
`recent` sid is `invalid`; use `sessions.open {sessionFile}` first. After a reconnect the app calls it again. No
replay buffer exists. `session.close {sid}` stops streaming. `session.history {sid, before, limit}` pages older messages.

### 6.3 Normalized events
The bridge converts omp RPC events and collab frames into the same `SessionEvent` set:
- Streaming assistant messages are coalesced to at most 8 `msg` events per second with the full message
  snapshot. The final event has `final:true`.
- Tool output is truncated to 32 KiB per `tool.update`/`tool.end` with `truncated:true`. `tool.output {sid, callId}`
  fetches up to 256 KiB, paged.
- Images inside messages are replaced by `{type:"image", ref, mimeType, bytes}`. `blob.get {ref, off, len}` returns base64 chunks.
- `ui.request` normalizes approvals, asks and dialogs. For omp approval prompts (a `select` whose title starts
  with `Allow tool:`), `kind:"approval"` carries `{tool, detail, options[]}`. The answer is `ui.respond` with
  the chosen option string. All other dialogs map to `select|confirm|input|editor|ask`. The `ask` answer shape follows
  omp's `answers[]`.
- `attention` host events fire when: an approval or question arrives, an agent run yields (`done`), a session errors,
  a usage limit is hit, or a session has been idle after finishing for the first time.

### 6.4 Attention and push
The bridge keeps an attention inbox (last 200 items, persisted). `attention.list {since}` returns items.
When an item is created and no device is connected to the bridge, the bridge sends a content-free
FCM data message to each push-registered device: `{"w":"1","h":"<hostId>"}` and nothing else. The app wakes,
connects, calls `attention.list`, and builds local notifications from the decrypted items. The bridge sends FCM
directly (HTTP v1 with a service account in its config). The relay needs no push secrets.

### 6.5 Uploads
`upload.begin {name, mime, size, purpose}` → `{uploadId}`; `upload.chunk {uploadId, i, d}` (base64, ≤192 KiB raw);
`upload.end {uploadId}` → `{ref, path?}`. `purpose:"image"` yields a `ref` for prompt attachments (bridge converts
to omp `ImageContent`). `purpose:"file"` writes to `<session cwd>/.ompr-inbox/<ts>-<sanitized name>`
(created `0700`; the bridge adds `.ompr-inbox/` to `.git/info/exclude` when inside a git repo) and returns `path`.
`purpose:"file"` requires `sid` (the target session, which must be live); `ref` is then an opaque `f_…` token that
prompts accept like an image ref. Uploads belong to the device that began them, chunks must arrive in order
(`i` = 0,1,2…), `size` must match exactly, an idle upload expires after 10 minutes, and a device may have 8 in flight.
Images must be png/jpeg/gif/webp (sniffed). omp re-encodes attached images, so the image block in the transcript can be
smaller than the upload. Prompts carry `attachments:[{ref}]` (≤ 8). File attachments are appended to the text as
`\n\n[Attached file: <path>]`. Size limit 64 MiB per upload; the bridge rejects larger ones with `invalid`.

### 6.6 Phone as agent tools
The app advertises `caps` in HELLO (`location`, `clipboard`, `notify`, `camera`, `voice`). For managed sessions
with `hostTools:true`, the bridge registers `phone_*` host tools via `set_host_tools` while at least one capable
device is connected. A `host_tool_call` becomes a `hev` `hosttool.call {callId, sid, tool, args}` to that device.
The device answers `hosttool.result {callId, ok, content?, error?}`; `content` is a list of `{type:"text",text}` and
`{type:"image",data(base64),mimeType}`, and `ok:false` with an `error` string is how a device refuses. Unanswered after
60 s, the bridge returns an error result to omp. The whole `hosttool.result` request must fit one frame (512 KiB
plaintext), so a device shrinks images (the Android app targets ≤ 300 KB).
Tools: `phone_location`, `phone_clipboard_get`, `phone_clipboard_set`, `phone_notify`, `phone_camera_photo`.
Every tool needs a per-tool on-device switch (default off) and runtime permission, and the user can refuse. A device
advertises a capability only while at least one of its tools is enabled, and re-handshakes when that changes.
omp treats host tools as `exec`-tier, so in any approval mode that prompts for exec, each call first raises the normal
approval request (`ui.request` kind `approval`) and only runs once it is approved. The phone answers that like any other
approval; it is separate from the device's own per-call confirmation.

### 6.7 Voice
`live.connect {sid, sdpOffer, voice?, instructions?}` → `{sdpAnswer, voice}` passes straight to omp `live_connect`.
`live.stop {sid}`, `live.mute {sid, muted}`. `live.*` session events carry omp's `live_phase|live_transcript|live_end`.
Managed sessions only.

### 6.8 Filesystem and projects
`fs.roots` lists configured roots. `fs.list {path}` lists directories (and optionally files) beneath a root.
Every path is `realpath`-resolved and must remain under a root, otherwise `forbidden_path`. Default root: `$HOME`.
`sessions.create {cwd,…}` requires `cwd` under a root.
Session files named by `sessions.open` must live in omp's session directory (config `omp.sessionsDir`, default
`~/.omp/agent/sessions`) and their recorded cwd must be under a root. `session.fork` leaves the source session as it was and
opens the fork as a **new** managed session (`{sid}` is the new one). `session.set {approvalMode}` restarts that session's omp
process on the same session file (omp cannot change it live) and answers `busy` while a turn, dialog or tool is running.
`sessions.stop` is only for managed sessions (`readonly` otherwise). `devices.revoke` of the calling device still answers
that request, then the device gets silence.

## 7. Bridge behaviours (non-wire)
- Refuse to run as root. All state under `~/.config/ompr/` (`0700`, files `0600`).
- `inhibitSleepWhileWorking` (default true): hold `systemd-inhibit --what=sleep:idle` while any managed session is
  running a turn. Release when all settle.
- Never log plaintext frames, keys or the pairing token.
- Managed sessions start with the approval mode the app chose (`always-ask` default in the UI; omp's own
  default is `yolo`, which prompts for nothing).
- `ompr` CLI: `init`, `pair [--no-confirm]`, `devices`, `revoke <did>`, `status`, `run`, `install-service`, `doctor`.
- The CLI talks to the running daemon over a unix socket `ctl.sock` (0600, newline-delimited JSON; not part of the wire protocol).
  Pairing tokens exist only in the daemon's memory, so `ompr pair` requires `ompr run`.
- Embedded relay: `127.0.0.1:localPort` (default 7466) and, with `lan:true`, `0.0.0.0:lanPort` (default 7470). They are separate
  relay instances, so the bridge connects to each as host. The pairing link lists `ws://<lan ip>:<lanPort>` first, then the
  configured WAN relays.

## 8. Versioning
`HostInfo.proto` = 1. The app refuses a different major. New ops/events are additive. The app ignores unknown
event kinds and fields. The bridge answers unknown ops with `unsupported`.
