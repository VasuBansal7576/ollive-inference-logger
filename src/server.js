import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getDb, createSession, getSession, getAllSessions, updateSession, addMessage, getMessages } from './db.js';
import { LLMSdk } from './sdk.js';
import { createPipeline, processExternalLog, flushBatch } from './pipeline.js';
import { getMetrics } from './metrics.js';
import { redact, closeWorker } from './redactor.js';
import { CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = CONFIG.PORT;

// --- Init ---
const db = getDb();
const sdk = new LLMSdk();
createPipeline(sdk);

const app = express();
app.set('trust proxy', 1); // Systems Insight: Trust upstream proxies for accurate rate-limiting client IP resolution
app.use(cors());

// Serve static frontend files first
app.use(express.static(join(__dirname, '..', 'public')));

// Track in-flight requests by session so we can abort them
const activeRequests = new Map();

// Admin Authentication Middleware
const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const secureToken = CONFIG.ADMIN_TOKEN;
  if (!authHeader || authHeader !== `Bearer ${secureToken}`) {
    return res.status(401).json({ error: 'Unauthorized. Valid Admin Bearer Token required.' });
  }
  next();
};

// --- Routes ---

// GET /api/health - Publicly reachable health endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Rate Limiter States and Intervals (unref'd to prevent keeping the Node.js event loop active during tests)
const chatRateLimits = new Map();
const chatInterval = setInterval(() => chatRateLimits.clear(), 60000);
if (chatInterval.unref) chatInterval.unref();

const rateLimits = new Map();
const rateInterval = setInterval(() => rateLimits.clear(), 60000);
if (rateInterval.unref) rateInterval.unref();

// POST /api/ingest (Secured & Optimized Ingestion)
// We declare this route BEFORE the global JSON parser to strictly enforce its specific 10kb body size limit.
app.post('/api/ingest', express.json({ limit: '10kb' }), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const hits = rateLimits.get(ip) || 0;

  if (hits >= 100) {
    return res.status(429).json({ error: 'Too many requests. Limit is 100 per minute.' });
  }
  rateLimits.set(ip, hits + 1);

  // Bearer Token Validation
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${CONFIG.INGEST_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized. Valid Bearer Token required.' });
  }

  try {
    const processed = await processExternalLog(req.body);
    res.status(201).json({ status: 'ingested', request_id: processed.request_id });
  } catch (err) {
    console.error('[server] Ingest error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Global standard JSON parser with a strict 100kb payload limit for other endpoints (e.g. /api/chat)
app.use(express.json({ limit: '100kb' }));

// GET /api/providers
app.get('/api/providers', adminAuth, (req, res) => {
  res.json(sdk.getAvailableProviders());
});


// POST /api/chat (SSE)
app.post('/api/chat', async (req, res) => {
  // Rate limit: max 30 chat requests per IP per minute
  const chatIp = req.ip || req.socket.remoteAddress || 'unknown';
  const chatHits = chatRateLimits.get(chatIp) || 0;
  if (chatHits >= CONFIG.RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  chatRateLimits.set(chatIp, chatHits + 1);

  const { provider, model, message } = req.body;
  let { session_id } = req.body;

  if (!provider || !message) {
    return res.status(400).json({ error: 'provider and message are required' });
  }

  if (typeof message !== 'string' || message.length > 10000) {
    return res.status(400).json({ error: 'message must be a string under 10,000 characters' });
  }

  if (!sdk.providers[provider]) {
    return res.status(400).json({ error: `Provider "${provider}" is not configured` });
  }

  try {
    // Create or fetch session
    if (!session_id) {
      session_id = uuidv4();
      const title = message.slice(0, 50) + (message.length > 50 ? '...' : '');
      createSession(session_id, provider, model || sdk.providers[provider].defaultModel, title);
    }

    // Store user message
    addMessage(session_id, 'user', message);

    // Load context (last 20 messages)
    const history = getMessages(session_id, 20);
    const messages = history.map(m => ({ role: m.role, content: m.content }));

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Check if input contains PII to immediately notify the client for PII Shield UI state
    const piiCheck = redact(message);
    if (piiCheck.redacted) {
      res.write(`data: ${JSON.stringify({ type: 'pii_redacted' })}\n\n`);
    }

    // Abort controller for cancellation
    const controller = new AbortController();
    activeRequests.set(session_id, controller);

    // Handle client disconnect (only execute if connection is closed prematurely before stream completes)
    res.on('close', () => {
      if (activeRequests.has(session_id)) {
        const ctrl = activeRequests.get(session_id);
        if (ctrl && !ctrl.signal.aborted) {
          ctrl.abort();
          console.log(`[server] Client disconnected prematurely, aborting session ${session_id}`);
        }
        activeRequests.delete(session_id);
      }
    });

    const resolvedModel = model || sdk.providers[provider].defaultModel;
    let fullResponse = '';

    const stream = sdk.chat(provider, resolvedModel, messages, session_id, controller.signal);

    for await (const chunk of stream) {
      if (controller.signal.aborted) break;

      if (chunk.type === 'delta') {
        fullResponse += chunk.content;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } else if (chunk.type === 'done') {
        // Store assistant response
        if (fullResponse) {
          addMessage(session_id, 'assistant', fullResponse);
        }
        res.write(`data: ${JSON.stringify({ type: 'done', session_id, usage: chunk.usage })}\n\n`);
      } else if (chunk.type === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: chunk.message })}\n\n`);
      }
    }

    activeRequests.delete(session_id);
    res.end();
  } catch (err) {
    console.error('[server] Chat error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

// GET /api/sessions
app.get('/api/sessions', adminAuth, (req, res) => {
  try {
    res.json(getAllSessions());
  } catch (err) {
    console.error('[server] Sessions list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id
app.get('/api/sessions/:id', adminAuth, (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const messages = getMessages(req.params.id, 100);
    res.json({ ...session, messages });
  } catch (err) {
    console.error('[server] Session detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id
app.patch('/api/sessions/:id', adminAuth, (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !['active', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // If cancelling, abort any in-flight request
    if (status === 'cancelled') {
      const controller = activeRequests.get(req.params.id);
      if (controller) {
        controller.abort();
        activeRequests.delete(req.params.id);
      }
    }

    updateSession(req.params.id, { status });
    res.json({ ...session, status });
  } catch (err) {
    console.error('[server] Session update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metrics
app.get('/api/metrics', adminAuth, (req, res) => {
  try {
    res.json(getMetrics(db));
  } catch (err) {
    console.error('[server] Metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// End of routes

// --- Start ---
const server = app.listen(PORT, () => {
  const providers = sdk.getAvailableProviders();
  console.log(`\n🫒 Ollive server running on http://localhost:${PORT}`);
  console.log(`   Available providers: ${providers.length > 0 ? providers.map(p => p.name).join(', ') : 'none (set API keys in .env)'}`);
  console.log(`   Database: data/ollive.db (WAL mode)\n`);
});

// --- Graceful Shutdown ---
const shutdown = () => {
  console.log('\n[server] Shutting down gracefully...');
  closeWorker();
  console.log('[redactor] Worker thread pool terminated.');

  // Flush any pending logs in the pipeline batch queue before closing SQLite
  try {
    flushBatch();
    console.log('[pipeline] Final log queue flushed to database.');
  } catch (err) {
    console.error('[pipeline] Error flushing batch queue on shutdown:', err.message);
  }

  server.close(() => {
    console.log('[server] HTTP server closed.');
    try {
      db.close();
      console.log('[db] SQLite connection closed.');
    } catch (err) {
      console.error('[db] Error closing SQLite connection:', err.message);
    }
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server };
