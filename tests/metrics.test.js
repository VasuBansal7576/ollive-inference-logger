import test from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { getMetrics } from '../src/metrics.js';

function createMockDb() {
  const db = new Database(':memory:');
  
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'active',
      provider TEXT,
      model TEXT,
      message_count INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      request_id TEXT UNIQUE,
      provider TEXT,
      model TEXT,
      status TEXT,
      latency_ms REAL,
      time_to_first_token_ms REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      tokens_per_second REAL,
      cost_estimate REAL,
      input_preview TEXT,
      output_preview TEXT,
      pii_types_detected TEXT,
      pii_redacted INTEGER DEFAULT 0,
      error_message TEXT,
      error_code TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

test('Metrics Aggregation — Empty Database', () => {
  const db = createMockDb();
  const metrics = getMetrics(db);

  assert.strictEqual(metrics.total_calls, 0);
  assert.strictEqual(metrics.total_tokens, 0);
  assert.strictEqual(metrics.latency_p50, 0);
  assert.strictEqual(metrics.error_rate, 0);
  assert.deepStrictEqual(metrics.provider_breakdown, {});
  assert.strictEqual(metrics.total_cost, 0);
  assert.deepStrictEqual(metrics.recent_logs, []);
});

test('Metrics Aggregation — Seeded Data', () => {
  const db = createMockDb();

  // Seed sessions
  db.prepare(`
    INSERT INTO sessions (id, provider, model, title, message_count) 
    VALUES ('s1', 'groq', 'llama-3', 'Test Chat 1', 2)
  `).run();
  
  db.prepare(`
    INSERT INTO sessions (id, provider, model, title, message_count) 
    VALUES ('s2', 'gemini', 'gemini-flash', 'Test Chat 2', 2)
  `).run();

  // Seed success logs
  db.prepare(`
    INSERT INTO logs (session_id, request_id, provider, model, status, latency_ms, time_to_first_token_ms, input_tokens, output_tokens, total_tokens, tokens_per_second, cost_estimate, pii_redacted, pii_types_detected, created_at)
    VALUES ('s1', 'r1', 'groq', 'llama-3', 'success', 300.0, 100.0, 10, 20, 30, 66.67, 0.0001, 1, '["EMAIL"]', '2026-05-23 12:00:00')
  `).run();

  db.prepare(`
    INSERT INTO logs (session_id, request_id, provider, model, status, latency_ms, time_to_first_token_ms, input_tokens, output_tokens, total_tokens, tokens_per_second, cost_estimate, pii_redacted, created_at)
    VALUES ('s1', 'r2', 'groq', 'llama-3', 'success', 500.0, 120.0, 15, 25, 40, 62.50, 0.0002, 0, '2026-05-23 12:01:00')
  `).run();

  db.prepare(`
    INSERT INTO logs (session_id, request_id, provider, model, status, latency_ms, time_to_first_token_ms, input_tokens, output_tokens, total_tokens, tokens_per_second, cost_estimate, pii_redacted, pii_types_detected, created_at)
    VALUES ('s2', 'r3', 'gemini', 'gemini-flash', 'success', 1000.0, 200.0, 20, 30, 50, 30.00, 0.0003, 1, '["PHONE"]', '2026-05-23 12:02:00')
  `).run();

  // Seed error log
  db.prepare(`
    INSERT INTO logs (session_id, request_id, provider, model, status, latency_ms, input_tokens, output_tokens, total_tokens, tokens_per_second, cost_estimate, error_message, created_at)
    VALUES ('s2', 'r4', 'gemini', 'gemini-flash', 'error', 1500.0, 0, 0, 0, 0, 0, 'API Timeout Error', '2026-05-23 12:03:00')
  `).run();

  const metrics = getMetrics(db);

  assert.strictEqual(metrics.total_calls, 4);
  assert.strictEqual(metrics.total_tokens, 120);
  assert.strictEqual(metrics.total_cost, 0.0006);
  assert.strictEqual(metrics.error_rate, 0.25); // 1 error out of 4 logs = 25%

  // Global latency: success logs are 300ms, 500ms, 1000ms. Sorted: [300, 500, 1000]. p50 index = max(0, ceil(3 * 0.5) - 1) = max(0, 2 - 1) = 1. p50 = 500ms.
  assert.strictEqual(metrics.latency_p50, 500);

  // Provider breakdowns
  assert.deepStrictEqual(metrics.provider_breakdown, {
    groq: { calls: 2 },
    gemini: { calls: 2 }
  });

  // PII stats
  assert.strictEqual(metrics.pii.total_redacted, 2);
  assert.deepStrictEqual(metrics.pii.types_breakdown, {
    EMAIL: 1,
    PHONE: 1
  });

  // Recent logs order (newest first based on ID since auto-increment matches order, wait recent_logs sorts by created_at DESC)
  assert.strictEqual(metrics.recent_logs.length, 4);
  assert.strictEqual(metrics.recent_logs[0].request_id, 'r4'); // r4 is newest
});
