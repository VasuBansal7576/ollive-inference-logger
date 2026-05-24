# Ollive Inference Logger & Ingestion Engine

An inference logging and observability dashboard for multi-provider LLM deployments. Built to demonstrate real-time telemetry capture, in-memory PII redaction, and transactional SQLite throughput optimization.

---

## Setup and Getting Started

### Docker Setup
Run the containerized application without configuring local dependencies:
```bash
docker compose up --build
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Local Setup
Requires Node.js v20 or later:
1. Install package dependencies:
   ```bash
   npm install
   ```
2. Start the local server:
   ```bash
   npm start
   ```
3. Open [http://localhost:3000](http://localhost:3000).

---

## Built-in Demo Mode

By default, the application boots in an interactive simulation mode to simplify local testing and evaluation:
* **No API Keys Required:** You can chat immediately using a simulated LLM generator.
* **Realistic Telemetry Simulation:** The generator simulates real-time server-sent event (SSE) token streams, time-to-first-token (TTFT) latency, and tokens-per-second throughput.
* **PII Redaction Demonstration:** Enter sensitive details like `"my email is test@example.com"` or `"phone: 555-555-1234"` and watch the live analytics dashboard update. The SQL log preview will render `[EMAIL_REDACTED]` or `[PHONE_REDACTED]`.
* **Flow Control:** Connection interruption (via AbortController) and conversation resumption are fully operational in the user interface.

### Connecting Real LLMs
To route streams through live providers, duplicate the environment template:
```bash
cp .env.example .env
```
Add your respective credentials. Groq offers a fast, free tier that takes under a minute to configure at [console.groq.com](https://console.groq.com):
```ini
GROQ_API_KEY=gsk_your_key_here       # Free tier — Llama-3.3-70b
GEMINI_API_KEY=AIza_your_key_here    # Free tier — Gemini-2.0-Flash
OPENROUTER_API_KEY=sk-or-your_key    # OpenRouter models
```
Restart the server. The SDK automatically detects the keys, drops the `(Demo)` labels, and starts streaming directly from the upstream APIs.

*Note: The sessions list and analytics panel require passing your configured admin token in the URL query parameters: `http://localhost:3000?token=YOUR_ADMIN_TOKEN`.*

---

## Core Architecture and Technical Tradeoffs

### Data Model: Three-Table Schema
Logging telemetry fields directly inside message tables is a common architectural shortcut that falls apart under real-world requirements:
* **The Problem:** In production, a single user prompt frequently triggers multiple upstream LLM calls (e.g. agent routing, fallback retries, or multi-step tool-use chains). A simple 1:1 mapping of chat messages to logs is structurally insufficient.
* **The Solution:** We implement a decoupled three-table database layout:
  1. `sessions`: Tracks overall chat threads and denormalizes aggregate tokens and costs to keep UI load speeds high.
  2. `messages`: Stores user-facing conversational turns (system, user, assistant).
  3. `logs`: Houses low-level infrastructure telemetry (unique request IDs, TTFT latency, exact cost models, throughput, redacted PII arrays, and error codes).

### Compliance: Pre-Storage PII Redaction
* **The Decision:** Incoming text streams are validated and passed through a regex-based redaction boundary before they are written to disk.
* **The Rationale:** Regulatory compliance guidelines (such as GDPR, HIPAA, or SOC2) require that raw PII never enters persistent storage. Redacting in-memory and committing only the sanitized preview ensures audit safety.

### Performance: Asynchronous Telemetry Ingestion
* **The Decision:** The LLM SDK is built as an `EventEmitter`. When an API call concludes or aborts, it fires a `'log'` event handled asynchronously by the ingestion pipeline.
* **The Rationale:** Network I/O and SQLite database writes must never block the client's live SSE stream. Decoupling the ingestion loop guarantees that chat responses feel instantaneous.

### Database: SQLite WAL Configuration
* **The Decision:** Configured `better-sqlite3` running in Write-Ahead Logging (WAL) mode with foreign keys enabled.
* **The Rationale:** Simplifies local execution with zero configuration. Because WAL mode supports highly concurrent read/write cycles, it easily satisfies single-process logging needs while providing a standard relational schema that can migrate to PostgreSQL or TimescaleDB without application refactoring.

---

## Design System & Interface Details

The frontend is written in vanilla JavaScript and native CSS (no build pipelines, framework runtimes, or Tailwind compiler overhead):
* **Colors:** A tailored dark theme using HSL custom properties, avoiding default gray in favor of a deep space aesthetic.
* **Micro-Interactions:** Custom scrollbars, glassmorphism containers, animated stat counters, and pulsing status signals.
* **Motion Design:** Clean transitions on chat bubbles, hover offsets, and a real-time typing cursor.
* **Responsive Layout:** Grid layout that adapts to a two-column setup at `1024px`, and collapses to a touch-first sidebar drawer with a hamburger trigger at `768px`.

---

## Module Reference

* `src/server.js`: Express application handling endpoints, SSE connections, AbortController cancellation maps, and server shutdown routines.
* `src/sdk.js`: Unified LLM adapter wrapping OpenAI-compatible APIs (Groq, OpenRouter), Google's Gemini SDK, and the local demo simulator.
* `src/pipeline.js`: Ingestion worker managing data validation, PII redaction, token-per-second throughput math, and batch database flushes.
* `src/redactor.js`: Compiled regex scanning engine filtering emails, US/Intl phone numbers, SSNs, credit cards, and API keys.
* `src/db.js`: Database connection management, automatic schema migrations, and prepared statement caches.
* `src/metrics.js`: Aggregates latency percentiles (P50/P95), cost totals, error distributions, and PII counts directly from SQLite.
