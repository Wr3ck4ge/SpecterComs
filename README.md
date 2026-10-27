# SpecterComs

SpecterComs is a Windows voice and text comms client for large in-game teams: orgs and squads (built with Star Citizen in mind) that have outgrown a flat Discord server. It combines channel voice and chat, a leadership net that cuts through background chatter, an operations planner, Star Citizen ship and hangar tooling, and an in-game stream overlay in one client.

Website: **https://spectercoms.net**

This isn't open source: there's no licence here for reuse or redistribution. The code is published so anyone can check what the app actually does instead of taking our word for it, including how data is handled, what is encrypted, and what the server can and can't see. It's exported from a private working repo, so history here is a series of snapshots rather than every commit. Deployment secrets, API keys, signing keys, certificates and internal infrastructure config are stripped before export. Nothing here is a live credential.

## What's new in 2.0

- **Tray-bar UI.** The client is now a compact bar that docks above the Windows taskbar. Each feature opens as a cabinet above the bar, so the client takes almost no screen space while you play.
- **End-to-end encrypted voice on every channel.** Voice uses MLS-derived keys everywhere. The server no longer mixes or decodes audio, and pre-2.0 clients are refused voice.
- **Leadership frequency.** Each event has a leadership net whose transmissions take priority over other channels.
- **Adaptive voice activation**, tuned to the noise floor, alongside push-to-talk.
- **Operations planner and event view**, with a tree-first layout for groups, ships, roles and frequencies.
- **2.0.1:** MLS self-healing (a device that falls out of a group rejoins by external commit), chat catch-up after time offline, per-account local identity and history, voice key continuity across rekeys, and shared event contracts with automated tests and CI.

## Features

- **Tray bar and cabinets.** Channels, Operations, Notifications, Games and Settings cabinets open above the bar. Voice controls, the active org and stream controls live on the bar itself.
- **Voice.** Push-to-talk or adaptive voice activation, and priority ducking: when someone with priority transmits, other audio steps down on each listener's own machine.
- **Leadership frequency.** Event leadership can talk across the event's frequencies without everyone sharing one channel.
- **Text and DMs.** Org channels, event channels and direct messages, with history synced between your devices and caught up after you've been offline.
- **Operations.** A planner for building an event (groups, roles, ships, frequencies, schedule) and an event view for running it: who is signed up, where they are assigned, and which nets they are on.
- **Star Citizen tooling.** Hangar management, ship selection and crew/seat sign-up for events.
- **Streams and overlay.** Screen sharing into a channel, a stream viewer in the client, and an in-game overlay window that shows teammates' streams on top of the game.

## Security model

Everything below describes what this code does. It is not a claim of an external audit.

**Text, DMs and event chat** are end-to-end encrypted with [MLS (RFC 9420)](https://datatracker.ietf.org/doc/html/rfc9420) through [OpenMLS](https://github.com/openmls/openmls), compiled to WASM (`web-portal/mls-crypto/`). Every device is its own MLS member, so the scheme is multi-device aware and provides forward secrecy and post-compromise security. The server stores and relays ciphertext plus the MLS handshake messages (key packages, commits, welcomes, group info) that members need to join and stay in step. It never holds group secrets.

**Voice is end-to-end encrypted on every channel as of 2.0.0.** Each voice frame is sealed with ChaCha20-Poly1305 (`web-portal/wasm-crypto/src/relay_audio.rs`):

- Every sending session draws a random 128-bit session id. It derives its own key with HKDF from a secret exported from the channel's MLS group, so a key is never shared between sessions, devices or reconnects.
- The nonce is a 64-bit per-session counter owned by the sender object. It cannot be reset and never wraps.
- The frame header (version, session id, counter, sender timestamp) is authenticated together with the sender's stream id and lane. A frame can't be moved to another speaker, between the channel and leadership lanes, or between sessions.
- Receivers keep a sliding replay window per sender session and reject frames whose timestamp is too far from their own clock. A recorded frame can't be replayed later in the epoch, even after the receiver restarts.
- The media server (`services/media-rust/`) forwards frames without decrypting them, and pre-2.0 clients are refused voice. Priority ducking is a playback decision on each listener's machine, based on who is transmitting, not on the audio content.
- Leadership transmissions that reach listeners in other channels use a second, event-scoped MLS group, because those listeners aren't members of the speaker's channel group.

**Event channels are limited to signed-up participants.** The MLS group of an event channel (and the server's voice ticket for it) contains only accepted participants of the event, or of the specific group or frequency the channel belongs to, plus the event's staff (`services/identity-node/src/utils/eventChannelAccess.ts`). A pending sign-up gets no key until it's accepted.

**Video** from screen sharing is encrypted with a key derived from the channel's MLS group whenever the sharing device holds that key. Each stream declares whether it is encrypted, so a viewer never has to guess. Frames that fail to decrypt are dropped rather than decoded.

**Local state.** Private keys are generated on your device and never leave it, not even in encrypted form. The device's MLS state (signature key and group secrets) is stored on disk encrypted with AES-256-GCM. The key for it is held in the OS credential store (Windows Credential Manager) and kept separate from the key for saved login credentials (`web-portal/src-tauri/src/mls_store.rs`). Writes are atomic with a backup copy, and an unreadable state is reported as an error rather than silently replaced with a new identity.

**What the server can still see** is metadata. That includes accounts, orgs and their membership; event plans, sign-ups and assignments; which channels exist and who is in them; presence; when messages are sent, to which channel or conversation, and their sizes; and, for voice and video, who is transmitting, when, and how much. It cannot read message contents, voice audio or encrypted video.

**The in-game overlay** (`web-portal/src/overlay.jsx`) is an ordinary always-on-top window, not a render hook or a DLL injected into the game. It has no network access of its own. The main window does all networking and decryption, then passes frames to the overlay over local IPC. The overlay runs under a narrow Tauri capability grant (`web-portal/src-tauri/capabilities/overlay.json`) with no filesystem, shell, microphone or network permissions.

**Updates** are signed. The client verifies them against the updater public key in `web-portal/src-tauri/tauri.conf.json`. The signing private key is not part of this repository.

## What's in here

| Path | What it is |
|---|---|
| `web-portal/` | Desktop client: a Tauri 2 (Rust) shell plus a React frontend. Tray bar and cabinets, voice, chat, operations, streams and overlay. |
| `web-portal/mls-crypto/` | Rust/WASM crate wrapping OpenMLS: group management and message encryption, including external-commit rejoin. |
| `web-portal/wasm-crypto/` | Rust/WASM crate for media frames: relay voice protection (`relay_audio.rs`) and video frame encryption. |
| `web-portal/src-tauri/plugins/specter-audio/` | Native audio plugin: capture, playback, resampling and voice activation detection. |
| `services/identity-node/` | Node/TypeScript API: auth, orgs, events, MLS delivery service, messaging, billing and push notifications. |
| `services/media-rust/` | Rust media relay (WebTransport). Forwards encrypted voice and video frames. |
| `shared/events/` | Shared event contracts: the schema for real-time events the server publishes and the client consumes. |
| `packages/shared-web/` | Shared frontend code and API client used by `web-portal` and `website`. |
| `website/` | The spectercoms.net marketing site (React). |
| `proto/` | Protobuf definitions (`AudioFrame`, `VideoFrame`, moderation messages) shared by the client and `media-rust`. |

## Building from source

Requirements: Node.js (LTS), a stable Rust toolchain, and for the desktop client the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) on Windows.

```sh
# Frontend bundle for the desktop client
cd web-portal && npm ci && npm run build

# Marketing site
cd website && npm ci && npm run build

# API server (TypeScript compile)
cd services/identity-node && npm ci && npm run build

# Media relay
cargo build --manifest-path services/media-rust/Cargo.toml
```

The WASM crypto packages are checked in prebuilt (`web-portal/mls-crypto/pkg`, `web-portal/wasm-crypto/pkg`). `node web-portal/scripts/build-wasm.mjs` rebuilds them the same way they were built: a release build for `wasm32-unknown-unknown`, then `wasm-bindgen` 0.2.126 (`--target web`), then `wasm-opt -O`. It needs the `wasm32-unknown-unknown` Rust target and `wasm-bindgen-cli` 0.2.126. A full desktop build (`npx tauri build` in `web-portal/`) also needs the FFmpeg shared libraries that the client bundles for video. Those aren't included here, so you need your own FFmpeg 8 build (for example from vcpkg) placed in `web-portal/src-tauri/ffmpeg-dlls/`. Running the server side needs PostgreSQL with the database schema, NATS and your own configuration (secrets, TLS certificates, domain), none of which ship with this repository.

## Testing

The test suites run on every push through GitHub Actions (`.github/workflows/test.yml`). To run them locally from the repository root:

```sh
npm ci
npm --prefix services/identity-node ci
npm --prefix web-portal ci

npm test                   # runs test:server, test:web and test:rust
```

| Command | What it covers |
|---|---|
| `npm run test:server` | Event contracts on the server: every `publishEvent` call site is checked against `shared/events/schema.js`, plus runtime checks of the message controller. No database needed. |
| `npm run test:web` | The shared event schema, client contract tests (`web-portal/test/`), the MLS session queue (`test:mls`) and event frequency/leadership routing (`test:freq`). |
| `npm run test:rust` | `cargo test` for `web-portal/mls-crypto` and `web-portal/wasm-crypto`, including relay voice framing, replay and timestamp checks. |

`identity-node` also has database integration tests (`services/identity-node/src/test/`). They cover MLS epoch concurrency and external commits, event channel access, the voice client-version gate, refresh-token rotation, HWID bans, and DM and org sync. They run against a live PostgreSQL with the production schema and NATS (`npm run test:server:integration`, with `DB_DSN`, `NATS_URL` and `JWT_SECRET` set). The database schema isn't published, so these tests are included for review but aren't run by this repository's workflow.

Further standalone harnesses run against the real WASM builds (run them from the repository root):

```sh
node web-portal/tests/relay-monitor-harness.mjs   # relay voice receive path: lanes, tampering, fail-closed
node web-portal/tests/key-grace-harness.mjs       # voice/video key continuity across MLS rekeys
node web-portal/scripts/test-chat-engine.mjs      # chat engine store/sync logic
node web-portal/scripts/test-chat-delivery.mjs    # chat delivery and catch-up
node web-portal/scripts/test-mls-wasm.mjs        # mls-crypto WASM end-to-end
cargo test --manifest-path web-portal/src-tauri/plugins/specter-audio/Cargo.toml   # VAD and resampler
```

The audio plugin's tests build Opus from source, so CMake must be on `PATH`.

## Status

This is a real, actively developed product, not a demo. This snapshot reflects the production codebase at **client v2.0.1** (2026-10-25). The version the desktop client shows in its settings should match. If this snapshot has fallen behind a release, the client is the authority and this snapshot is out of date.

## Licence

All rights reserved. The source is published for transparency and review only. No licence is granted to use, copy, modify or redistribute it. Third-party components under `web-portal/src-tauri/vendor/` and `services/media-rust/protoc/` keep their own licences.

## Reporting a vulnerability

If you find a security issue, please open an issue on this repo or contact us through https://spectercoms.net rather than disclosing it publicly. We'll get back to you.
