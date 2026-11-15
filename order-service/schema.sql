-- SpecReady order ledger (Neon Postgres)
-- Applied once by src/init-db.js. Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS orders (
  id                      BIGSERIAL PRIMARY KEY,
  ref                     TEXT UNIQUE,
  package_key             TEXT NOT NULL,
  package_label           TEXT NOT NULL,
  amount_cents            INTEGER NOT NULL,
  firm                    TEXT NOT NULL,
  contact_name            TEXT NOT NULL,
  email                   TEXT NOT NULL,
  pursuit                 TEXT,
  order_status            TEXT NOT NULL DEFAULT 'awaiting_payment',
  payment_status          TEXT NOT NULL DEFAULT 'unpaid',
  scope_status            TEXT NOT NULL DEFAULT 'pending_review',
  policy_version          TEXT NOT NULL,
  policy_accepted_at      TIMESTAMPTZ NOT NULL,
  stripe_session_id       TEXT,
  stripe_payment_intent_id TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_session_idx ON orders (stripe_session_id);

-- Webhook idempotency: one row per processed Stripe event id.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
