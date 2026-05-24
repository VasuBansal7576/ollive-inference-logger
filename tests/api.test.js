import test from 'node:test';
import assert from 'node:assert';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';

// Force dynamic test port and isolated database
process.env.PORT = '0';
process.env.DB_PATH = 'data/test-api.db';
process.env.INGEST_TOKEN = 'test_ingest_token';
process.env.ADMIN_TOKEN = 'test_admin_token';

// Import server which triggers initialization on dynamic port
const { server } = await import('../src/server.js');
const { getDb } = await import('../src/db.js');
const { closeWorker } = await import('../src/redactor.js');

let baseUrl = '';

test.before(() => {
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;
});

test.after(async () => {
  // Close HTTP server cleanly
  await new Promise((resolve) => server.close(resolve));
  // Terminate redactor worker pool
  closeWorker();
  // Close database cleanly
  try {
    getDb().close();
  } catch {}
  
  // Remove test DB files
  const testDb = join(process.cwd(), 'data', 'test-api.db');
  if (existsSync(testDb)) {
    try { unlinkSync(testDb); } catch {}
  }
  const testDbWal = join(process.cwd(), 'data', 'test-api.db-wal');
  if (existsSync(testDbWal)) {
    try { unlinkSync(testDbWal); } catch {}
  }
  const testDbShm = join(process.cwd(), 'data', 'test-api.db-shm');
  if (existsSync(testDbShm)) {
    try { unlinkSync(testDbShm); } catch {}
  }
});

test('API Ingestion — Reject Unauthenticated Requests', async () => {
  const res = await fetch(`${baseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'r1', provider: 'groq', model: 'llama3' })
  });

  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.strictEqual(data.error.includes('Unauthorized'), true);
});

test('API Ingestion — Accept Valid Payload with Token', async () => {
  const payload = {
    requestId: 'req_test_1',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    status: 'success',
    latencyMs: 120,
    inputTokens: 10,
    outputTokens: 15,
    inputPreview: 'Hello test user',
    outputPreview: 'Hello back from groq model'
  };

  const res = await fetch(`${baseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test_ingest_token'
    },
    body: JSON.stringify(payload)
  });

  assert.strictEqual(res.status, 201);
  const data = await res.json();
  assert.strictEqual(data.status, 'ingested');
  assert.strictEqual(data.request_id, 'req_test_1');
});

test('API Ingestion — Reject Malformed Payload', async () => {
  const payload = {
    // Missing requestId
    provider: 'groq',
    model: 'llama-3.3-70b-versatile'
  };

  const res = await fetch(`${baseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test_ingest_token'
    },
    body: JSON.stringify(payload)
  });

  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error.includes('Missing requestId'), true);
});

test('API Admin Endpoints — Reject Unauthenticated Metrics', async () => {
  const res = await fetch(`${baseUrl}/api/metrics`, { method: 'GET' });
  assert.strictEqual(res.status, 401);
});

test('API Admin Endpoints — Return Valid Metrics with Token', async () => {
  const res = await fetch(`${baseUrl}/api/metrics`, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer test_admin_token' }
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(typeof data.total_calls, 'number');
  assert.strictEqual(typeof data.total_tokens, 'number');
  assert.strictEqual(typeof data.total_cost, 'number');
  assert.strictEqual(typeof data.pii.total_redacted, 'number');
});

test('API Health — Publicly Reachable', async () => {
  const res = await fetch(`${baseUrl}/api/health`, { method: 'GET' });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, 'ok');
});
