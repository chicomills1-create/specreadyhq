'use strict';
/*
 * SpecReady order service.
 *
 * Order-first flow (Director cure order 2026-11-15; ChatGPT review adopted):
 *   1. POST /orders validates + SAVES the order and issues the SR reference
 *      BEFORE any payment exists. The record survives abandonment.
 *   2. A per-order Stripe Checkout Session is created server-side, carrying
 *      the SR reference as client_reference_id + metadata.
 *   3. Stripe webhooks (signature-verified, idempotent) reconcile payment
 *      state onto the order record. The confirmation page reads status from
 *      GET /orders/:ref/status — never from a URL parameter's say-so.
 *
 * Secrets live only in env: DATABASE_URL, STRIPE_SECRET_KEY,
 * STRIPE_WEBHOOK_SECRET, LOOKUP_SECRET, OPS_KEY.
 * Prices live only in env (STRIPE_PRICE_<PACKAGE>), never from the client.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Stripe = require('stripe');

const PORT = process.env.PORT || 8080;
const SITE_URL = (process.env.SITE_URL || 'https://specreadyhq.com').replace(/\/$/, '');
const POLICY_VERSION = process.env.POLICY_VERSION || 'v2-2026-11-01';
const ALLOWED_ORIGINS = new Set([SITE_URL, 'http://localhost:8901', 'http://127.0.0.1:8901']);

const PACKAGES = {
  capability: { label: 'Capability Statement', amount_cents: 14900, priceEnv: 'STRIPE_PRICE_CAPABILITY' },
  soq:        { label: 'SOQ Package',        amount_cents: 34900, priceEnv: 'STRIPE_PRICE_SOQ' },
  pursuit:    { label: 'Pursuit Package',    amount_cents: 59900, priceEnv: 'STRIPE_PRICE_PURSUIT' },
  update:     { label: 'Update Pass',        amount_cents: 9900,  priceEnv: 'STRIPE_PRICE_UPDATE' },
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_missing');

function lookupToken(ref) {
  return crypto.createHmac('sha256', process.env.LOOKUP_SECRET || '').update(ref).digest('hex').slice(0, 32);
}
function tokenOk(ref, token) {
  if (!token || typeof token !== 'string') return false;
  const expected = lookupToken(ref);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ops-Key');
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, limit = 1024 * 64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Basic per-IP rate limit on order creation (in-memory; pilot scale). */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

async function createOrder(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many requests. Please try again later, or email info@specreadyhq.com.' });

  let data;
  try { data = JSON.parse((await readBody(req)).toString('utf8')); }
  catch { return sendJson(res, 400, { error: 'Invalid request body.' }); }

  const pkg = PACKAGES[data.package_key];
  const firm = String(data.firm || '').trim();
  const contact = String(data.contact_name || '').trim();
  const email = String(data.email || '').trim();
  const pursuit = String(data.pursuit || '').trim().slice(0, 2000);
  if (!pkg) return sendJson(res, 400, { error: 'Unknown package.' });
  if (!firm || !contact) return sendJson(res, 400, { error: 'Firm and contact name are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'A valid email is required.' });
  if (data.policy_ack !== true) return sendJson(res, 400, { error: 'The policy acknowledgment is required to place an order.' });

  /* 1) Save the order FIRST. The record exists from this moment. */
  const ins = await pool.query(
    `INSERT INTO orders (package_key, package_label, amount_cents, firm, contact_name, email, pursuit, policy_version, policy_accepted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING id, created_at`,
    [data.package_key, pkg.label, pkg.amount_cents, firm, contact, email, pursuit || null, POLICY_VERSION]
  );
  const id = ins.rows[0].id;
  const day = new Date(ins.rows[0].created_at).toISOString().slice(0, 10).replace(/-/g, '');
  const ref = `SR-${day}-${String(id).padStart(4, '0')}`;
  await pool.query('UPDATE orders SET ref = $1 WHERE id = $2', [ref, id]);

  /* 2) Create the per-order Checkout Session. If this fails, the order
        still stands and the buyer gets the reference + a retry path. */
  const priceId = process.env[pkg.priceEnv];
  try {
    if (!priceId) throw new Error(`missing env ${pkg.priceEnv}`);
    const token = lookupToken(ref);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: ref,
      metadata: { order_ref: ref },
      success_url: `${SITE_URL}/order-confirmed.html?ref=${ref}&t=${token}`,
      cancel_url: `${SITE_URL}/?order=${ref}#order`,
    });
    await pool.query('UPDATE orders SET stripe_session_id = $1, updated_at = now() WHERE id = $2', [session.id, id]);
    return sendJson(res, 201, { ref, checkout_url: session.url });
  } catch (err) {
    console.error('checkout session creation failed for', ref, err.message);
    return sendJson(res, 201, {
      ref,
      checkout_url: null,
      note: 'Your order is recorded. The payment step could not be opened just now — we will email your secure payment link with your acknowledgment. Keep your order reference.',
    });
  }
}

async function orderStatus(req, res, ref, url) {
  if (!tokenOk(ref, url.searchParams.get('t'))) return sendJson(res, 403, { error: 'Unknown order reference.' });
  const r = await pool.query(
    'SELECT ref, package_label, amount_cents, order_status, payment_status FROM orders WHERE ref = $1', [ref]);
  if (!r.rows.length) return sendJson(res, 404, { error: 'Unknown order reference.' });
  return sendJson(res, 200, r.rows[0]);
}

async function handleWebhook(req, res) {
  const raw = await readBody(req, 1024 * 1024);
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    return sendJson(res, 400, { error: 'Signature verification failed.' });
  }
  /* Idempotency: one processing per event id. */
  const seen = await pool.query(
    'INSERT INTO webhook_events (event_id, event_type) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
    [event.id, event.type]);
  if (!seen.rows.length) return sendJson(res, 200, { received: true, duplicate: true });

  const s = event.data && event.data.object ? event.data.object : {};
  const ref = s.client_reference_id || (s.metadata && s.metadata.order_ref) || null;
  try {
    if (event.type === 'checkout.session.completed' && ref) {
      const paid = s.payment_status === 'paid';
      await pool.query(
        `UPDATE orders SET payment_status = $1, order_status = $2, stripe_session_id = $3,
                stripe_payment_intent_id = $4, updated_at = now() WHERE ref = $5`,
        [paid ? 'paid' : 'processing', paid ? 'recorded' : 'awaiting_payment', s.id, s.payment_intent || null, ref]);
    } else if (event.type === 'checkout.session.async_payment_succeeded' && ref) {
      await pool.query(
        `UPDATE orders SET payment_status = 'paid', order_status = 'recorded',
                stripe_payment_intent_id = $1, updated_at = now() WHERE ref = $2`,
        [s.payment_intent || null, ref]);
    } else if (event.type === 'checkout.session.async_payment_failed' && ref) {
      await pool.query(
        `UPDATE orders SET payment_status = 'failed', updated_at = now() WHERE ref = $1`, [ref]);
    } else if (event.type === 'charge.refunded' && s.payment_intent) {
      await pool.query(
        `UPDATE orders SET payment_status = 'refunded', updated_at = now() WHERE stripe_payment_intent_id = $1`,
        [s.payment_intent]);
    }
  } catch (err) {
    console.error('webhook processing failed', event.id, err.message);
    return sendJson(res, 500, { error: 'Processing failed; Stripe will retry.' });
  }
  return sendJson(res, 200, { received: true });
}

async function queue(req, res) {
  if (!process.env.OPS_KEY || req.headers['x-ops-key'] !== process.env.OPS_KEY) {
    return sendJson(res, 403, { error: 'Forbidden.' });
  }
  const r = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
  return sendJson(res, 200, { orders: r.rows });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/orders') return await createOrder(req, res);
    const m = url.pathname.match(/^\/orders\/([A-Za-z0-9-]+)\/status$/);
    if (req.method === 'GET' && m) return await orderStatus(req, res, m[1], url);
    if (req.method === 'POST' && url.pathname === '/webhooks/stripe') return await handleWebhook(req, res);
    if (req.method === 'GET' && url.pathname === '/queue') return await queue(req, res);
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error('request failed', req.method, url.pathname, err.message);
    return sendJson(res, 500, { error: 'Something went wrong on our side. Your request was not completed — please try again or email info@specreadyhq.com.' });
  }
});

// Boot-time schema ensure: schema.sql is idempotent (CREATE TABLE IF NOT
// EXISTS), so every deploy self-initializes a fresh database. A failure is
// logged, never fatal — /health stays up and the error stays visible.
async function ensureSchema() {
  if (!process.env.DATABASE_URL) { console.log('DATABASE_URL unset — schema ensure skipped'); return; }
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('schema ensured (orders, webhook_events)');
  } catch (e) {
    console.error('schema ensure FAILED:', e.message);
  }
}

ensureSchema().then(() => server.listen(PORT, () => console.log(`specready-order-service listening on ${PORT}`)));
