/**
 * Compute analytics from the logs table.
 */
export function getMetrics(db) {
  const summary = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) AS total_sessions,
      (SELECT SUM(message_count) FROM sessions) AS total_messages,
      (SELECT COUNT(*) FROM logs) AS total_logs,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM logs) AS total_tokens,
      (SELECT COALESCE(SUM(cost_estimate), 0) FROM logs) AS total_cost,
      (SELECT ROUND(AVG(latency_ms), 2) FROM logs WHERE status = 'success') AS avg_latency_ms
  `).get();

  const errorStats = db.prepare(`
    SELECT COUNT(*) AS total FROM logs WHERE status = 'error'
  `).get();

  const totalLogs = summary.total_logs || 1;
  summary.error_rate = Math.round((errorStats.total / totalLogs) * 10000) / 100;
  summary.total_messages = summary.total_messages || 0;

  // Latency percentiles (global)
  const latencyRows = db.prepare(`
    SELECT latency_ms FROM logs WHERE status = 'success' AND latency_ms IS NOT NULL ORDER BY latency_ms ASC
  `).all();

  const percentile = (rows, p) => {
    if (rows.length === 0) return 0;
    const idx = Math.max(0, Math.ceil(rows.length * p / 100) - 1);
    return Math.round(rows[idx].latency_ms * 100) / 100;
  };

  const latency = {
    p50_ms: percentile(latencyRows, 50),
    p95_ms: percentile(latencyRows, 95),
    by_provider: {},
  };

  // Per-provider latency
  const providers = db.prepare(`SELECT DISTINCT provider FROM logs WHERE provider IS NOT NULL`).all();
  for (const { provider } of providers) {
    const pRows = db.prepare(`
      SELECT latency_ms FROM logs WHERE status = 'success' AND provider = ? AND latency_ms IS NOT NULL ORDER BY latency_ms ASC
    `).all(provider);
    latency.by_provider[provider] = {
      p50: percentile(pRows, 50),
      p95: percentile(pRows, 95),
    };
  }

  // Throughput
  const avgTps = db.prepare(`
    SELECT ROUND(AVG(tokens_per_second), 2) AS avg_tps FROM logs WHERE status = 'success' AND tokens_per_second > 0
  `).get();

  const throughput = {
    avg_tokens_per_second: avgTps?.avg_tps || 0,
    by_provider: {},
  };

  for (const { provider } of providers) {
    const pTps = db.prepare(`
      SELECT ROUND(AVG(tokens_per_second), 2) AS avg_tps FROM logs WHERE status = 'success' AND provider = ? AND tokens_per_second > 0
    `).get(provider);
    throughput.by_provider[provider] = { avg_tokens_per_second: pTps?.avg_tps || 0 };
  }

  // Errors
  const recentErrors = db.prepare(`
    SELECT error_message, provider, created_at FROM logs WHERE status = 'error' ORDER BY created_at DESC LIMIT 10
  `).all();

  const errors = {
    total: errorStats.total,
    rate: summary.error_rate,
    recent: recentErrors,
  };

  // Recent logs
  const recentLogs = db.prepare(`
    SELECT request_id, session_id, provider, model, status, latency_ms, time_to_first_token_ms,
           total_tokens, tokens_per_second, cost_estimate, pii_redacted, created_at
    FROM logs ORDER BY created_at DESC LIMIT 20
  `).all();

  // PII stats
  const piiTotal = db.prepare(`SELECT COUNT(*) AS cnt FROM logs WHERE pii_redacted = 1`).get();
  const piiRows = db.prepare(`SELECT pii_types_detected FROM logs WHERE pii_types_detected IS NOT NULL`).all();

  const typesBreakdown = {};
  for (const row of piiRows) {
    try {
      const types = JSON.parse(row.pii_types_detected);
      for (const t of types) {
        typesBreakdown[t] = (typesBreakdown[t] || 0) + 1;
      }
    } catch { /* skip malformed */ }
  }

  // Provider breakdown (calls per provider)
  const providerBreakdown = {};
  const providerCalls = db.prepare(`SELECT provider, COUNT(*) as calls FROM logs WHERE provider IS NOT NULL GROUP BY provider`).all();
  for (const { provider, calls } of providerCalls) {
    providerBreakdown[provider] = { calls };
  }

  return {
    total_calls: summary.total_logs || 0,
    total_tokens: summary.total_tokens || 0,
    latency_p50: latency.p50_ms || 0,
    error_rate: totalLogs > 0 ? (errorStats.total / totalLogs) : 0,
    provider_breakdown: providerBreakdown,
    total_cost: summary.total_cost || 0,
    recent_logs: recentLogs || [],
    summary,
    latency,
    throughput,
    errors,
    pii: {
      total_redacted: piiTotal.cnt || 0,
      types_breakdown: typesBreakdown,
    },
  };
}
