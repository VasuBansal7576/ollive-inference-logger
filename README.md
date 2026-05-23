# Ollive Inference Logger & Observability System

A high-performance, real-time LLM inference logging, observability, and ingestion dashboard. Built specifically to demonstrate how **Ollive** can capture, redact, and analyze multi-provider telemetry at scale to insure AI risk.

---

## 🚀 Quick Start

### 🐳 Option A: One-Command Docker Setup (Recommended)
You do not need to install Node or SQLite on your machine. Just run:
```bash
docker compose up --build
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

### 💻 Option B: Local Setup
Requires **Node.js (v20+)**:
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Open **[http://localhost:3000](http://localhost:3000)**.

---

## 🎯 The "Out-of-the-Box" Demo Experience

To make evaluation completely frictionless, Ollive boots in **Interactive Simulation Mode** by default:
* **No API Keys Required:** You can chat immediately!
* **Realistic Streaming & Telemetry:** The demo simulates real-time SSE token delivery, first-token latency (TTFT), and throughput.
* **PII Redaction Demonstration:** Try typing `"my email is test@example.com"` or `"phone: 555-555-1234"` and watch the live analytics dashboard update immediately with a security warning. The SQL log preview will show `[EMAIL_REDACTED]` or `[PHONE_REDACTED]`.
* **Cancel & Resume:** Real cancellation support (via AbortController) and conversation resumption are fully operational in the UI.

### 🔌 Live Upgrade Path
To connect Ollive to live, production models, copy `.env.example` to `.env` and insert your API keys:
```ini
GROQ_API_KEY=gsk_your_key_here       # For Llama-3.3-70b (ultra-fast 200 tok/s)
GEMINI_API_KEY=AIza_your_key_here    # For Gemini-2.0-Flash
OPENROUTER_API_KEY=sk-or-your_key    # For OpenRouter free/paid models
```
Restart the server. The SDK will automatically detect the keys, remove the `(Demo)` labels, and stream from the **real live APIs**.

---

## 🏛 Architectural Decisions & Tradeoffs

### 1. The Three-Table Schema (Domain Alignment)
Toy projects typically log telemetry fields directly on message tables. For Ollive (an AI insurance and risk platform), this is a critical architectural failure:
* **The Problem:** In production, one user prompt often triggers multiple LLM calls (e.g., fallback retries, tool-use chains, agent routing). A single message != a single inference call.
* **The Solution:** Ollive uses a clean three-table design:
  1. `sessions`: Represents a conversation thread (denormalized token and cost counters for UI performance).
  2. `messages`: High-fidelity chat transcript for the user UI (system, user, assistant).
  3. `logs`: Secure infrastructure-level telemetry (request_id, TTFT, cost, tokens/sec, PII flags, and error codes).

### 2. PII Redaction Before Storage (Compliance)
* **The Decision:** Incoming inference streams are routed through a regex redaction pipeline *before* they are committed to the SQLite database.
* **The Why:** Compliance (GDPR, HIPAA, SOC2) requires that raw PII never hits persistent storage. Redacting in memory and storing the redacted preview ensures full compliance with auditing requirements.

### 3. Decoupled Ingestion Pipeline (Event-Driven)
* **The Decision:** The SDK is an `EventEmitter`. When an LLM call finishes or fails, the SDK emits a `'log'` event. The `Ingestion Pipeline` listens to this event asynchronously.
* **The Why:** Chat SSE streaming must never be blocked by database writes, PII regex compilation, or metric aggregations. Decoupling ensures that streaming feels instant, even under heavy DB loads.

### 4. SQLite WAL Mode vs. Postgres
* **The Decision:** Built with `better-sqlite3` operating in **Write-Ahead Logging (WAL) Mode** and foreign keys enabled.
* **The Why:** Zero-configuration local startup. Because WAL mode supports highly concurrent read/write operations, it handles local logging effortlessly. The schema is 100% relational, meaning migrating to PostgreSQL or TimescaleDB in production requires zero refactoring.

---

## 🎨 Premium Dark UI Design

Built with Vanilla JS, CSS grid, and modern custom properties (no bloated frameworks or tailwind compilation steps):
* **harmonies:** Sleek deep space theme using custom HSL colors, avoiding generic gray.
* **Visual Polish:** Glassmorphism dashboard cards, animated metrics counters, status-indicator pulses, and custom custom scrollbars.
* **Interactive Spells:** Smooth list card liftoff on hover, sliding message bubbles, and real-time streaming cursor micro-animations.
* **Responsive Layout:** Grid dynamically shifts from 3 panels to 2 panels at `1024px`, and collapses to a touch-first sidebar drawer with a hamburger menu at `768px`.

---

## 🛠 What's Under The Hood

* **`src/server.js`:** Express API with full SSE connection management, AbortController mapping, and health checks.
* **`src/sdk.js`:** Unified LLM wrapper supporting OpenAI-compatible endpoints (Groq, OpenRouter), Google's Gemini SDK, and the built-in educational interactive demo adapter.
* **`src/pipeline.js`:** Telemetry pipeline doing structured validation, PII redaction, token-speed calculation, and database writes.
* **`src/redactor.js`:** Pre-compiled regex engine scanning for Emails, Phones (US/Intl), SSNs, Credit Cards, and exposed API Keys.
* **`src/db.js`:** SQLite initialization, index creation, WAL mode configuration, and prepared statements.
* **`src/metrics.js`:** Computes real-time P50/P95 latencies, throughput, error rates, and PII distributions directly from SQLite.
