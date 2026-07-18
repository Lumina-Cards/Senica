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
const { pool, initSchema } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Reward configuration (must mirror the constants in public/index.html) ----
const NUM_TASKS = 10;
const TASK_REWARD_BASE = 95;
const TASK_REWARD_STEP = 115;
const BONUS_TASK_REWARD = 15;
const BONUS_TASK_IDS = ['bonus1', 'bonus2'];

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

    const result = await pool.query(
      `INSERT INTO users (email, name, payout_destination)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             payout_destination = EXCLUDED.payout_destination
       RETURNING *`,
      [email, name, payoutDestination || '']
    );

    res.json(serializeUser(result.rows[0]));
  } catch (err) {
    console.error('POST /api/user/sync failed:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
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
  const client = await pool.connect();
  try {
    const { email, tierId } = req.body || {};
    const tier = parseInt(tierId, 10);

    if (!isValidEmail(email) || !Number.isInteger(tier) || tier < 1 || tier > NUM_TASKS) {
      return res.status(400).json({ error: 'Invalid email or tier.' });
    }

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
    const newBalance = Number(user.balance) + reward;

    const updateResult = await client.query(
      `UPDATE users
       SET balance = $1, current_task_tier = $2, completed_tiers = $3
       WHERE email = $4
       RETURNING *`,
      [newBalance, newCurrentTier, newCompletedTiers, email]
    );

    await client.query(
      `INSERT INTO transactions (user_email, type, amount, reference, status)
       VALUES ($1, 'task', $2, $3, 'success')`,
      [email, reward, `Task Tier ${tier}`]
    );

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
  const client = await pool.connect();
  try {
    const { email, bonusTaskId } = req.body || {};

    if (!isValidEmail(email) || !BONUS_TASK_IDS.includes(bonusTaskId)) {
      return res.status(400).json({ error: 'Invalid email or bonus task id.' });
    }

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
    const tier1Cleared = (user.completed_tiers || []).includes(1);

    const newBalance = tier1Cleared ? Number(user.balance) + reward : Number(user.balance);
    const newBonusBalance = tier1Cleared ? Number(user.bonus_balance) : Number(user.bonus_balance) + reward;

    const updateResult = await client.query(
      `UPDATE users
       SET balance = $1, bonus_balance = $2, completed_bonus_tasks = $3
       WHERE email = $4
       RETURNING *`,
      [newBalance, newBonusBalance, newCompletedBonusTasks, email]
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

// ---- POST /api/user/withdraw — request a payout ----
// Deducts from the user's balance and logs a 'pending' transaction.
// This service does not move real money; fulfill payouts through your
// own PayPal / Mobile Money / bank process and mark the transaction
// 'success' afterward (see the admin note in transactions table).
app.post('/api/user/withdraw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, amount, method, destination, bankName } = req.body || {};
    const amt = parseFloat(amount);
    const validMethods = ['paypal', 'momo', 'bank'];

    if (!isValidEmail(email) || !validMethods.includes(method) || !destination || isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Missing or invalid withdrawal fields.' });
    }
    if (method === 'bank' && !bankName) {
      return res.status(400).json({ error: 'Bank name is required for bank withdrawals.' });
    }

    await client.query('BEGIN');

    const userResult = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found. Register first.' });
    }
    const user = userResult.rows[0];

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
