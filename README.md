# Lumina — Task Earnings Tracker

Express + PostgreSQL backend serving a static single-page frontend
(`public/index.html`). Users register, clear task tiers by passing
short quizzes (difficulty increases as tiers go up), and submit
withdrawal requests that are logged for manual/external payout
processing.

## What changed from the original frontend-only version

- **10 task tiers** instead of 25 (`NUM_TASKS = 10` in both frontend and backend).
- **Difficulty scales with tier**: tiers 1–3 use easy questions, 4–6 medium,
  7–8 hard, 9–10 expert. See `questionBank` in `public/index.html`.
- **Confetti effect** now plays on every successful task/bonus-task
  completion (reuses the existing `spawnConfetti()` function, previously
  only used for the daily surprise).
- **A real backend** (`server.js` + `db.js`) implementing every endpoint
  the frontend already calls: `/api/user/sync`, `/api/transactions/:email`,
  `/api/user/complete-tier`, `/api/user/complete-bonus-task`,
  `/api/user/withdraw`, `/api/user/reset`.
- Reward amounts are **recomputed server-side** (not trusted from the
  client) to prevent tampering with quiz rewards.

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
├── db.js             # PostgreSQL pool + schema bootstrap (auto-creates tables)
├── package.json
├── railway.json       # Railway build/deploy config
├── .env.example
├── .gitignore
└── public/
    └── index.html     # Frontend (served statically by Express)
```

## Deploy to Railway via GitHub

1. **Push this project to a GitHub repo.**
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Lumina app with backend"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

2. **Create a Railway project from the repo.**
   - Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
   - Select the repo you just pushed. Railway detects the Node app via
     `package.json` and `railway.json` automatically (Nixpacks builder).

3. **Add a PostgreSQL database.**
   - In the Railway project, click **New** → **Database** → **Add PostgreSQL**.
   - Railway automatically sets the `DATABASE_URL` environment variable on
     your app service — no manual configuration needed.

4. **Deploy.**
   - Railway builds and starts the app automatically on push (`npm install`
     then `npm start`). The server creates its tables on first boot.
   - Once deployed, open the generated Railway domain (or attach a custom
     domain under **Settings → Networking**) to view the live app.

5. **Verify.**
   - Visit `https://<your-app>.up.railway.app/healthz` — should return `{"ok":true}`.
   - Visit the root URL to see the app itself.

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
  total_withdrawn, payout_destination.
- **transactions**: full audit log of task rewards, bonus rewards, and
  withdrawal requests, each with a `status` you can update as payouts
  are actually processed.
