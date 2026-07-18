# Lumina — Task Earnings Tracker

Express + PostgreSQL backend serving a static single-page frontend
(`public/index.html`). Users register, clear task tiers by passing
short quizzes (difficulty increases with every tier, not just in broad
groups), and submit withdrawal requests that are logged for
manual/external payout processing.

## What changed in this pass ("difficulty scaling + withdrawal gate + no client-side storage")

1. **Per-tier difficulty scaling.** The old 4-bucket question pool
   (easy/medium/hard/expert covering tiers 1-3/4-6/7-8/9-10) has been
   replaced with 10 distinct pools, one per tier, each a clear step up
   from the last — from basic recall at Tier 1 to multi-step math and
   niche knowledge at Tier 10. See `questionBank` and
   `questionsForTier()` / `difficultyForTier()` in `public/index.html`.
   Bonus tasks still draw from the Tier 1 pool.

2. **Withdrawal is now gated on Task Tier 1, not bonus tasks.**
   Previously, bonus task rewards sat in a locked `bonus_balance`
   bucket until Tier 1 was cleared. Now bonus task rewards are credited
   to the withdrawable `balance` immediately on completion — the gate
   moved to `/api/user/withdraw` itself, which returns `403
   {error, gate: 'tier1_required'}` until the user has cleared Tier 1.
   The `bonus_balance` column and its unlock-on-Tier-1 logic in
   `complete-tier` are kept only so any pre-existing locked balances
   from before this change still get folded into `balance` correctly.

3. **No client-side storage at all** (no `localStorage`, no
   `sessionStorage`). The frontend used to cache the whole user profile
   in `localStorage` and restore it on load. That's gone — identity is
   now tracked with a signed, httpOnly session cookie
   (`lumina_session`, set by `cookie-parser`) issued by
   `POST /api/user/sync` on registration. On page load the frontend
   calls `GET /api/user/me`, which resolves the cookie server-side and
   returns the current DB row; `appState` is otherwise held only in
   memory for the life of the tab. `POST /api/user/logout` clears the
   cookie without touching the account (added as a non-destructive
   alternative to the existing "delete everything" reset button). Set
   `COOKIE_SECRET` in your environment — see `.env.example`.

## A note on realism

The task rewards in this build (₵95–₵1,130 per 5-question quiz) are far
above what a real "answer some trivia" task should plausibly pay, and
`/api/user/withdraw` never calls a real payment API — payouts are
manual/external only. That combination is also the exact shape of
known "task-earning" scam apps. If real users will ever see this app,
strongly consider: realistic reward amounts, clear in-UI messaging
about how long payouts actually take, and not advertising "no fee
required" as a trust signal unless you also disclose the manual payout
process up front.

## Important: withdrawals are not automatically paid out

`/api/user/withdraw` deducts the requested amount from the user's balance
and logs a transaction with `status = 'pending'`. It does **not** call
PayPal, Mobile Money, or a bank API — no real money moves automatically.
Since this is an internal tool, hook up your own payout process (manual
or via a payment API) and update the transaction's `status` to `'success'`
once a payout is actually sent.

## Project structure

```
lumina/
├── server.js         # Express app + all API routes
├── db.js             # PostgreSQL pool + schema bootstrap (auto-creates/migrates tables)
├── package.json
├── railway.json      # Railway build/deploy config
├── .env.example
├── .gitignore
└── public/
    └── index.html    # Frontend (served statically by Express)
```

## Deploy to Railway via GitHub

1. **Push this project to a GitHub repo**, replacing whatever is
   currently there — in particular make sure the old duplicate/stray
   `index.html` files are gone and only `public/index.html` remains.
   ```bash
   git init
   git add .
   git commit -m "Per-tier difficulty, withdrawal gate on Tier 1, drop client-side storage"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main --force
   ```

2. **Railway project**: if you already have one connected to this repo,
   it will redeploy automatically on push. Otherwise: New Project →
   Deploy from GitHub repo.

3. **PostgreSQL**: if not already added, New → Database → Add PostgreSQL.
   Railway auto-injects `DATABASE_URL` into your app service.

4. **Set `COOKIE_SECRET`** in the Railway service's variables to a
   long random string — required for signed session cookies in
   production (a dev fallback is used locally with a console warning).

5. **Verify after deploy**:
   - `https://<your-app>.up.railway.app/healthz` → `{"ok":true}`
   - The root URL loads the app (not "Cannot GET /" — that means
     `public/index.html` didn't make it into the repo).
   - The database migration (`last_daily_bonus_at` column) runs
     automatically on server startup — no manual step needed, even on
     an existing database.

## Local development

```bash
npm install
cp .env.example .env
# edit .env with a local or remote Postgres connection string, and set COOKIE_SECRET
npm start
# app runs at http://localhost:3000
```

## Database schema

- **users**: one row per registered email — balance, bonus_balance,
  current_task_tier, completed_tiers[], completed_bonus_tasks[],
  total_withdrawn, payout_destination, last_daily_bonus_at.
- **transactions**: full audit log of task rewards, bonus rewards,
  bonus unlocks, daily bonuses, and withdrawal requests, each with a
  `status` you can update as payouts are actually processed.
