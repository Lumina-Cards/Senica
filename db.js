// db.js — PostgreSQL connection pool + schema bootstrap.
// Railway automatically injects DATABASE_URL when you attach a Postgres
// plugin to this service, so no manual config is needed in production.
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[db] DATABASE_URL is not set. Add a PostgreSQL plugin in Railway ' +
    '(or set DATABASE_URL locally) before starting the server.'
  );
}

const pool = new Pool({
  connectionString,
  // Railway's managed Postgres requires SSL; disable only for local dev
  // against a non-SSL database by setting PGSSL=disable.
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email                 TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      payout_destination    TEXT NOT NULL DEFAULT '',
      balance               NUMERIC(12,2) NOT NULL DEFAULT 0,
      bonus_balance         NUMERIC(12,2) NOT NULL DEFAULT 0,
      current_task_tier     INTEGER NOT NULL DEFAULT 1,
      completed_tiers       INTEGER[] NOT NULL DEFAULT '{}',
      completed_bonus_tasks TEXT[] NOT NULL DEFAULT '{}',
      total_withdrawn       NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          SERIAL PRIMARY KEY,
      user_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      type        TEXT NOT NULL,       -- 'task' | 'bonus_task' | 'daily_bonus' | 'withdrawal'
      amount      NUMERIC(12,2) NOT NULL,
      reference   TEXT,
      status      TEXT NOT NULL DEFAULT 'success', -- 'success' | 'pending' | 'failed'
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_user_email
      ON transactions (user_email, created_at DESC);
  `);

  console.log('[db] Schema ready.');
}

module.exports = { pool, initSchema };
