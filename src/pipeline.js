import { redact } from './redactor.js';
import { insertLog } from './db.js';

const VALID_STATUSES = new Set(['pending', 'streaming', 'success', 'error', 'cancelled']);

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
function processLog(raw) {
  // Redact PII from previews
  const inputResult = redact(raw.inputPreview || '');
  const outputResult = redact(raw.outputPreview || '');
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
    try {
      const err = validate(rawLog);
      if (err) {
        console.warn(`[pipeline] Invalid log skipped: ${err}`, rawLog.requestId);
        return;
      }

      const processed = processLog(rawLog);

      try {
        insertLog(processed);
      } catch (dbErr) {
        console.error(`[pipeline] DB insert failed for ${processed.request_id}:`, dbErr.message);
      }
    } catch (pipelineErr) {
      console.error('[pipeline] Unexpected error:', pipelineErr.message);
    }
  });
}

/**
 * Process an externally-submitted log (POST /api/ingest).
 */
export function processExternalLog(logData) {
  const err = validate(logData);
  if (err) throw new Error(err);

  const processed = processLog(logData);

  try {
    insertLog(processed);
  } catch (dbErr) {
    console.error(`[pipeline] External log DB insert failed:`, dbErr.message);
    throw dbErr;
  }

  return processed;
}
