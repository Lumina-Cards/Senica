// server.js — Lumina backend
// Serves the static frontend and implements the task/reward/withdrawal API.
//
// Note on withdrawals: this service records withdrawal requests as
// 'pending' transactions. It does not call any payment API — actual payout
// (PayPal / Mobile Money / bank transfer) is handled outside this app, as
// intended for an internal tool. Update the status to 'success' once a
// payout has actually been sent, e.g. from an admin process.

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { pool, initSchema } = require('./db');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for accurate rate-limit keys
app.use(helmet({ contentSecurityPolicy: false })); // CSP off: the frontend is a single inline-script page
app.use(express.json());

// ---- Session identity (cookie-based, no client-side storage) ----
// The frontend never persists user state to localStorage/sessionStorage.
// Instead, the server issues a signed, httpOnly cookie identifying the
// user's email after registration, and GET /api/user/me reads it back on
// every page load. The DB row is always the source of truth; the cookie
// only says *which* row to look at.
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'lumina-dev-secret-change-me';
if (!process.env.COOKIE_SECRET) {
  console.warn('[server] COOKIE_SECRET is not set — using an insecure development default. Set COOKIE_SECRET in production.');
}
const SESSION_COOKIE_NAME = 'lumina_session';
const SESSION_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

app.use(cookieParser(COOKIE_SECRET));
app.use(express.static(path.join(__dirname, 'public')));

function setSessionCookie(res, email) {
  res.cookie(SESSION_COOKIE_NAME, email, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_COOKIE_MAX_AGE_MS
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME);
}

// Light abuse protection on the endpoints that move money or mutate state.
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/user/', mutationLimiter);

// ---- Reward configuration (must mirror the constants in public/index.html) ----
const NUM_TASKS = 10;
const TASK_REWARD_BASE = 95;
const TASK_REWARD_STEP = 115;
const BONUS_TASK_REWARD = 15;
const BONUS_TASK_IDS = ['bonus1', 'bonus2'];
const DAILY_BONUS_AMOUNT = 1.00;
const DAILY_BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function rewardForTier(tierId) {
  return TASK_REWARD_BASE + (tierId - 1) * TASK_REWARD_STEP;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function serializeUser(row) {
  return {
    ...row,
    balance: Number(row.balance),
    bonus_balance: Number(row.bonus_balance),
    total_withdrawn: Number(row.total_withdrawn),
    completed_tiers: row.completed_tiers || [],
    completed_bonus_tasks: row.completed_bonus_tasks || []
  };
}

// ---- POST /api/user/sync — create or update a user profile ----
app.post('/api/user/sync', async (req, res) => {
  try {
    const { email, name, payoutDestination } = req.body || {};
    if (!isValidEmail(email) || !name) {
      return res.status(400).json({ error: 'A valid email and name are required.' });
    }
    if (name.length > 120 || (payoutDestination && payoutDestination.length > 200)) {
      return res.status(400).json({ error: 'Name or payout destination is too long.' });
    }

    const result = await pool.query(
      `INSERT INTO users (email, name, payout_destination)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             payout_destination = EXCLUDED.payout_destination
       RETURNING *`,
      [email, name, payoutDestination || '']
    );

    setSessionCookie(res, email);
    res.json(serializeUser(result.rows[0]));
  } catch (err) {
    console.error('POST /api/user/sync failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /api/user/me — resolve the current user from the session cookie ----
// Replaces reading a cached profile out of localStorage: the frontend calls
// this once on load and renders whatever the database currently says.
app.get('/api/user/me', async (req, res) => {
  try {
    const email = req.signedCookies && req.signedCookies[SESSION_COOKIE_NAME];
    if (!email || !isValidEmail(email)) {
      return res.status(401).json({ error: 'No active session.' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'No active session.' });
    }

    res.json(serializeUser(result.rows[0]));
  } catch (err) {
    console.error('GET /api/user/me failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /api/user/logout — clear the session cookie ----
app.post('/api/user/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// ---- GET /api/transactions/:email — transaction history for a user ----
app.get('/api/transactions/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }

    const result = await pool.query(
      `SELECT id, type, amount, reference, status, created_at
       FROM transactions
       WHERE user_email = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [email]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/transactions/:email failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /api/user/complete-tier — clear a main task tier ----
app.post('/api/user/complete-tier', async (req, res) => {
  const { email, tierId } = req.body || {};
  const tier = parseInt(tierId, 10);

  if (!isValidEmail(email) || !Number.isInteger(tier) || tier < 1 || tier > NUM_TASKS) {
    return res.status(400).json({ error: 'Invalid email or tier.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found. Register first.' });
    }
    const user = userResult.rows[0];

    // Reward is computed server-side, never trusted from the client.
    const reward = rewardForTier(tier);
    const alreadyCompleted = (user.completed_tiers || []).includes(tier);
    const isNextAvailableTier = tier === user.current_task_tier;

    if (alreadyCompleted || !isNextAvailableTier) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This tier is not currently available to complete.' });
    }

    const newCompletedTiers = [...(user.completed_tiers || []), tier];
    const newCurrentTier = Math.min(user.current_task_tier + 1, NUM_TASKS);

    // If this completion newly clears Tier 1, any bonus rewards that were
    // sitting in the locked bonus_balance bucket unlock into the real
    // balance right now. This must happen server-side — the DB is the
    // source of truth, so unlocking only in the browser causes the balance
    // to appear correct locally but revert on the next sync.
    const unlockingBonus = tier === 1 && Number(user.bonus_balance) > 0;
    const bonusUnlockAmount = unlockingBonus ? Number(user.bonus_balance) : 0;

    const newBalance = Number(user.balance) + reward + bonusUnlockAmount;
    const newBonusBalance = unlockingBonus ? 0 : Number(user.bonus_balance);

    const updateResult = await client.query(
      `UPDATE users
       SET balance = $1, bonus_balance = $2, current_task_tier = $3, completed_tiers = $4
       WHERE email = $5
       RETURNING *`,
      [newBalance, newBonusBalance, newCurrentTier, newCompletedTiers, email]
    );

    await client.query(
      `INSERT INTO transactions (user_email, type, amount, reference, status)
       VALUES ($1, 'task', $2, $3, 'success')`,
      [email, reward, `Task Tier ${tier}`]
    );

    if (unlockingBonus) {
      await client.query(
        `INSERT INTO transactions (user_email, type, amount, reference, status)
         VALUES ($1, 'bonus_unlock', $2, $3, 'success')`,
        [email, bonusUnlockAmount, 'Locked bonus balance unlocked']
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, user: serializeUser(updateResult.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/user/complete-tier failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

// ---- POST /api/user/complete-bonus-task — clear a bonus task ----
app.post('/api/user/complete-bonus-task', async (req, res) => {
  const { email, bonusTaskId } = req.body || {};

  if (!isValidEmail(email) || !BONUS_TASK_IDS.includes(bonusTaskId)) {
    return res.status(400).json({ error: 'Invalid email or bonus task id.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found. Register first.' });
    }
    const user = userResult.rows[0];

    if ((user.completed_bonus_tasks || []).includes(bonusTaskId)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Bonus task already completed.' });
    }

    const reward = BONUS_TASK_REWARD;
    const newCompletedBonusTasks = [...(user.completed_bonus_tasks || []), bonusTaskId];

    // Bonus task rewards are credited straight to the withdrawable balance —
    // they are not held back. Whether the funds can actually be *withdrawn*
    // is governed separately by /api/user/withdraw (Tier 1 must be cleared).
    const newBalance = Number(user.balance) + reward;

    const updateResult = await client.query(
      `UPDATE users
       SET balance = $1, completed_bonus_tasks = $2
       WHERE email = $3
       RETURNING *`,
      [newBalance, newCompletedBonusTasks, email]
    );

    await client.query(
      `INSERT INTO transactions (user_email, type, amount, reference, status)
       VALUES ($1, 'bonus_task', $2, $3, 'success')`,
      [email, reward, bonusTaskId]
    );

    await client.query('COMMIT');
    res.json({ success: true, user: serializeUser(updateResult.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/user/complete-bonus-task failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

// ---- POST /api/user/claim-daily-bonus — claim the once-per-24h check-in bonus ----
// The 24h cooldown is enforced here against last_daily_bonus_at in the
// database, not against a client-supplied timestamp, so it can't be reset
// by clearing localStorage or editing client state.
app.post('/api/user/claim-daily-bonus', async (req, res) => {
  const { email } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found. Register first.' });
    }
    const user = userResult.rows[0];

    if (user.last_daily_bonus_at) {
      const elapsed = Date.now() - new Date(user.last_daily_bonus_at).getTime();
      if (elapsed < DAILY_BONUS_COOLDOWN_MS) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: "You've already claimed today's bonus. Come back later!",
          retryAfterMs: DAILY_BONUS_COOLDOWN_MS - elapsed
        });
      }
    }

    const newBalance = Number(user.balance) + DAILY_BONUS_AMOUNT;

    const updateResult = await client.query(
      `UPDATE users SET balance = $1, last_daily_bonus_at = now() WHERE email = $2 RETURNING *`,
      [newBalance, email]
    );

    await client.query(
      `INSERT INTO transactions (user_email, type, amount, reference, status)
       VALUES ($1, 'daily_bonus', $2, $3, 'success')`,
      [email, DAILY_BONUS_AMOUNT, 'Daily Check-in']
    );

    await client.query('COMMIT');
    res.json({ success: true, user: serializeUser(updateResult.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/user/claim-daily-bonus failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

// ---- POST /api/user/withdraw — request a payout ----
// Deducts from the user's balance and logs a 'pending' transaction.
// This service does not move real money; fulfill payouts through your
// own PayPal / Mobile Money / bank process and mark the transaction
// 'success' afterward (see the admin note in transactions table).
app.post('/api/user/withdraw', async (req, res) => {
  const { email, amount, method, destination, bankName } = req.body || {};
  const amt = parseFloat(amount);
  const validMethods = ['paypal', 'momo', 'bank'];

  if (!isValidEmail(email) || !validMethods.includes(method) || !destination || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Missing or invalid withdrawal fields.' });
  }
  if (method === 'bank' && !bankName) {
    return res.status(400).json({ error: 'Bank name is required for bank withdrawals.' });
  }
  if (destination.length > 200 || (bankName && bankName.length > 200)) {
    return res.status(400).json({ error: 'Destination or bank name is too long.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found. Register first.' });
    }
    const user = userResult.rows[0];

    if (!(user.completed_tiers || []).includes(1)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Complete Task Tier 1 before you can withdraw.', gate: 'tier1_required' });
    }

    if (amt > Number(user.balance)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance.' });
    }

    const newBalance = Number(user.balance) - amt;
    const newTotalWithdrawn = Number(user.total_withdrawn) + amt;

    const updateResult = await client.query(
      `UPDATE users SET balance = $1, total_withdrawn = $2 WHERE email = $3 RETURNING *`,
      [newBalance, newTotalWithdrawn, email]
    );

    const reference = method === 'bank' ? `${bankName} · ${destination}` : destination;
    await client.query(
      `INSERT INTO transactions (user_email, type, amount, reference, status)
       VALUES ($1, 'withdrawal', $2, $3, 'pending')`,
      [email, amt, reference]
    );

    await client.query('COMMIT');
    res.json({ success: true, user: serializeUser(updateResult.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/user/withdraw failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

// ---- POST /api/user/reset — wipe a user's progress (used by the app's reset button) ----
app.post('/api/user/reset', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    clearSessionCookie(res);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/user/reset failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- Health check (useful for Railway) ----
app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] Lumina listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('[server] Failed to initialize database schema:', err);
    process.exit(1);
  });
