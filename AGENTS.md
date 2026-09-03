# AGENTS.md

Tube AutoPilot: upload/schedule videos to YouTube (OAuth 2.0 + YouTube Data API v3) and TikTok (Content Posting API). Node.js + Express, no build step, no frontend framework.

## Language

UI, error messages, comments, tests, and docs are all **Portuguese (PT-BR)**. Keep new copy/user-facing strings in PT-BR. Code identifiers are English.

## Run / test

- Dev/start: `npm run dev` (`node server/server.js`). Open `http://localhost:3000`.
- Must have `.env` set up (copy `.env.example`). Missing Google/TikTok creds only disables those integrations; `GET /api/health` reports `googleConfigured`.
- Tests use the **Node built-in test runner** (no framework, no jest): `npm test` → `node --test --test-concurrency=1`. Run a single test file with `node --test --test-concurrency=1 test/multichannel.test.js`. Tests spin up a real server on a random port (39000-39999) and require network access to Google only via mocked/offline paths — they also implicitly test that OAuth tokens are never serialized.
- No lint or typecheck config exists. No git repo here.

## Architecture

- `src/` is **static** frontend served by Express (`src/index.html`, `src/app.js`, `src/styles.css`). No bundler; `app.js` targets browsers directly.
- `server/server.js` mounts everything and defines the OAuth flow + `/api/youtube/upload`. Note the `/auth/youtube*` and `/api/auth/google*` routes are aliases for the same handlers.
- `server/inventory.js` — `createInventoryRouter({ oauthClient, hasGoogleConfig })` returns **one router mounted at BOTH** `/api/inventory` and `/api/shorts`. In-process scheduler (`startScheduler()`).
- `server/tiktok.js` — `createTikTokRouter()`, mounted at `/api/tiktok`, with its own in-process scheduler.
- `server/oauth-store.js` — multi-channel account store. Accounts are keyed by `accountId` (a UUID) and `channelId`; the store auto-migrates legacy non-UUID ids and rewrites `accountId` links in inventory on load.
- `server/categories.js` — category configs + title/snippet generation (local, no OpenAI). `server/comments.js` — comment worker.

## Data (all JSON files, no DB)

Everything lives in `data/` (created on demand):
- `data/inventory.json`, `data/videos/` — YouTube inventory + video files (`INVENTORY_PATH` overrides location).
- `data/oauth-accounts.json` — OAuth tokens + channel accounts (`OAUTH_ACCOUNTS_PATH` overrides).
- `data/tiktok-inventory.json`, `data/tiktok-videos/`, `data/tiktok-auth.json`.
- `data/metadata-overrides.json` — per-category overrides to `server/categories.js` (edited via `PUT /api/metadata/:categoryId`).
- Writes are atomic (`.tmp` + rename) and, in inventory, serialized through a promise `writeQueue`. Keep mutations going through `saveItems`/the store, not direct writes.

## Conventions / gotchas

- **Never serialize tokens to API responses.** `publicAccount()` in `oauth-store.js` strips `refreshToken`/`accessToken`; there is a test asserting the API never leaks them. Keep new endpoints returning account data going through `publicAccount`/`listAccounts`.
- YouTube scheduled-public uploads must be sent as `private` with `status.publishAt` (API requirement). Handled in `server.js` upload + the inventory router's scheduler.
- In-process schedulers (both `inventory` and `tiktok`) start on server boot. When testing, they run against whatever `INVENTORY_PATH`/data paths point at — the tests set these env vars to temp dirs to isolate.
- Google daily upload quota is **shared across all channels** on a project; switching accounts doesn't reset it (see `userError` in `inventory.js`).
- Design workflow is spec-driven using OpenSpec: `.opencode/commands/opsx-*.md` and `.opencode/skills/openspec-*` define the propose/apply/archive flow around `openspec/`. Use `/opsx-*` commands when making changes that should follow that workflow.
- Avoid putting credentials in `server/*.js`; everything comes from `.env` (loaded by `dotenv`).
