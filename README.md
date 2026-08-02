# SpecterComs

SpecterComs is a voice/text comms client built to keep large in-game teams organized — command priority (so when a leader speaks, background chatter steps aside automatically), an in-game overlay, mission/event scheduling, and server discovery in one client. It's aimed at large squads and orgs (built with games like Star Citizen in mind) who've outgrown a flat Discord server.

This repo is a public snapshot of the app code for anyone who wants to see how it's built. It's exported from a private working repo, so history starts fresh here rather than showing every commit since day one — the code itself is current.

## What's in here

| Path | What it is |
|---|---|
| `web-portal/` | Desktop client — Tauri 2 (Rust) shell + React frontend. Voice, the in-game overlay window, mission/event tooling, org management. |
| `services/identity-node/` | Node/TypeScript API — auth, orgs, messaging, billing, push notifications. |
| `services/media-rust/` | Rust media pipeline — audio/video relay and mixing. |
| `packages/shared-web/` | Shared frontend code/API client used by both `web-portal` and `website`. |
| `website/` | Marketing/landing site (React). |

## Stack

- **Desktop client:** Tauri 2, Rust, React, Vite
- **Backend:** Node.js, TypeScript, Express
- **Media:** Rust (custom SFU/relay), FFmpeg
- **Frontend tooling:** Tailwind, Vite

## Status

This is a real, actively developed product, not a demo — the code here is what's currently running. No license is attached; this repo is for transparency, not for reuse/redistribution.
