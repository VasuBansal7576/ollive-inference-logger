import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getDb, createSession, getSession, getAllSessions, updateSession, addMessage, getMessages } from './db.js';
import { LLMSdk } from './sdk.js';
import { createPipeline, processExternalLog } from './pipeline.js';
import { getMetrics } from './metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// --- Init ---
const db = getDb();
const sdk = new LLMSdk();
createPipeline(sdk);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// Track in-flight requests by session so we can abort them
const activeRequests = new Map();

// --- Routes ---

// GET /api/providers
app.get('/api/providers', (req, res) => {
  res.json(sdk.getAvailableProviders());
});

// POST /api/chat (SSE)
app.post('/api/chat', async (req, res) => {
  const { provider, model, message } = req.body;
  let { session_id } = req.body;

  if (!provider || !message) {
    return res.status(400).json({ error: 'provider and message are required' });
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

    // Abort controller for cancellation
    const controller = new AbortController();
    activeRequests.set(session_id, controller);

    // Handle client disconnect
    res.on('close', () => {
      if (!controller.signal.aborted) {
        controller.abort();
        console.log(`[server] Client disconnected, aborting session ${session_id}`);
      }
      activeRequests.delete(session_id);
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
app.get('/api/sessions', (req, res) => {
  try {
    res.json(getAllSessions());
  } catch (err) {
    console.error('[server] Sessions list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id
app.get('/api/sessions/:id', (req, res) => {
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
app.patch('/api/sessions/:id', (req, res) => {
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
app.get('/api/metrics', (req, res) => {
  try {
    res.json(getMetrics(db));
  } catch (err) {
    console.error('[server] Metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simple in-memory rate-limiter state
const rateLimits = new Map();
setInterval(() => rateLimits.clear(), 60000); // Reset every 1 minute

// POST /api/ingest (Secured & Optimized Ingestion)
app.post('/api/ingest', express.json({ limit: '10kb' }), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const hits = rateLimits.get(ip) || 0;

  if (hits >= 100) {
    return res.status(429).json({ error: 'Too many requests. Limit is 100 per minute.' });
  }
  rateLimits.set(ip, hits + 1);

  // Bearer Token Validation
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== 'Bearer ollive_secure_ingest_token_2026') {
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

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Start ---
app.listen(PORT, () => {
  const providers = sdk.getAvailableProviders();
  console.log(`\n🫒 Ollive server running on http://localhost:${PORT}`);
  console.log(`   Available providers: ${providers.length > 0 ? providers.map(p => p.name).join(', ') : 'none (set API keys in .env)'}`);
  console.log(`   Database: data/ollive.db (WAL mode)\n`);
});
