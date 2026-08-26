const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for persistent memory");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initStorage() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS freshly_case_seq START 1;

    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message_role TEXT NOT NULL CHECK (message_role IN ('user','assistant')),
      content TEXT NOT NULL,
      external_message_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_phone_created
      ON conversation_messages(phone, created_at DESC);

    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      customer_phone TEXT NOT NULL,
      customer_id BIGINT REFERENCES customers(id),
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      management_decision TEXT,
      closed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cases_open
      ON cases(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cases_customer
      ON cases(customer_phone, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS alert_dedupe (
      alert_key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inbound_events (
      external_message_id TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const result = await pool.query("SELECT NOW() AS now");
  console.log("✅ PostgreSQL persistent memory ready:", result.rows[0].now);
}

async function claimInboundEvent(externalMessageId) {
  if (!externalMessageId) return true;
  const result = await pool.query(
    `INSERT INTO inbound_events(external_message_id)
     VALUES($1)
     ON CONFLICT (external_message_id) DO NOTHING
     RETURNING external_message_id`,
    [externalMessageId]
  );
  return result.rowCount === 1;
}

async function ensureCustomer(phone) {
  const result = await pool.query(
    `INSERT INTO customers(phone)
     VALUES($1)
     ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()
     RETURNING id, phone`,
    [phone]
  );
  const row = result.rows[0];
  return {
    id: Number(row.id),
    phone: row.phone,
    customerCode: `FL-C${String(row.id).padStart(6, "0")}`
  };
}

async function getHistory(phone, limit = 12) {
  const result = await pool.query(
    `SELECT message_role AS role, content
     FROM conversation_messages
     WHERE phone = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [phone, limit]
  );
  return result.rows.reverse();
}

async function addMessage({ phone, senderRole, role, content, externalMessageId = null }) {
  const text = String(content || "").trim();
  if (!text) return;
  await pool.query(
    `INSERT INTO conversation_messages(phone, sender_role, message_role, content, external_message_id)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (external_message_id) DO NOTHING`,
    [phone, senderRole, role, text, externalMessageId]
  );
}

async function nextCaseId() {
  const seqResult = await pool.query("SELECT nextval('freshly_case_seq') AS seq");
  const seq = String(seqResult.rows[0].seq).padStart(6, "0");
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return `FL-${date}-${seq}`;
}

function mapCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerNumber: row.customer_phone,
    customerId: row.customer_id ? Number(row.customer_id) : null,
    customerCode: row.customer_id ? `FL-C${String(row.customer_id).padStart(6, "0")}` : null,
    type: row.type,
    summary: row.summary,
    action: row.action,
    status: row.status,
    managementDecision: row.management_decision,
    closedBy: row.closed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createOrRefreshCase(customerPhone, alert) {
  const customer = await ensureCustomer(customerPhone);
  const existing = await pool.query(
    `SELECT * FROM cases
     WHERE customer_phone = $1 AND status = 'OPEN' AND type = $2
     ORDER BY updated_at DESC
     LIMIT 1`,
    [customerPhone, alert.type]
  );

  if (existing.rowCount) {
    const updated = await pool.query(
      `UPDATE cases
       SET summary = $2, action = $3, customer_id = $4, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [existing.rows[0].id, alert.summary, alert.action, customer.id]
    );
    return mapCase(updated.rows[0]);
  }

  const caseId = await nextCaseId();
  const inserted = await pool.query(
    `INSERT INTO cases(id, customer_phone, customer_id, type, summary, action)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [caseId, customerPhone, customer.id, alert.type, alert.summary, alert.action]
  );
  return mapCase(inserted.rows[0]);
}

async function getOpenCases() {
  const result = await pool.query(
    `SELECT * FROM cases WHERE status = 'OPEN' ORDER BY updated_at DESC`
  );
  return result.rows.map(mapCase);
}

async function getOpenCaseById(caseId) {
  const result = await pool.query(
    `SELECT * FROM cases WHERE id = $1 AND status = 'OPEN' LIMIT 1`,
    [caseId]
  );
  return mapCase(result.rows[0]);
}

async function getOpenCasesByPhone(phone) {
  const result = await pool.query(
    `SELECT * FROM cases WHERE customer_phone = $1 AND status = 'OPEN' ORDER BY updated_at DESC`,
    [phone]
  );
  return result.rows.map(mapCase);
}

async function closeCase(caseId, { closedBy, managementDecision }) {
  const result = await pool.query(
    `UPDATE cases
     SET status = 'CLOSED', closed_by = $2, management_decision = $3, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [caseId, closedBy || null, managementDecision || null]
  );
  return mapCase(result.rows[0]);
}

async function shouldSendAlert(customerNumber, alert, dedupeMs) {
  const alertKey = `${customerNumber}:${alert.type}`;
  const fingerprint = `${alert.summary}|${alert.action}`.toLowerCase().replace(/\s+/g, " ").trim();
  const result = await pool.query(
    `SELECT fingerprint, sent_at FROM alert_dedupe WHERE alert_key = $1`,
    [alertKey]
  );

  if (result.rowCount) {
    const previous = result.rows[0];
    const age = Date.now() - new Date(previous.sent_at).getTime();
    if (previous.fingerprint === fingerprint && age < dedupeMs) return false;
  }

  await pool.query(
    `INSERT INTO alert_dedupe(alert_key, fingerprint, sent_at)
     VALUES($1,$2,NOW())
     ON CONFLICT (alert_key)
     DO UPDATE SET fingerprint = EXCLUDED.fingerprint, sent_at = NOW()`,
    [alertKey, fingerprint]
  );
  return true;
}

async function healthCheck() {
  const result = await pool.query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}

module.exports = {
  initStorage,
  healthCheck,
  claimInboundEvent,
  ensureCustomer,
  getHistory,
  addMessage,
  createOrRefreshCase,
  getOpenCases,
  getOpenCaseById,
  getOpenCasesByPhone,
  closeCase,
  shouldSendAlert
};
