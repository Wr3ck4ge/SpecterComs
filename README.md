# SpecterComs

SpecterComs is a voice/text comms client built to keep large in-game teams organized — command priority (so when a leader speaks, background chatter steps aside automatically), an in-game overlay, mission/event scheduling, and server discovery in one client. It's aimed at large squads and orgs (built with games like Star Citizen in mind) who've outgrown a flat Discord server.

This repo is a public snapshot of the app code for anyone who wants to see how it's built. It's exported from a private working repo, so history starts fresh here rather than showing every commit since day one — the code itself reflects the current production codebase. Deployment secrets, API keys, certificates, and internal infrastructure config are stripped before export; nothing here should be treated as live credentials.

## What's in here

| Path | What it is |
|---|---|
| `web-portal/` | Desktop client — Tauri 2 (Rust) shell + React frontend. Voice, the in-game overlay window, mission/event tooling, org management. |
| `web-portal/mls-crypto/` | Rust/WASM crate — end-to-end encryption for text and video, built on [MLS (RFC 9420)](https://datatracker.ietf.org/doc/html/rfc9420) via [OpenMLS](https://github.com/openmls/openmls). |
| `services/identity-node/` | Node/TypeScript API — auth, orgs, messaging, billing, push notifications. |
| `services/media-rust/` | Rust media pipeline — audio/video relay and mixing. |
| `packages/shared-web/` | Shared frontend code/API client used by both `web-portal` and `website`. |
| `website/` | Marketing/landing site (React). |

## Stack

- **Desktop client:** Tauri 2, Rust, React, Vite
- **Backend:** Node.js, TypeScript, Express
- **Media:** Rust (custom SFU/relay), FFmpeg
- **End-to-end encryption:** MLS (RFC 9420) via OpenMLS, compiled to WASM — DMs, org channels, and video are E2E encrypted per-device (multi-device aware), with forward secrecy and post-compromise security. Voice stays TLS-only: the media relay mixes audio server-side for priority ducking (so a squad lead's voice cuts through), which is fundamentally incompatible with E2E without dropping that feature.
- **Frontend tooling:** Tailwind, Vite

## Trust model

- Text, direct messages, org channels, and video are MLS end-to-end encrypted — servers store and relay ciphertext they cannot decrypt.
- Voice is encrypted in transit (TLS) but decrypted server-side by the media relay so it can mix audio for priority ducking. This is a deliberate tradeoff, not an oversight — see the encryption note above.
- Auth tokens and account data are handled by `services/identity-node/`; nothing in that path has access to MLS group keys.

## Status

This is a real, actively developed product, not a demo — this snapshot reflects the current production codebase. No license is attached; this repo is for transparency, not for reuse/redistribution.

## Reporting a vulnerability

If you find a security issue, please open an issue on this repo or reach out directly rather than disclosing publicly. We'll get back to you.
