# Reste — Shared Household Budget Planner PWA

**Reste** is an installable Progressive Web App (PWA) for couples and households to manage joint bills, proportional cost splits, spending pots, prepayments, personal waterfalls, and disposable income (*"Reste"*), with real-time live sync and permanent Supabase PostgreSQL storage.

## Key Features
- **iOS & Android Home Screen App**: Configured with `Reste` app name (`manifest.json`, `apple-mobile-web-app-title`), opaque 180×180 `apple-touch-icon.png`, Android standard & maskable icons (`192×192`, `512×512`), and offline shell caching (`sw.js`).
- **Accounts & Household Share Codes**: Create an account with username/email + password, create a household to receive a 6-character share code, and share that code with your partner so both devices edit the exact same live budget.
- **Instant Live Updates**: Powered by Supabase Realtime (`postgres_changes` + Broadcast + Presence) so any change appears on both phones within moments, even showing when your partner is live.
- **Permanent Cloud Persistence**: All income, bills, pots, receipts, and monthly snapshots are stored permanently in Supabase PostgreSQL with Row-Level Security. Clearing browser cache or reinstalling the PWA never loses data — simply sign back in.
- **Flexible & Future-Proof**: Add unlimited income sources, bills, spending pots, prepayments (weekly, 4-weekly, monthly, bi-monthly, quarterly, 6-monthly, annually), personal items, custom expense/income categories, per-item split overrides, and JSON/CSV exports.

## Hosting & Running
Because Reste is a zero-build static PWA (`index.html`, `styles.css`, `app.js`, `budget-engine.js`, `manifest.json`, `sw.js`), you can:
1. **Run locally** with any static file server (e.g. `python -m http.server 8123`), then open `http://localhost:8123`.
2. **Host for free on GitHub Pages** (push this folder to a GitHub repo — `.nojekyll` is already included — and enable GitHub Pages on `main`).
3. **Install on iPhone / Android**:
   - **iOS (Safari)**: Open the hosted URL → tap **Share** → **Add to Home Screen** → **Reste**.
   - **Android (Chrome)**: Open the hosted URL → tap **⋮ Menu** → **Install app** / **Add to Home screen** → **Reste**.
