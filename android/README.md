# OMP Remote — Android app

Kotlin + Jetpack Compose (Material 3), package `app.ompr`, minSdk 28 / target+compile 35. Talks the protocol in
`../docs/PROTOCOL.md` (types mirrored in `app/src/main/java/app/ompr/data/Protocol.kt`).

## Build

```sh
export JAVA_HOME=~/toolchain/jdk ANDROID_HOME=~/toolchain/android-sdk
./gradlew :app:assembleDebug :app:testDebugUnitTest
# APK: app/build/outputs/apk/debug/app-debug.apk
```

`app/src/test/resources/test-vectors.json` is a copy of `../protocol/test-vectors.json`; `VectorsTest` reproduces every
vector (keys, AAD, framed payloads, hostId, roomId). Re-copy it when the protocol vectors change.

## Layout

| Package | What |
|---|---|
| `crypto/` | P-256 ECDH, HKDF-SHA256, AES-256-GCM (`Crypto`), Keystore-wrapped secrets (`KeystoreSecretBox`) |
| `net/` | relay socket (`Relay`), handshake + framing (`SecureChannel`), pairing, per-host connection with reconnect/ping/request correlation (`HostConnection`), session subscriptions (`SessionStore`), typed ops (`HostApi`), the `HostToolHandler` seam |
| `data/` | protocol models, host store (secrets wrapped by Android Keystore), settings, `SessionReducer` |
| `service/` | foreground `ConnectionService` ("Keep connected"), notifications, FCM `PushService` |
| `security/` | optional biometric gate (app open + approvals) |
| `tools/` | phone-as-agent-tools: `PhoneToolHandler` (policy, consent, budgets), `DeviceTools` (location, clipboard, notification, camera), `ToolRuntime` (confirmation requests + the on-screen activity) |
| `ui/` | Compose screens: hosts/pairing, dashboard, session, new-session wizard, settings |

## Key storage

The device private key exists only during pairing (to derive `K_dev`) and is zeroed afterwards. `K_dev` is stored
AES-256-GCM-wrapped with a non-exportable Android Keystore key (StrongBox when available), with the host id bound as
AAD. The phone never holds the relay room secret: pairing link v2 carries only the derived room id (`rid`), and the
host record stores just that. (Stores written by older builds don't decode and are dropped — re-pair.)

The biometric lock is an app-level gate in front of opening the app and approving tools. It is also required to
(a) loosen a running session's approval mode (anything weaker than the current one) and (b) start a session in
`write`/`yolo`. It costs nothing when the lock is off. Keystore user-auth-required keys are deliberately not used:
they would break background (push / foreground-service) connections.

## Pairing (docs/PROTOCOL.md §4)

* Link format `ompr://pair?v=2&name=…&rid=<22-char room id>&bpk=…&pt=…&r=…`. v1 links (and any link carrying `rs`)
  are rejected with a message telling the user to update the bridge.
* A scanned QR, pasted text or `ompr://pair` deep link **never starts pairing by itself**. The app first shows
  "Pair with <name>?", the relay hosts, and flags any cleartext `ws://` relay; only the **Pair** button connects.
* After the pair request is sent the app shows the 6-digit SAS (`Crypto.sasOf`, e.g. `230 428`) in a large card:
  it must equal the code printed on the PC. A `pair-no` is shown with its reason; a "busy / another device is pairing"
  reason adds the warning to treat the link as compromised.
* Malformed percent escapes in a link are a `ParseException`, not a crash. Pairing links are handed to the pair screen
  through `AppGraph.pairInbox` instead of the nav route, so names containing `%`/`+` are never decoded twice.

## Phone tools (docs/PROTOCOL.md §6.6)

A session started with "Let the agent use my phone" can call `phone_location`, `phone_clipboard_get`, `phone_clipboard_set`,
`phone_notify` and `phone_camera_photo`. Because an agent that reads untrusted content could be tricked into calling any of
them, **every tool is Off** until the user picks a mode in Settings → Phone tools:

| Mode | Behaviour |
|---|---|
| Off | the call is refused with an error. A capability group is advertised only while at least one of its tools is on, so a tool that is Off can still be visible to the agent when its sibling (e.g. clipboard read vs write) is on; the call is still refused |
| Ask each time | a confirmation dialog for every call (honours the biometric lock); denying starts a 60 s cool-down for that tool |
| Always allow | runs without asking (choosing it needs the biometric lock when that is on). Notifications have no Ask mode |

* Advertised capabilities (`location|clipboard|notify|camera`) follow the switches. Changing one makes the app re-handshake,
  because the bridge only learns them from HELLO.
* Android only lets the focused app read the clipboard, get a location fix reliably or take a photo. Such a call waits for
  the user to open the app and posts a "the agent wants to …" notification (generic text on the lock screen); it has a
  55 s budget, under the bridge's 60 s timeout.
* Location uses the platform `LocationManager` (no Google Play Services). The camera opens the system camera app; the
  photo is shrunk to ≤ 300 KB because `hosttool.result` must fit one 512 KiB frame.
* `phone_notify` is limited to 10 per minute; clipboard text to 20,000 characters.
* Android's `CAMERA` permission is declared (for the QR scanner), so the system camera path asks for it at first use.

## Connection robustness

Unauthenticated, junk or replayed frames from whoever holds the host seat never produce a terminal error: the channel is
dropped and `HostConnection` reconnects with exponential backoff ("Received data that could not be authenticated").
`ConnState.Fatal` is reserved for authenticated mismatches (host id / protocol) and a removed host.

## Privacy

* Notifications use `VISIBILITY_PRIVATE` with a redacted public version ("OMP Remote" / "Approval needed"); session
  titles and commands only show once the phone is unlocked.
* `FLAG_SECURE` is set on the window (blank recents thumbnail, no screenshots). Settings → "Hide content in recents"
  (default on) turns it off. Note this also blocks `adb screencap` while on.

## Push (FCM) — optional, off by default

The build succeeds without any Firebase files and push is then simply off (`BuildConfig.PUSH_ENABLED=false`; the app still
notifies while connected / while "Keep connected" is on). To enable wake-up pushes:

1. Create a Firebase project, add an Android app with package `app.ompr`, download `google-services.json` to
   `android/app/google-services.json` (it is git-ignored).
2. Rebuild. The Gradle script applies the `com.google.gms.google-services` plugin only when that file exists.
3. On the PC configure the bridge with a service account for the same project so it can send FCM HTTP v1 data messages
   `{w:"1", h:"<hostId>"}`. The app registers its token with `push.register` on every connect.

## Debug helpers

Debug builds accept `adb shell am start -a app.ompr.action.PAIR -n app.ompr/.MainActivity --es link 'ompr://pair?…'` to
open the pair confirmation without scanning a QR code; add `--ez autoconfirm true` to skip the confirmation (debug only).
`ompr://pair?…` links from a browser/terminal open the same confirmation and never auto-pair.

## Cleartext

`ws://` is allowed only for IP literals in loopback / RFC1918 / link-local / CGNAT (Tailscale) ranges (IPv6: `::1`, `fc00::/7`,
`fe80::/10`) and the emulator alias `10.0.2.2`; this is enforced in `RelayUrls.validate` (Android's network security config
can't express CIDR ranges). Host **names** never qualify — `.local`, `.lan`, `.ts.net`, `localhost` all need `wss://` —
because anyone on a network can claim a name. Everything else must use `wss://`.
