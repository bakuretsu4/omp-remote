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

## Releasing

A release build is minified (R8) and signed. The version comes from the tag, and `versionCode = major*10000 + minor*100 + patch`.

**Signing key (once).** Keep the keystore *outside* the repo and **back it up**: if you lose it, installed apps can never be updated, only reinstalled
(which wipes their paired PCs). Create it and a git-ignored `android/keystore.properties`:

```sh
keytool -genkeypair -storetype PKCS12 -keystore ~/.config/ompr-release/ompr-release.jks -alias ompr-release \
  -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=OMP Remote"
printf 'storeFile=%s\nstorePassword=...\nkeyAlias=ompr-release\nkeyPassword=...\n' ~/.config/ompr-release/ompr-release.jks > android/keystore.properties
```

With any of `storeFile storePassword keyAlias keyPassword` (or `OMPR_KEYSTORE_FILE OMPR_KEYSTORE_PASSWORD OMPR_KEY_ALIAS OMPR_KEY_PASSWORD`)
missing, `assembleRelease` makes an unsigned APK instead of failing (that is what CI does on pull requests).

**Local build and check:**

```sh
OMPR_VERSION=0.2.0 ./gradlew :app:assembleRelease          # app/build/outputs/apk/release/app-release.apk
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

**Try a release build safely** next to your real app (its own package, its own pairings) with `-PomprAppIdSuffix=.rc`.

**Publish with GitHub Actions** (`.github/workflows/release.yml`): add four repository secrets, then push a tag.

```sh
base64 -w0 ~/.config/ompr-release/ompr-release.jks | gh secret set OMPR_KEYSTORE_BASE64
gh secret set OMPR_KEYSTORE_PASSWORD   # and OMPR_KEY_ALIAS (ompr-release), OMPR_KEY_PASSWORD
gh variable set OMPR_CERT_SHA256 --body "<fingerprint from apksigner or keytool>"   # optional: abort if the wrong key signs
git tag v0.2.0 && git push origin v0.2.0
```

The workflow runs the unit tests, builds, checks the signature (and the pinned fingerprint if set) and attaches
`omp-remote-<version>.apk` plus a `.sha256` file to a GitHub Release.

**Installing over a debug build.** A debug and a release build are signed with different keys, so Android refuses to update one with the other:
uninstall the debug app first. That deletes its stored PC keys, so pair each PC again.

## Layout

| Package | What |
|---|---|
| `crypto/` | P-256 ECDH, HKDF-SHA256, AES-256-GCM (`Crypto`), Keystore-wrapped secrets (`KeystoreSecretBox`) |
| `net/` | relay socket (`Relay`), handshake + framing (`SecureChannel`), pairing, per-host connection with reconnect/ping/request correlation (`HostConnection`), session subscriptions (`SessionStore`), typed ops (`HostApi`), the `HostToolHandler` seam |
| `data/` | protocol models, host store (secrets wrapped by Android Keystore), settings, `SessionReducer` |
| `service/` | foreground `ConnectionService` ("Keep connected"), notifications, FCM `PushService` |
| `security/` | optional biometric gate (app open + approvals) |
| `tools/` | phone-as-agent-tools: `PhoneToolHandler` (policy, consent, budgets), `DeviceTools` (location, clipboard, notification, camera), `ToolRuntime` (confirmation requests + the on-screen activity) |
| `ui/` | Compose screens: home, PC list/pairing, PC detail (`dashboard`), session, new-session wizard, settings, usage, files and changes; `ui/theme` (colour, `Dimens`, PC palette), `ui/common` (shared widgets, formatting) |

## Screens and navigation

* **Home** (`home`, `ui/home/`) is the start destination as soon as one PC is paired (zero PCs keeps the pairing onboarding on `hosts`).
  It connects to *every* paired PC while visible (`rememberLiveHosts` → `rememberHostConnections`, released when it leaves composition)
  and merges their sessions: **Needs you** (status `waiting`, `pendingUi > 0`, or an unresolved approval / question from `attention.list`
  and live `hev` events; shows what is asked), **Running**, **Open** (idle managed and terminal sessions), then **Recent** grouped
  Today / Yesterday / Earlier (first 8, "Show more"). Chips filter by PC (hidden with one PC; each shows the PC colour and connection
  state). An unreachable PC gets a "<name> unreachable, tap to retry" banner and contributes no sessions; the others are never blocked.
  The *New session* button asks which PC first (bottom sheet) when several are paired and no chip is selected. Overflow menu: PCs, Settings.
* **PCs** (`hosts`): cards with a connection dot, open-session count, last connected time; removing asks for confirmation. Tapping a card opens
  the **PC detail** (`dash/{hostId}`, `DashboardScreen`): that PC's sessions with the same cards and sections, plus *Account usage* and
  *PC settings*; the back arrow returns to Home.
* **Session**: header with up-to-two-line title, PC tag and status chip; model / thinking / approval / context / cost chips; transcript with
  day/time labels, long-press menu (timestamp, copy, select text), tool cards with a state icon, a *Jump to latest* button; approval and
  question sheets name the PC, show arguments in a monospace block with copy, and a destructive Deny.
* **Settings** is grouped into titled sections; *Dynamic colour (Material You)* (default on, Android 12+) can be switched off to use the
  built-in palettes in `ui/theme/Theme.kt` (also what Android 11 and older always use).

Section / ordering / grouping / filter / empty-state logic is plain Kotlin in `ui/home/HomeLogic.kt` (tests: `HomeLogicTest`); PC colours are
assigned by `hostColorIndices` (stable per host id, collision-free, never recolours an existing PC) and generated from hues with fixed
lightness by `ui/theme/PcPalette.kt` (tests check >= 4.5:1 text contrast in both themes for any accent). Spacing and shapes come from `Dimens` / `OmprShapes`.

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
  55 s budget, under the bridge's 60 s timeout. The app is watched for the whole wait, so the notification also appears if
  the user leaves the app after the question was raised. Tapping it opens the confirmation.
* The system camera, a permission dialog or a notification tap all take the app off screen, and Android then withholds the
  network from a background app that has no foreground service (seen on a Pixel 7: the relay socket died the moment the camera
  opened). So a pending call holds the connection, and a call that needs the user or the screen runs the connection foreground
  service for its duration (reference-counted; skipped when "Keep connected" already runs it).
* A call can only *arrive* while the app is closed if "Keep connected" is on; otherwise Android drops the connection a few
  seconds after the app leaves the screen, which is why the clipboard, location and camera tools are best used with the app open.
* Location uses the platform `LocationManager` (no Google Play Services). The camera opens the system camera app; the
  photo is shrunk to ≤ 300 KB because `hosttool.result` must fit one 512 KiB frame.
* `phone_notify` is limited to 10 per minute; clipboard text to 20,000 characters.
* Android's `CAMERA` permission is declared (for the QR scanner), so the system camera path asks for it at first use.

## Continue on another PC (docs/PROTOCOL.md §6.9)

With two or more paired PCs, a managed session's menu (the Tune sheet) lists **Continue on \<PC\>**. After a confirm dialog the app
runs `net/PcHandover` (plain Kotlin, unit-tested with fakes in `PcHandoverTest`): read `features` of both PCs and pick the one
advertising `peer-sync` (the destination if both) → `sessions.stop` on the source → `peer.sync` (5 min wait) → `sessions.open
{sessionFile}` on the destination → navigate to it. If neither PC advertises `peer-sync` the dialog says what is needed and
nothing is stopped. A failure shows the step that failed with **Retry**, which resumes at that step (stop of an already gone
session counts as done). TUI sessions are disabled with an explanation, since the phone cannot stop them. The destination PC
does not have to be connected: the app dials it on demand (`ConnectedHandoverHost` holds its connection for the duration, up to 30 s to connect).
The sync summary does not say whether *this* session moved, so when it reports nothing copied the app tells you it opened the copy
already on the destination.

## Account usage, Files and Changes (docs/PROTOCOL.md §6.10)

Three screens that exist only for hosts whose `host.info` lists the matching feature (`HostInfo.supports`; an older bridge sends no
`features`, so it shows none of them):

* **Usage** (`usage`): PC detail screen → *Account usage* chip (`ui/usage/UsageScreen`). Accounts grouped by provider, one bar per limit
  coloured by severity, "resets in …", pull-to-refresh and a refresh button; loading, empty and error states. The bridge caches 60 s.
* **Files** (`files`): session top-bar overflow menu → *Files* (`ui/files/FilesScreen`). Browses the session's folder with `fs.list`,
  opens a file with `fs.read` in monospace with line numbers, with notices for truncated and binary files and a copy action.
* **Changes** (`git`): the same menu → *Changes* (`ui/files/ChangesScreen`). `git.status` as a list with status badges; a tap opens
  the file's `git.diff` with added / removed / hunk lines tinted (staged and unstaged switch for files that have both). Untracked files
  open in the file viewer instead (git has no diff for them). A folder outside any repository shows "Not a git repository".

Pure logic is plain Kotlin with JVM tests: usage formatting (`ui/usage/UsageFormat.kt`, `UsageFormatTest`), status-code decoding, diff-line
classification, path helpers (`ui/files/FileLogic.kt`, `FileLogicTest`), and the wire models (`data/Insights.kt`, `InsightsTest`).

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

## Push without Google (UnifiedPush) — works in every build

Settings → Push → **Wake-ups without Google**. You need a UnifiedPush distributor app on the phone; [ntfy](https://ntfy.sh/app) is the usual one
(Google Play, F-Droid or the ntfy.sh site; the public ntfy.sh server is fine because the wake carries no session data). Tap *Set up*, pick the
distributor, and the app registers the URL it is given with every PC that lists the `unifiedpush` feature (`push.register {provider:"unifiedpush"}`;
a PC gets one registration per phone and drops it when the push server reports it gone). When an approval or "done" alert appears and the phone is
not connected, the PC POSTs `{"w":"1","h":"<hostId>"}`; `UnifiedPushService` wakes, connects briefly, reads `attention.list` and posts local
notifications, exactly like the FCM path. Turning it off unregisters from the PCs. If FCM is also available, UnifiedPush wins while it is on.
The connector library is pinned to 3.0.10 because 3.1+ need a Kotlin 2.2 compiler (see `gradle/libs.versions.toml`).

## Debug helpers

Debug builds accept `adb shell am start -a app.ompr.action.PAIR -n app.ompr/.MainActivity --es link 'ompr://pair?…'` to
open the pair confirmation without scanning a QR code; add `--ez autoconfirm true` to skip the confirmation (debug only).
`ompr://pair?…` links from a browser/terminal open the same confirmation and never auto-pair.

## Cleartext

`ws://` is allowed only for IP literals in loopback / RFC1918 / link-local / CGNAT (Tailscale) ranges (IPv6: `::1`, `fc00::/7`,
`fe80::/10`) and the emulator alias `10.0.2.2`; this is enforced in `RelayUrls.validate` (Android's network security config
can't express CIDR ranges). Host **names** never qualify — `.local`, `.lan`, `.ts.net`, `localhost` all need `wss://` —
because anyone on a network can claim a name. Everything else must use `wss://`.
