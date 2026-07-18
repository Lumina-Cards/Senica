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
const crypto = require('crypto');
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

// ---- Admin dashboard auth ----
// A single shared password (ADMIN_PASSWORD) gates /admin/api/*. On success we
// set a signed, httpOnly cookie — same mechanism as the user session cookie,
// just a different name/secret so the two can never be confused with one
// another. There is no admin "account" system; this is meant for a small,
// trusted operator team managing the app, not multi-user RBAC.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.warn('[server] ADMIN_PASSWORD is not set — the /admin dashboard is disabled until you set it.');
}
const ADMIN_COOKIE_NAME = 'lumina_admin_session';
const ADMIN_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours — short-lived, re-login for a new shift

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // burn roughly the same time either way
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});
const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/admin/api/', adminApiLimiter);

app.post('/admin/api/login', adminLoginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin dashboard is not configured. Set ADMIN_PASSWORD on the server.' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !timingSafeEqualStr(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  res.cookie(ADMIN_COOKIE_NAME, 'ok', {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_COOKIE_MAX_AGE_MS
  });
  res.json({ success: true });
});

app.post('/admin/api/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME);
  res.json({ success: true });
});

function requireAdmin(req, res, next) {
  if (req.signedCookies && req.signedCookies[ADMIN_COOKIE_NAME] === 'ok') {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated.' });
}

app.get('/admin/api/session', (req, res) => {
  res.json({ authenticated: !!(req.signedCookies && req.signedCookies[ADMIN_COOKIE_NAME] === 'ok') });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

// ==================== Admin data API ====================
// Everything below requires the admin cookie set by POST /admin/api/login.

// ---- GET /admin/api/stats — headline numbers for the overview tab ----
app.get('/admin/api/stats', requireAdmin, async (req, res) => {
  try {
    const [users, balances, withdrawals, pending, today] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM users'),
      pool.query('SELECT COALESCE(SUM(balance),0)::float AS outstanding, COALESCE(SUM(bonus_balance),0)::float AS locked_bonus FROM users'),
      pool.query("SELECT COALESCE(SUM(total_withdrawn),0)::float AS total_withdrawn FROM users"),
      pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0)::float AS amount FROM transactions WHERE type = 'withdrawal' AND status = 'pending'"),
      pool.query("SELECT COUNT(*)::int AS count FROM users WHERE created_at > now() - interval '24 hours'")
    ]);

    res.json({
      totalUsers: users.rows[0].count,
      outstandingBalance: balances.rows[0].outstanding,
      lockedBonusBalance: balances.rows[0].locked_bonus,
      totalWithdrawnAllTime: withdrawals.rows[0].total_withdrawn,
      pendingWithdrawals: { count: pending.rows[0].count, amount: pending.rows[0].amount },
      newUsersLast24h: today.rows[0].count
    });
  } catch (err) {
    console.error('GET /admin/api/stats failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /admin/api/users — paginated, searchable user list ----
app.get('/admin/api/users', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
    const q = (req.query.q || '').trim();

    const params = [];
    let whereClause = '';
    if (q) {
      params.push(`%${q}%`);
      whereClause = `WHERE email ILIKE $${params.length} OR name ILIKE $${params.length}`;
    }

    const sortableColumns = new Set(['created_at', 'balance', 'total_withdrawn', 'current_task_tier', 'email', 'name']);
    const sortBy = sortableColumns.has(req.query.sortBy) ? req.query.sortBy : 'created_at';
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM users ${whereClause}`, params);
    const total = countResult.rows[0].count;

    params.push(pageSize, (page - 1) * pageSize);
    const rowsResult = await pool.query(
      `SELECT email, name, payout_destination, balance, bonus_balance, current_task_tier,
              completed_tiers, completed_bonus_tasks, total_withdrawn, last_daily_bonus_at, created_at
       FROM users
       ${whereClause}
       ORDER BY ${sortBy} ${sortDir}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      total,
      page,
      pageSize,
      users: rowsResult.rows.map(serializeUser)
    });
  } catch (err) {
    console.error('GET /admin/api/users failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /admin/api/users/:email — full detail + recent transactions ----
app.get('/admin/api/users/:email', requireAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });

    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const txResult = await pool.query(
      `SELECT id, type, amount, reference, status, created_at
       FROM transactions WHERE user_email = $1 ORDER BY created_at DESC LIMIT 100`,
      [email]
    );

    res.json({ user: serializeUser(userResult.rows[0]), transactions: txResult.rows });
  } catch (err) {
    console.error('GET /admin/api/users/:email failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PATCH /admin/api/users/:email — manual balance/tier/profile correction ----
// Any balance change is logged as an 'admin_adjustment' transaction so the
// transaction history always explains where a balance change came from —
// there is no silent editing of money fields.
app.patch('/admin/api/users/:email', requireAdmin, async (req, res) => {
  const { email } = req.params;
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });

  const { balance, bonusBalance, currentTaskTier, payoutDestination, name, adjustmentNote } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    const user = userResult.rows[0];

    const nextBalance = balance !== undefined && balance !== null && balance !== '' ? parseFloat(balance) : Number(user.balance);
    const nextBonus = bonusBalance !== undefined && bonusBalance !== null && bonusBalance !== '' ? parseFloat(bonusBalance) : Number(user.bonus_balance);
    const nextTier = currentTaskTier !== undefined && currentTaskTier !== null && currentTaskTier !== '' ? parseInt(currentTaskTier, 10) : user.current_task_tier;
    const nextDestination = payoutDestination !== undefined ? String(payoutDestination).slice(0, 200) : user.payout_destination;
    const nextName = name !== undefined && String(name).trim() ? String(name).slice(0, 120) : user.name;

    if ([nextBalance, nextBonus].some((n) => isNaN(n) || n < 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Balance fields must be non-negative numbers.' });
    }
    if (!Number.isInteger(nextTier) || nextTier < 1 || nextTier > NUM_TASKS) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Task tier must be an integer between 1 and ${NUM_TASKS}.` });
    }

    const balanceDelta = nextBalance - Number(user.balance);
    const bonusDelta = nextBonus - Number(user.bonus_balance);

    const updateResult = await client.query(
      `UPDATE users
       SET balance = $1, bonus_balance = $2, current_task_tier = $3, payout_destination = $4, name = $5
       WHERE email = $6
       RETURNING *`,
      [nextBalance, nextBonus, nextTier, nextDestination, nextName, email]
    );

    if (balanceDelta !== 0) {
      await client.query(
        `INSERT INTO transactions (user_email, type, amount, reference, status)
         VALUES ($1, 'admin_adjustment', $2, $3, 'success')`,
        [email, balanceDelta, `Balance adjusted by admin${adjustmentNote ? `: ${String(adjustmentNote).slice(0, 200)}` : ''}`]
      );
    }
    if (bonusDelta !== 0) {
      await client.query(
        `INSERT INTO transactions (user_email, type, amount, reference, status)
         VALUES ($1, 'admin_adjustment', $2, $3, 'success')`,
        [email, bonusDelta, `Locked bonus balance adjusted by admin${adjustmentNote ? `: ${String(adjustmentNote).slice(0, 200)}` : ''}`]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, user: serializeUser(updateResult.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /admin/api/users/:email failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

// ---- DELETE /admin/api/users/:email — remove a user (support/GDPR requests) ----
app.delete('/admin/api/users/:email', requireAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
    const result = await pool.query('DELETE FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /admin/api/users/:email failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /admin/api/transactions — paginated, filterable transaction ledger ----
app.get('/admin/api/transactions', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
    const { status, type, q } = req.query;

    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
    if (type) { params.push(type); conditions.push(`t.type = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conditions.push(`(t.user_email ILIKE $${params.length} OR t.reference ILIKE $${params.length})`); }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM transactions t ${whereClause}`, params);
    const total = countResult.rows[0].count;

    params.push(pageSize, (page - 1) * pageSize);
    const rowsResult = await pool.query(
      `SELECT t.id, t.user_email, u.name AS user_name, t.type, t.amount, t.reference, t.status, t.created_at
       FROM transactions t
       LEFT JOIN users u ON u.email = t.user_email
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ total, page, pageSize, transactions: rowsResult.rows });
  } catch (err) {
    console.error('GET /admin/api/transactions failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PATCH /admin/api/transactions/:id — mark a withdrawal paid/failed/pending ----
// This is the manual step referenced in the withdrawal handler's comments:
// the app never calls a real payment API, so an operator sends the payout
// through PayPal/MoMo/bank themselves and then records the outcome here.
// Marking a pending withdrawal 'failed' refunds the amount back to the
// user's balance; marking it 'success' does not move any additional money
// (the balance was already debited when the withdrawal was requested).
app.patch('/admin/api/transactions/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  const validStatuses = ['pending', 'success', 'failed'];
  if (!Number.isInteger(id) || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid transaction id or status.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txResult = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
    if (txResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    const tx = txResult.rows[0];

    if (tx.status === status) {
      await client.query('ROLLBACK');
      return res.json({ success: true, transaction: tx, note: 'No change — status was already set.' });
    }

    // Refund the user if a previously-pending withdrawal is being marked failed.
    if (tx.type === 'withdrawal' && tx.status === 'pending' && status === 'failed') {
      await client.query(
        'UPDATE users SET balance = balance + $1, total_withdrawn = total_withdrawn - $1 WHERE email = $2',
        [tx.amount, tx.user_email]
      );
    }
    // Reverse that refund if an operator flips a 'failed' withdrawal back to pending/success.
    if (tx.type === 'withdrawal' && tx.status === 'failed' && status !== 'failed') {
      await client.query(
        'UPDATE users SET balance = balance - $1, total_withdrawn = total_withdrawn + $1 WHERE email = $2',
        [tx.amount, tx.user_email]
      );
    }

    const updateResult = await client.query(
      'UPDATE transactions SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    await client.query('COMMIT');
    res.json({ success: true, transaction: updateResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /admin/api/transactions/:id failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
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
