# SpecterComs

SpecterComs is a voice/text comms client built to keep large in-game teams organized — command priority (so when a leader speaks, background chatter steps aside automatically), an in-game overlay, mission/event scheduling, and server discovery in one client. It's aimed at large squads and orgs (built with games like Star Citizen in mind) who've outgrown a flat Discord server.

This isn't open source — there's no license here for reuse or redistribution. It's published so anyone can verify what the app actually does rather than take our word for it: how data is handled, what's actually encrypted, what the server can and can't see. It's exported from a private working repo, so history starts fresh here rather than showing every commit since day one — the code itself reflects the current production codebase. Deployment secrets, API keys, certificates, and internal infrastructure config are stripped before export; nothing here should be treated as live credentials.

## What's in here

| Path | What it is |
|---|---|
| `web-portal/` | Desktop client — Tauri 2 (Rust) shell + React frontend. Voice, the in-game overlay window, mission/event tooling, org management. |
| `web-portal/mls-crypto/` | Rust/WASM crate — end-to-end encryption (text, video, and voice), built on [MLS (RFC 9420)](https://datatracker.ietf.org/doc/html/rfc9420) via [OpenMLS](https://github.com/openmls/openmls). |
| `services/identity-node/` | Node/TypeScript API — auth, orgs, messaging, billing, push notifications. |
| `services/media-rust/` | Rust media pipeline — a content-blind relay for video and (on migrated channels) voice; falls back to server-side mixing for voice channels not yet on the new relay path. |
| `packages/shared-web/` | Shared frontend code/API client used by both `web-portal` and `website`. |
| `website/` | Marketing/landing site (React). |
| `proto/` | Shared protobuf definitions (`AudioFrame`, `VideoFrame`, moderation messages) used by both the client and `services/media-rust`. |

## Stack

- **Desktop client:** Tauri 2, Rust, React, Vite
- **Backend:** Node.js, TypeScript, Express
- **Media:** Rust (custom SFU/relay), FFmpeg
- **End-to-end encryption:** MLS (RFC 9420) via OpenMLS, compiled to WASM — DMs, org channels and video are E2E encrypted per-device (multi-device aware), with forward secrecy and post-compromise security. **Voice is not yet E2E encrypted in practice.** Voice is TLS-only because priority ducking (a squad lead's voice cutting through background chatter) needs the server to mix audio in plaintext. A per-sender relay that removes that requirement is implemented — the server forwards each speaker's still-encrypted audio without ever decoding it, and ducking becomes a client-side playback decision driven by packet-arrival metadata (who's authorized to duck, are they currently transmitting) instead of content inspection — and a priority speaker's voice reaching listeners in other channels ("cascade") is decrypted with a second, event-scoped MLS group, since the cascade's recipients aren't members of the speaker's own channel group. That path is gated per channel by a `voice_relay_mode` flag which is **currently enabled on no channels**, so every live voice channel today runs the TLS-only server-mixed path. Cutover is channel-by-channel; until a channel is switched over, treat its voice as encrypted in transit but readable by the media server.
- **Frontend tooling:** Tailwind, Vite

## Trust model

- Text, direct messages, org channels and video are MLS end-to-end encrypted — servers store and relay ciphertext they cannot decrypt.
- **Voice is currently not end-to-end encrypted.** It is encrypted in transit (TLS) but decrypted server-side so the media relay can mix audio for priority ducking. The E2E relay path that removes this is built and shipped in the client, but it is gated per channel and enabled on no channels at present — so assume any voice you speak today is readable by the media server while it is being mixed. This is the one place the product does not yet match the rest of the trust model, and it is stated plainly here rather than left to a parenthetical.
- Private keys are generated on your own device and never leave it, not even encrypted. We don't hold a copy, so there's nothing on our end to hand over even if someone asked.
- Video is E2E encrypted whenever the sharing client holds its channel's MLS key. A client that has not yet been admitted to the channel's MLS group (a fresh install, before another member's key package exchange completes) screen-shares over TLS only until it is; the stream declares which of the two it is, so a viewer never has to guess.
- A priority speaker's audio reaching other channels (cascade) uses a separate MLS group scoped to the event rather than the channel, since cascade recipients aren't in the speaker's own channel's group — membership is every accepted participant across the event, not just the specific frequency/group a listener happens to be in.
- Auth tokens and account data are handled by `services/identity-node/`; nothing in that path has access to MLS group keys.
- The in-game overlay (`web-portal/src/components/GameOverlayWindow.jsx`, `web-portal/src/overlay.jsx`) is a separate always-on-top OS window (Tauri/WebView2), not a DirectX/Vulkan render hook or a DLL injected into the game process. It doesn't touch the game's rendering pipeline at all — same category as any other window sitting on top of a game, not the injection-based technique that trips anti-cheat heuristics.
- The overlay also has no network connectivity and holds no socket to server infrastructure — the main window handles all networking and MLS decryption, then hands the overlay already-decrypted frames over local Tauri IPC (`emit`/`listen`, not a command a compromised overlay could invoke on its own). On top of that, the overlay window runs under a deliberately narrow Tauri capability grant (`web-portal/src-tauri/capabilities/overlay.json`) — `core:default` plus only window-hide, window-resize, and click-through toggling. No filesystem, shell, microphone, or network permissions are granted to that window, so even a fully compromised overlay web context has no privileged surface to pivot through.

## Status

This is a real, actively developed product, not a demo. This snapshot reflects
the production codebase at **client v1.10.43** (2026-10-21). The version the
desktop client reports in its own settings should match; if this snapshot has
fallen behind a release, the client is the authority and this is stale.

## Reporting a vulnerability

If you find a security issue, please open an issue on this repo or reach out directly rather than disclosing publicly. We'll get back to you.
