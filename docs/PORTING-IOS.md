# Porting OMP Remote to iOS

The Android app in [`android/`](../android) is the reference client. The bridge and relay are platform-neutral: **an iOS app only needs to speak the
wire protocol**. Nothing in `bridge/` or `relay/` has to change, except one optional addition for push (see "Push", below).

## 1. Source of truth, in order

1. [`docs/PROTOCOL.md`](PROTOCOL.md): normative. Relay transport (§2), crypto/pairing/handshake (§3–§5), operations and behaviour (§6).
2. [`protocol/src/index.ts`](../protocol/src/index.ts): every message, operation, event and capability as TypeScript types.
3. [`protocol/test-vectors.json`](../protocol/test-vectors.json): deterministic crypto vectors. **Reproduce every field before writing any UI.**
   Android does this in `VectorsTest.kt`; the bridge does it in `bridge/test/vectors.test.ts`.
4. [`bridge/test/e2e-client.ts`](../bridge/test/e2e-client.ts): a complete, small reference client (pairing, handshake, requests, events) in Node.
5. The Android code, for behaviour the spec leaves implicit (reconnect policy, snapshot-then-stream, rendering).

If the spec and the Android code disagree, the spec wins; please fix the disagreement in the same change.

## 2. Suggested order of work

1. **Crypto** + the vector test suite (XCTest). Nothing else works until all vectors match byte for byte.
2. **Relay socket** (`URLSessionWebSocketTask`): connect to `/r/<roomId>?role=guest`, 4-byte big-endian peer-id envelope (§2).
3. **Pairing + handshake** against a real bridge (your own relay; see the root README). Start with a command-line or unit-test harness, not UI.
4. **Models + session reducer**: decode `Ops`/events tolerantly, keep a `SessionView` the UI renders (see `data/Protocol.kt`, `data/SessionView.kt`).
5. **Screens**: hosts and pairing, dashboard, session (transcript, composer, approval sheet), new-session wizard, settings.
6. **Push** (section 5), then biometric lock, attachments, polish.

## 3. Crypto mapping (CryptoKit)

All of §3 of the spec maps onto CryptoKit. The tests will catch any mistake, but these are the usual traps:

| Spec | CryptoKit |
|---|---|
| P-256 ECDH, public keys as 65-byte uncompressed `04‖X‖Y` | `P256.KeyAgreement.PrivateKey/PublicKey`, `x963Representation` |
| Shared secret = the 32-byte X coordinate | `sharedSecretFromKeyAgreement`, then HKDF on that secret |
| `HKDF-SHA256(ikm, salt, info, L)` | `SharedSecret.hkdfDerivedSymmetricKey(using: SHA256.self, salt:, sharedInfo:, outputByteCount:)` when the IKM is an ECDH secret; `HKDF<SHA256>.deriveKey(inputKeyMaterial:salt:info:outputByteCount:)` when the IKM is the pairing token `pt` (pair key, SAS) |
| AES-256-GCM, 12-byte random IV, 16-byte tag, sealed = `IV ‖ ciphertext ‖ tag` | `AES.GCM.seal(_:using:nonce:authenticating:)`; the **`combined`** representation is exactly this layout |
| AAD = `"ompr1" ‖ type ‖ dir [‖ did for HELLO app→bridge]` | pass as `authenticating:` |
| SAS (6-digit code) | `sasOf` in `protocol/src/crypto.ts`; vector `derived.sas` |

Frame layouts, the `q` counters, key separation (`K_c2b` vs `K_b2c`) and the HELLO timestamp/nonce rules are all in §3–§5; follow them exactly. The bridge
silently drops anything that fails authentication, so a wrong byte shows up as "no answer", not as an error.

## 4. Android → iOS map

| Android | Role | iOS equivalent |
|---|---|---|
| `crypto/Crypto.kt`, `net/SecureChannel.kt` | primitives, frame sealing, handshake | CryptoKit + a `SecureChannel` actor |
| `crypto/KeyVault.kt` | wraps `K_dev` (and the other stored host secrets) with a Keystore key | Keychain item, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (push needs it readable while the phone is locked) |
| `net/Relay.kt` | OkHttp WebSocket to the relay, relay racing | `URLSessionWebSocketTask`; try relays in order, start the next after 1.5 s |
| `net/Pairing.kt` | link parsing, pairing handshake, SAS | same; custom URL scheme `ompr://` in `Info.plist` |
| `net/HostConnection.kt` | long-lived self-healing connection, request/response correlation, `session.open` resync | an actor with async/await requests and an `AsyncStream` of events |
| `net/ConnectionManager.kt`, `service/*` | foreground service, notifications, FCM | **no equivalent**: see section 5 |
| `data/Protocol.kt` | tolerant models (unknown kinds and fields ignored) | `Codable` with custom decoding; do not fail a whole frame on one unknown value |
| `data/SessionView.kt` | pure reducer: snapshot + events → UI state | a pure `reduce(_:_:)`; keep the Android unit tests as a spec |
| `security/BiometricGate.kt` | gate approvals and weaker approval modes | LocalAuthentication |
| `ui/**` (Compose) | screens | SwiftUI |
| `ui/hosts/QrScanner.kt` | CameraX + ML Kit | AVFoundation or VisionKit `DataScannerViewController` |
| `MainActivity` `FLAG_SECURE` | blank recents thumbnail, no screenshots | iOS has no equivalent flag: cover the window when the scene resigns active |

## 5. Where iOS is genuinely different

**Background execution and push.** Android can keep the socket open with a foreground service. iOS suspends the app and its sockets shortly after it
leaves the foreground, so the only way to learn "an approval is waiting" while the phone is locked is **APNs**. For the Android app, push is optional; for iOS it is the main notification path.

- The bridge currently only has an FCM sender (`bridge/src/push.ts`). iOS needs an **APNs sender**: HTTP/2 to Apple with a token-based key (`.p8`), ES256 JWT.
  Add it next to the FCM one and extend `Ops["push.register"]` (`provider: "fcm"` today) with `"apns"`. This is additive, and old clients keep working.
- Keep the design: the push carries **no content** (`{ "w": "1", "h": "<hostId>" }` today). On iOS the simplest version is a visible alert with generic text; a
  Notification Service Extension can wake briefly to connect, decrypt the real item with the stored key, and rewrite the notification. Share the Keychain item with the extension via an access group.
- Push capability and TestFlight/long-lived installs need a paid Apple Developer account; free provisioning is short-lived. Plan for that before promising friends a build.

**Transport security.** ATS blocks cleartext `ws://`. The relay should be `wss://`. LAN-direct (`ws://192.168.x.x`) needs `NSAllowsLocalNetworking` and a local-network permission prompt;
consider shipping `wss://` only. Android allows cleartext only for private IP literals; keep that rule if you add LAN mode.

**URL scheme.** Any app can claim `ompr://`. Never start pairing from a link or QR without a confirmation screen showing the host name and relay hosts, and always show the 6-digit code
(spec §4). The Android app does both; do not drop them.

**Lock-screen content.** Do not put approval text in a notification shown on the lock screen without the user opting in (`UNNotificationContent` with a generic body, details inside the app).

**Phone tools (optional, spec §6.6).** Skip them for a first release: a client that advertises no capabilities in HELLO simply never receives a `hosttool.call`. If you add them,
keep the Android policy (see `android/README.md`): every tool Off by default, a per-call confirmation mode, a cool-down after a refusal, and images shrunk to fit one 512 KiB frame.
The natural iOS pieces are CoreLocation, `UIPasteboard`, `UNUserNotificationCenter` and the camera; iOS limits background access and may prompt on pasteboard reads, so expect the same
"the app must be open" behaviour the Android app has (a notification that brings the user to the app).

## 6. Pitfalls found while building the Android client

- **Tolerate the unknown.** New event kinds, content-block types and fields are added over time (§8). Unknown values must be ignored, not fatal. Timestamps and `lastActivity` may arrive as floating-point numbers.
- **Resync = snapshot, then stream.** After every reconnect call `session.open` again; there is no replay buffer. Events delivered after the snapshot may repeat state it already contains (spec §6.2): they are idempotent whole values keyed by id, so apply them in order and let the reducer dedupe by key.
- **Grace-period flapping.** If you keep the socket only "while a screen needs it" with a short grace delay for navigation, make sure the stream is de-duplicated **after** the delay. The Android app
  had a bug where every screen change tore down and rebuilt the connection (`WantConnectedTest.kt` is the regression test).
- **Junk frames are not fatal.** A hostile or buggy relay can inject bytes. Drop the connection and reconnect with backoff; reserve a hard-failure state for "this host was removed" or a host-id mismatch.
- **Tool results carry images.** A `toolResult` message can contain `image` blocks (for example `read` on a PNG). Render them with the tool card; images are fetched on demand through `blob.get`.
- **Approvals.** An omp approval arrives as a `ui.request` of kind `approval`; the answer is the chosen option string. Never auto-approve. A request already pending at `session.open` is in
  `snapshot.pendingUi`, not re-sent as an event.
- **`q` counters and clocks.** The bridge rejects a HELLO whose timestamp is more than 5 minutes off. A phone with a wrong clock will look like a bridge that "does not answer".

## 7. Test plan

1. XCTest reproduces all of `test-vectors.json`.
2. Pair with a real bridge on your own relay, using the confirmation code (a mismatch must abort).
3. Reconnect after: relay restart, bridge restart, airplane mode, backgrounding for several minutes.
4. Start a session in `always-ask`, approve a `bash` call from the app, see the tool card and its output.
5. Open a Recent session, attach an image, interrupt a running turn.
6. Revoke the device on the PC (`ompr revoke <id>`): the app must go quiet, and a new connection attempt must get no reply.

The Android unit tests (`android/app/src/test`) are a good list of behaviours worth re-implementing as Swift tests.

## 8. Running the other side

You need your own bridge and relay; the repo owner's are private to them. See the root [`README.md`](../README.md): install omp and Node on a PC,
deploy the relay (a free Cloudflare account is enough), run `ompr init`, put the relay URL in the config, and `ompr pair`. The bridge has only been run on Linux. `ompr install-service` writes a systemd unit, so on macOS you would run `ompr run` yourself (untested).
