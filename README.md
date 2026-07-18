# Lumina — Task Earnings Tracker

Express + PostgreSQL backend serving a static single-page frontend
(`public/index.html`). Users register, clear task tiers by passing
short quizzes (difficulty increases as tiers go up), and submit
withdrawal requests that are logged for manual/external payout
processing.

## What changed in this pass ("advance + fix all bugs")

### Bugs fixed

1. **Daily bonus was never actually saved.** `claimDailyBonus()` only
   mutated `appState` in the browser — it never called the backend. The
   ₵1 credit, and the 24h cooldown, both silently reverted the next time
   the app synced with the server (page reload, next task, etc.), and
   the cooldown could be reset just by clearing localStorage. Fixed by
   adding a real `POST /api/user/claim-daily-bonus` endpoint that enforces
   the cooldown against a `last_daily_bonus_at` column in the database,
   and updating the frontend to call it.

2. **Connection pool leaks.** `complete-tier`, `complete-bonus-task`, and
   `withdraw` all called `pool.connect()` before validating the request
   body. An invalid request returned early without ever releasing the
   client back to the pool, which would exhaust the pool under sustained
   bad input. Fixed by validating input before checking out a connection.

3. **Reset screen crash.** `resetEngine()` replaced `appState` with an
   object missing `bonusBalance`, `completedBonusTasks`, and
   `lastSurpriseDate`. `renderBonusTaskList()` immediately called
   `.toFixed()` on the now-`undefined` `bonusBalance`, throwing and
   breaking the rest of the UI refresh. Fixed by resetting to the full
   state shape.

4. **Bonus task completion after Tier 1 didn't update the visible
   balance.** When a bonus task is completed after Tier 1 is already
   clear, the server correctly credits the reward straight to `balance`
   — but the frontend only ever read `bonus_balance` back from that
   response, so the new balance wasn't reflected until the next full
   sync. Fixed to also apply `balance` from the response.

5. **Duplicated, drifting sync logic.** `registerProfile()` and
   `syncProfileWithBackend()` each hand-copied fields off the server's
   user object, and had already drifted (one was missing
   `bonus_balance`/`completed_bonus_tasks`). Consolidated into one
   `applyServerUser()` helper both functions call, so this class of bug
   can't reoccur.

6. **Stored XSS via withdrawal destination / bank name.** Transaction
   history is rendered with `innerHTML`, and the withdrawal `reference`
   field (built from user-entered destination/bank name) was inserted
   unescaped. A crafted bank name or payout address would execute as
   HTML/JS in the transaction log. Fixed with an `escapeHtml()` helper
   applied to all user-supplied text rendered that way.

7. **Transaction type labels were incomplete.** The history view only
   recognized `withdrawal` and `bonus`/`daily_bonus`; `bonus_task` and
   `bonus_unlock` transactions (both real transaction types the backend
   writes) fell through and were mislabeled as "Task Reward". Fixed with
   a complete type → label mapping.

8. **Repo had duplicate/conflicting copies of the frontend** (a stray
   root-level `index.html`, an old buggy `public/index.html`, and a
   correctly-fixed but oddly-named `public/index (7).html`). Consolidated
   to a single canonical `public/index.html`.

### Hardening / advancement

- Added `helmet` for standard security headers.
- Added rate limiting (`express-rate-limit`) on all `/api/user/*`
  endpoints — 30 requests/minute per IP — to blunt scripted abuse of the
  task/withdrawal/reset endpoints.
- Added server-side length limits on free-text fields (`name`,
  `payoutDestination`, withdrawal `destination`/`bankName`) so nothing
  unbounded gets written to the database.
- Added basic client-side email format validation on signup (server
  already validated this; now the user gets faster feedback).

### Carried over from the previous pass (already in place)

- 10 task tiers with difficulty scaling by tier (easy → expert).
- Confetti effect on task/bonus-task completion.
- Server-side reward calculation (never trusted from the client).
- Server-side bonus-balance unlock when Tier 1 completes.

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
   git commit -m "Fix bugs, add daily bonus backend, harden API"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main --force
   ```

2. **Railway project**: if you already have one connected to this repo,
   it will redeploy automatically on push. Otherwise: New Project →
   Deploy from GitHub repo.

3. **PostgreSQL**: if not already added, New → Database → Add PostgreSQL.
   Railway auto-injects `DATABASE_URL` into your app service.

4. **Verify after deploy**:
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
# edit .env with a local or remote Postgres connection string
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
