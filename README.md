# Reste — Shared Household Budget Planner PWA

**Reste** is an installable Progressive Web App (PWA) for couples and households to manage joint bills, proportional cost splits, spending pots, prepayments, private personal finances, and disposable income (*"Reste"*), with real-time live sync and permanent Supabase PostgreSQL storage.

## Key Features
- **iOS & Android Home Screen App**: Configured with the `Reste` name (`manifest.json`, `apple-mobile-web-app-title`), custom emerald-gold "R." icon (`apple-touch-icon.png` 180×180 opaque, Android standard & maskable `192×192` / `512×512`, `icon.svg`), edge-to-edge full-screen safe-area layout, and automatic over-the-air Service Worker cache updates (`sw.js`) without needing to re-add to the Home Screen.
- **Accounts, Share Codes & Join Locking**: Create an account with username/email + password, create a household to receive a 6-character share code, share it so both partners edit the same live budget, and optionally lock new joins once both partners are connected.
- **Instant Live Sync & Offline Queue**: Powered by Supabase Realtime (`postgres_changes` + Broadcast + Presence) with automatic JWT refresh for long-lived mobile sessions and a local offline mutation queue so updates always stay in sync.
- **Interactive Split Slider & Auto £50 Transfers**: Scrub the bill percentage split slider cleanly (or pick `50 / 50 Equal` or `Income Match`). Each partner's joint bills share automatically rounds up to the nearest `£50` (`Round-Up Extra`) plus any optional `+/-` adjustment to calculate the live Joint Transfer.
- **Tap-to-Amend Inline Editing**: Tap any value pill across Overview, Joint, Spend, or Personal tabs to amend numbers directly in place (including `±` negative credit toggles where applicable).
- **Strictly Private Personal Sections**: Each partner sees only their own Personal section (budgeted items, debt repayment, personal bills, savings) enforced both in the client and at the database level via PostgreSQL Row-Level Security (`private.can_access_budget_scope`), plus quick Expense (`+`) / Credit (`-`) tracking and one-tap completion.
- **Flexible & Future-Proof**: Add unlimited income sources, bills, spending pots, prepayments (weekly to annually), custom payday billing cycles (e.g. 20th–19th, synced live across both partners), an interactive category pie chart on Overview, custom categories, per-item split overrides, and JSON/CSV exports.
- **Permanent Cloud Persistence & Backups**: All records are saved in Supabase PostgreSQL with RLS. Clearing browser cache or switching devices never loses data, and full JSON/CSV exports & imports are built in.

## Hosting & Running
Reste is a zero-build static PWA (`index.html`, `styles.css`, `app.js`, `budget-engine.js`, `manifest.json`, `sw.js`):
1. **Run locally** with any static file server (e.g. `python -m http.server 8123`), then open `http://localhost:8123`.
2. **Host on GitHub Pages**: `.nojekyll` is included — serve directly from `main`.
3. **Install on iPhone / Android**:
   - **iOS (Safari)**: Open the hosted URL → tap **Share** → **Add to Home Screen** → **Reste**.
   - **Android (Chrome)**: Open the hosted URL → tap **⋮ Menu** → **Install app** / **Add to Home screen** → **Reste**.
