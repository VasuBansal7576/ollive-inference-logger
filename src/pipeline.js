import { redactAsync } from './redactor.js';
import { getDb, insertLog } from './db.js';

const VALID_STATUSES = new Set(['pending', 'streaming', 'success', 'error', 'cancelled']);
const BATCH_SIZE = 20;
const BATCH_INTERVAL_MS = 1000; // Flush logs every 1s

let batchQueue = [];
let flushTimeout = null;

/**
 * Flush all buffered logs in a single SQLite transaction.
 */
function flushBatch() {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }

  if (batchQueue.length === 0) return;

  const currentBatch = [...batchQueue];
  batchQueue = [];

  const db = getDb();
  const insertStmt = db.prepare(`
    INSERT INTO logs (session_id, request_id, provider, model, status, latency_ms, time_to_first_token_ms,
      input_tokens, output_tokens, total_tokens, tokens_per_second, cost_estimate,
      input_preview, output_preview, pii_types_detected, pii_redacted, error_message, error_code)
    VALUES (@session_id, @request_id, @provider, @model, @status, @latency_ms, @time_to_first_token_ms,
      @input_tokens, @output_tokens, @total_tokens, @tokens_per_second, @cost_estimate,
      @input_preview, @output_preview, @pii_types_detected, @pii_redacted, @error_message, @error_code)
  `);

  const updateSessionTotals = db.prepare(`
    UPDATE sessions SET total_tokens = total_tokens + ?, total_cost = total_cost + ?, updated_at = datetime('now') WHERE id = ?
  `);

  try {
    const batchTransaction = db.transaction((logs) => {
      for (const log of logs) {
        insertStmt.run(log);
        if (log.session_id && log.total_tokens) {
          updateSessionTotals.run(log.total_tokens || 0, log.cost_estimate || 0, log.session_id);
        }
      }
    });

    batchTransaction(currentBatch);
  } catch (err) {
    console.error('[pipeline] Batch database write failed:', err.message);
  }
}

/**
 * Queue a processed log for batched database insertion.
 */
function queueLogForBatch(processedLog) {
  batchQueue.push(processedLog);

  if (batchQueue.length >= BATCH_SIZE) {
    flushBatch();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(flushBatch, BATCH_INTERVAL_MS);
  }
}

/**
 * Validate a raw log entry. Returns null if valid, or an error string.
 */
function validate(raw) {
  if (!raw.requestId) return 'Missing requestId';
  if (!raw.provider) return 'Missing provider';
  if (!raw.model) return 'Missing model';
  if (raw.status && !VALID_STATUSES.has(raw.status)) return `Invalid status: ${raw.status}`;
  if (raw.latencyMs != null && typeof raw.latencyMs !== 'number') return 'latencyMs must be a number';
  if (raw.inputTokens != null && typeof raw.inputTokens !== 'number') return 'inputTokens must be a number';
  if (raw.outputTokens != null && typeof raw.outputTokens !== 'number') return 'outputTokens must be a number';
  return null;
}

/**
 * Transform a camelCase SDK log into snake_case DB row, apply redaction and enrichment.
 */
async function processLogAsync(raw) {
  // Redact PII asynchronously off the main thread
  const [inputResult, outputResult] = await Promise.all([
    redactAsync(raw.inputPreview || ''),
    redactAsync(raw.outputPreview || ''),
  ]);

  const allPiiTypes = [...new Set([...inputResult.detected, ...outputResult.detected])];

  // Compute tokens_per_second if missing
  let tps = raw.tokensPerSecond || 0;
  if (!tps && raw.latencyMs > 0 && raw.outputTokens > 0) {
    tps = Math.round((raw.outputTokens / (raw.latencyMs / 1000)) * 100) / 100;
  }

  return {
    session_id: raw.sessionId || null,
    request_id: raw.requestId,
    provider: raw.provider,
    model: raw.model,
    status: raw.status || 'success',
    latency_ms: raw.latencyMs || null,
    time_to_first_token_ms: raw.timeToFirstTokenMs || null,
    input_tokens: raw.inputTokens || 0,
    output_tokens: raw.outputTokens || 0,
    total_tokens: raw.totalTokens || (raw.inputTokens || 0) + (raw.outputTokens || 0),
    tokens_per_second: tps,
    cost_estimate: raw.costEstimate || 0,
    input_preview: inputResult.text.slice(0, 200),
    output_preview: outputResult.text.slice(0, 200),
    pii_types_detected: allPiiTypes.length > 0 ? JSON.stringify(allPiiTypes) : null,
    pii_redacted: allPiiTypes.length > 0 ? 1 : 0,
    error_message: raw.errorMessage || null,
    error_code: raw.errorCode || null,
  };
}

/**
 * Wire the SDK's log events to the ingestion pipeline.
 */
export function createPipeline(sdk) {
  sdk.on('log', (rawLog) => {
    // Yield execution to keeping main I/O loop completely free
    setImmediate(async () => {
      try {
        const err = validate(rawLog);
        if (err) {
          console.warn(`[pipeline] Invalid log skipped: ${err}`, rawLog.requestId);
          return;
        }

        const processed = await processLogAsync(rawLog);
        queueLogForBatch(processed);
      } catch (pipelineErr) {
        console.error('[pipeline] Unexpected error:', pipelineErr.message);
      }
    });
  });
}

/**
 * Process an externally-submitted log asynchronously but write immediately for API sync response (secured via busy_timeout).
 */
export async function processExternalLog(logData) {
  const err = validate(logData);
  if (err) throw new Error(err);

  const processed = await processLogAsync(logData);

  try {
    insertLog(processed);
  } catch (dbErr) {
    console.error(`[pipeline] External log DB insert failed:`, dbErr.message);
    throw dbErr;
  }

  return processed;
}
