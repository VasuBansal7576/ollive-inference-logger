/* ═══════════════════════════════════════════════════════════════
   OLLIVE — Frontend Application
   Vanilla JS · No frameworks · SSE streaming via fetch
   ═══════════════════════════════════════════════════════════════ */

// ─── State ───
const state = {
  sessions: [],
  currentSessionId: null,
  messages: [],
  providers: [],
  selectedProvider: null,
  selectedModel: null,
  isStreaming: false,
  metrics: null,
  metricsInterval: null,
  abortController: null,
};

// ─── DOM Cache ───
const $ = (id) => document.getElementById(id);
const dom = {};

function cacheDom() {
  dom.sessionsList     = $('sessions-list');
  dom.sessionsEmpty    = $('sessions-empty');
  dom.sessionsStats    = $('sessions-stats');
  dom.newChatBtn       = $('new-chat-btn');
  dom.providerSelect   = $('provider-select');
  dom.modelSelect      = $('model-select');
  dom.messagesArea     = $('messages-area');
  dom.chatEmpty        = $('chat-empty');
  dom.messageInput     = $('message-input');
  dom.sendBtn          = $('send-btn');
  dom.cancelBtn        = $('cancel-btn');
  dom.piiBadge         = $('pii-badge');
  dom.sidebarToggle    = $('sidebar-toggle');
  dom.sessionsPanel    = $('sessions-panel');
  dom.statTotalCalls   = $('stat-total-calls');
  dom.statTotalTokens  = $('stat-total-tokens');
  dom.statLatencyP50   = $('stat-latency-p50');
  dom.statErrorRate    = $('stat-error-rate');
  dom.providerBars     = $('provider-bars');
  dom.costDisplay      = $('cost-display');
  dom.recentLogs       = $('recent-logs');
  dom.metricsEmpty     = $('metrics-empty');
  dom.connectionStatus = $('connection-status');
}

// ─── Helpers ───
function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createElement(tag, className, textContent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent) el.textContent = textContent;
  return el;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatNumber(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

function formatLatency(ms) {
  if (ms == null || ms === 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function truncate(str, len = 36) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function scrollToBottom(container) {
  requestAnimationFrame(() => {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  });
}

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
}

// ─── API ───
const ADMIN_TOKEN = new URLSearchParams(window.location.search).get('token') || '';

const API = {
  async get(path) {
    try {
      const res = await fetch(path, {
        headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(`GET ${path} failed:`, err);
      return null;
    }
  },
  async patch(path, body) {
    try {
      const res = await fetch(path, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ADMIN_TOKEN}`
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(`PATCH ${path} failed:`, err);
      return null;
    }
  },
};

// ─── Providers ───
async function loadProviders() {
  const data = await API.get('/api/providers');
  if (!data) {
    // Fallback defaults for demo
    state.providers = [
      { id: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4-20250514', 'claude-3-haiku-20240307'] },
      { id: 'openai', name: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini'] },
    ];
  } else {
    state.providers = Array.isArray(data) ? data : (data.providers || []);
  }
  renderProviderDropdowns();
}

function renderProviderDropdowns() {
  dom.providerSelect.innerHTML = '';
  state.providers.forEach((p, i) => {
    const opt = createElement('option', null, p.name || p.id);
    opt.value = p.id;
    dom.providerSelect.appendChild(opt);
  });
  if (state.providers.length > 0) {
    state.selectedProvider = state.providers[0].id;
    updateModelDropdown();
  }
}

function updateModelDropdown() {
  const provider = state.providers.find(p => p.id === state.selectedProvider);
  dom.modelSelect.innerHTML = '';
  if (!provider || !provider.models) return;
  provider.models.forEach((m, i) => {
    const opt = createElement('option', null, m);
    opt.value = m;
    dom.modelSelect.appendChild(opt);
  });
  state.selectedModel = provider.models[0] || null;
}

// ─── Sessions ───
async function loadSessions() {
  const data = await API.get('/api/sessions');
  state.sessions = Array.isArray(data) ? data : (data?.sessions || []);
  renderSessions();
}

function renderSessions() {
  // Clear existing session cards (keep empty state)
  dom.sessionsList.querySelectorAll('.session-card').forEach(c => c.remove());

  if (state.sessions.length === 0) {
    dom.sessionsEmpty.classList.remove('hidden');
    dom.sessionsStats.textContent = '0 calls · 0 tokens';
    return;
  }
  dom.sessionsEmpty.classList.add('hidden');

  // Sort by most recent first
  const sorted = [...state.sessions].sort((a, b) =>
    new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)
  );

  sorted.forEach(session => {
    const card = createElement('div', `session-card${session.id === state.currentSessionId ? ' session-card--active' : ''}`);
    card.dataset.sessionId = session.id;
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Chat session: ${session.title || 'Untitled Chat'}`);

    const statusClass = session.status === 'active' ? 'status-dot--success status-dot--pulse'
      : session.status === 'cancelled' ? 'status-dot--error'
      : 'status-dot--muted';

    card.innerHTML = `
      <span class="status-dot ${statusClass}"></span>
      <div class="session-card-body">
        <div class="session-card-title">${escapeHtml(truncate(session.title || 'Untitled Chat'))}</div>
        <div class="session-card-meta">
          ${session.provider ? `<span class="session-card-badge">${escapeHtml(session.provider)}</span>` : ''}
          <span>${formatTime(session.updated_at || session.created_at)}</span>
        </div>
      </div>
    `;

    card.addEventListener('click', () => selectSession(session.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectSession(session.id);
      }
    });
    dom.sessionsList.insertBefore(card, dom.sessionsEmpty);
  });

  // Stats
  const totalCalls = state.sessions.reduce((s, ses) => s + (ses.call_count || 0), 0);
  const totalTokens = state.sessions.reduce((s, ses) => s + (ses.total_tokens || 0), 0);
  dom.sessionsStats.textContent = `${formatNumber(totalCalls)} calls · ${formatNumber(totalTokens)} tokens`;
}

async function selectSession(sessionId) {
  if (state.isStreaming) return;
  state.currentSessionId = sessionId;

  // Highlight in sidebar
  dom.sessionsList.querySelectorAll('.session-card').forEach(c => {
    c.classList.toggle('session-card--active', c.dataset.sessionId === sessionId);
  });

  // Close mobile sidebar
  dom.sessionsPanel.classList.remove('open');

  // Load messages
  const data = await API.get(`/api/sessions/${sessionId}`);
  if (data) {
    state.messages = data.messages || [];
    const session = state.sessions.find(s => s.id === sessionId) || data;

    // Update provider/model selectors if session has them
    if (session.provider) {
      dom.providerSelect.value = session.provider;
      state.selectedProvider = session.provider;
      updateModelDropdown();
      if (session.model) {
        dom.modelSelect.value = session.model;
        state.selectedModel = session.model;
      }
    }

    renderMessages();

    // Show resume bar if cancelled
    removeResumeBar();
    if (session.status === 'cancelled') {
      showResumeBar(sessionId);
    }
  }

  dom.messageInput.focus();
}

function showResumeBar(sessionId) {
  const bar = createElement('div', 'resume-bar');
  bar.id = 'resume-bar';
  bar.innerHTML = `
    <span>This conversation was cancelled.</span>
    <button class="btn btn--ghost" id="resume-session-btn">Resume</button>
  `;
  dom.messagesArea.parentNode.insertBefore(bar, dom.messagesArea);
  $('resume-session-btn').addEventListener('click', async () => {
    await API.patch(`/api/sessions/${sessionId}`, { status: 'active' });
    removeResumeBar();
    const s = state.sessions.find(s => s.id === sessionId);
    if (s) s.status = 'active';
    renderSessions();
  });
}

function removeResumeBar() {
  const bar = $('resume-bar');
  if (bar) bar.remove();
}

function renderMessages() {
  // Clear
  dom.messagesArea.innerHTML = '';

  if (state.messages.length === 0) {
    dom.messagesArea.appendChild(dom.chatEmpty || createChatEmpty());
    return;
  }

  state.messages.forEach(msg => {
    const bubble = createMessageBubble(msg.role, msg.content, msg);
    dom.messagesArea.appendChild(bubble);
  });

  scrollToBottom(dom.messagesArea);
}

function createChatEmpty() {
  const el = createElement('div', 'empty-state empty-state--chat');
  el.id = 'chat-empty';
  el.innerHTML = `
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
    <p>Every call is logged and observable</p>
    <span>Select a conversation or start a new one</span>
  `;
  return el;
}

function createMessageBubble(role, content, meta = {}) {
  const wrapper = createElement('div', `message message--${role}`);
  const bubble = createElement('div', 'message-bubble');
  bubble.textContent = content || '';
  wrapper.appendChild(bubble);

  if (meta.timestamp || meta.pii_detected) {
    const metaEl = createElement('div', 'message-meta');
    const parts = [];
    if (meta.timestamp) parts.push(formatTime(meta.timestamp));
    if (meta.pii_detected) parts.push('🛡 PII redacted');
    metaEl.textContent = parts.join(' · ');
    wrapper.appendChild(metaEl);
  }

  return wrapper;
}

function createStreamingBubble() {
  const wrapper = createElement('div', 'message message--assistant');
  wrapper.id = 'streaming-message';
  const bubble = createElement('div', 'message-bubble streaming-cursor');
  bubble.id = 'streaming-bubble';
  bubble.innerHTML = '<div class="streaming-dots"><span></span><span></span><span></span></div>';
  wrapper.appendChild(bubble);
  return wrapper;
}

// ─── Chat Flow ───
async function sendMessage() {
  const text = dom.messageInput.value.trim();
  if (!text || state.isStreaming) return;

  dom.messageInput.value = '';
  autoResizeTextarea(dom.messageInput);

  // Remove empty state
  const empty = $('chat-empty');
  if (empty) empty.remove();

  // Optimistic user bubble
  const userMsg = { role: 'user', content: text, timestamp: new Date().toISOString() };
  state.messages.push(userMsg);
  dom.messagesArea.appendChild(createMessageBubble('user', text, userMsg));
  scrollToBottom(dom.messagesArea);

  // Enter streaming state
  setStreaming(true);

  // Add streaming bubble
  const streamEl = createStreamingBubble();
  dom.messagesArea.appendChild(streamEl);
  scrollToBottom(dom.messagesArea);

  // AbortController for cancel
  state.abortController = new AbortController();

  const payload = {
    provider: state.selectedProvider || dom.providerSelect.value,
    model: state.selectedModel || dom.modelSelect.value,
    message: text,
  };
  if (state.currentSessionId) {
    payload.session_id = state.currentSessionId;
  }

  let assistantText = '';
  let piiDetected = false;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: state.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streamBubble = $('streaming-bubble');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            if (parsed.type === 'message_start') {
              // Capture session_id if new
              if (parsed.session_id && !state.currentSessionId) {
                state.currentSessionId = parsed.session_id;
              }
              // Clear dots, start text
              streamBubble.innerHTML = '';
              streamBubble.classList.add('streaming-cursor');
            } else if (parsed.type === 'content_block_delta' || parsed.type === 'message_delta' || parsed.type === 'delta') {
              if (assistantText === '') {
                streamBubble.innerHTML = '';
                streamBubble.classList.add('streaming-cursor');
              }
              const delta = parsed.delta?.text || parsed.text || parsed.content || '';
              assistantText += delta;
              streamBubble.textContent = assistantText;
              scrollToBottom(dom.messagesArea);
            } else if (parsed.type === 'done') {
              if (parsed.session_id && !state.currentSessionId) {
                state.currentSessionId = parsed.session_id;
              }
            } else if (parsed.type === 'pii_redacted') {
              piiDetected = true;
              dom.piiBadge.classList.remove('hidden');
            } else if (parsed.type === 'error') {
              throw new Error(parsed.message || 'Stream error');
            }

            // Also handle flat text chunks (simpler SSE servers)
            if (typeof parsed === 'string') {
              assistantText += parsed;
              streamBubble.textContent = assistantText;
              scrollToBottom(dom.messagesArea);
            }
          } catch (parseErr) {
            // If it's not JSON, treat as raw text delta
            if (!data.startsWith('{')) {
              assistantText += data;
              streamBubble.textContent = assistantText;
              scrollToBottom(dom.messagesArea);
            }
          }
        }
      }
    }

    // Finalize
    streamBubble.classList.remove('streaming-cursor');
    const assistantMsg = {
      role: 'assistant',
      content: assistantText,
      timestamp: new Date().toISOString(),
      pii_detected: piiDetected,
    };
    state.messages.push(assistantMsg);

    // Replace streaming element with final bubble
    const streamMsg = $('streaming-message');
    if (streamMsg) {
      streamMsg.remove();
      dom.messagesArea.appendChild(createMessageBubble('assistant', assistantText, assistantMsg));
    }

    // Refresh sidebar & metrics
    await loadSessions();
    await loadMetrics();

  } catch (err) {
    const streamMsg = $('streaming-message');
    if (streamMsg) streamMsg.remove();

    if (err.name !== 'AbortError') {
      const errorEl = createElement('div', 'message message--error');
      errorEl.innerHTML = `<div class="message-bubble">⚠ ${escapeHtml(err.message || 'An error occurred')}</div>`;
      dom.messagesArea.appendChild(errorEl);
      scrollToBottom(dom.messagesArea);
    }
  } finally {
    setStreaming(false);
    state.abortController = null;
  }
}

function cancelStream() {
  if (state.abortController) {
    state.abortController.abort();
  }
  if (state.currentSessionId) {
    API.patch(`/api/sessions/${state.currentSessionId}`, { status: 'cancelled' });
    const session = state.sessions.find(s => s.id === state.currentSessionId);
    if (session) session.status = 'cancelled';
    renderSessions();
  }
  setStreaming(false);
}

function setStreaming(active) {
  state.isStreaming = active;
  dom.sendBtn.disabled = active;
  dom.messageInput.disabled = active;
  dom.cancelBtn.classList.toggle('hidden', !active);
  if (!active) {
    dom.messageInput.disabled = false;
    dom.messageInput.focus();
  }
}

function newChat() {
  if (state.isStreaming) return;
  state.currentSessionId = null;
  state.messages = [];
  dom.piiBadge.classList.add('hidden');
  removeResumeBar();

  // Deselect session cards
  dom.sessionsList.querySelectorAll('.session-card').forEach(c =>
    c.classList.remove('session-card--active')
  );

  // Clear messages
  dom.messagesArea.innerHTML = '';
  dom.messagesArea.appendChild(createChatEmpty());

  dom.messageInput.focus();
  dom.sessionsPanel.classList.remove('open');
}

// ─── Metrics ───
async function loadMetrics() {
  const data = await API.get('/api/metrics');
  if (!data) return;
  state.metrics = data;
  renderMetrics(data);
}

function renderMetrics(m) {
  // Stat cards
  setStatValue(dom.statTotalCalls, formatNumber(m.total_calls || 0));
  setStatValue(dom.statTotalTokens, formatNumber(m.total_tokens || 0));
  setStatValue(dom.statLatencyP50, formatLatency(m.latency_p50 || m.p50_latency));

  const errorRate = m.error_rate != null ? m.error_rate : 0;
  const errorEl = dom.statErrorRate.querySelector('.stat-value');
  errorEl.textContent = `${(errorRate * 100).toFixed(1)}%`;
  errorEl.className = `stat-value ${errorRate > 0.05 ? 'stat-value--error' : 'stat-value--success'}`;

  // Provider bars
  renderProviderBars(m.provider_breakdown || m.providers || {});

  // Cost
  const costVal = dom.costDisplay.querySelector('.cost-value');
  if (costVal) costVal.textContent = `$${(m.total_cost || 0).toFixed(4)}`;

  // Recent logs
  renderRecentLogs(m.recent_logs || m.logs || []);
}

function setStatValue(card, value) {
  const el = card.querySelector('.stat-value');
  if (el) el.textContent = value;
}

function renderProviderBars(breakdown) {
  dom.providerBars.innerHTML = '';
  const entries = Object.entries(breakdown);
  if (entries.length === 0) {
    dom.providerBars.innerHTML = '<div class="empty-state empty-state--small">No data yet</div>';
    return;
  }

  const max = Math.max(...entries.map(([, v]) => (typeof v === 'number' ? v : v.calls || 0)));
  const fills = ['provider-bar-fill', 'provider-bar-fill provider-bar-fill--alt', 'provider-bar-fill provider-bar-fill--third'];

  entries.forEach(([name, val], i) => {
    const calls = typeof val === 'number' ? val : val.calls || 0;
    const pct = max > 0 ? (calls / max) * 100 : 0;

    const item = createElement('div', 'provider-bar-item');
    item.innerHTML = `
      <div class="provider-bar-header">
        <span class="provider-bar-name">${escapeHtml(name)}</span>
        <span class="provider-bar-value">${formatNumber(calls)} calls</span>
      </div>
      <div class="provider-bar-track">
        <div class="${fills[i % fills.length]}" style="width: ${pct}%"></div>
      </div>
    `;
    dom.providerBars.appendChild(item);
  });
}

function renderRecentLogs(logs) {
  dom.recentLogs.innerHTML = '';
  if (!logs || logs.length === 0) {
    dom.recentLogs.innerHTML = `
      <div class="empty-state empty-state--small">
        <p>No data yet.</p>
        <span>Start chatting to see analytics.</span>
      </div>`;
    return;
  }

  logs.slice(0, 8).forEach(log => {
    const row = createElement('div', 'log-row');
    const statusCls = log.status === 'error' ? 'log-status--error' : 'log-status--success';
    row.innerHTML = `
      <span class="log-status ${statusCls}"></span>
      <span class="log-provider">${escapeHtml(log.provider || '—')}</span>
      <span class="log-latency">${formatLatency(log.latency || log.latency_ms)}</span>
      <span class="log-tokens">${formatNumber(log.tokens || log.total_tokens || 0)} tok</span>
    `;
    dom.recentLogs.appendChild(row);
  });
}

function startMetricsPolling() {
  if (state.metricsInterval) clearInterval(state.metricsInterval);
  state.metricsInterval = setInterval(loadMetrics, 5000);
}

// ─── Event Listeners ───
function bindEvents() {
  // Send
  dom.sendBtn.addEventListener('click', sendMessage);
  dom.cancelBtn.addEventListener('click', cancelStream);
  dom.newChatBtn.addEventListener('click', newChat);

  // Keyboard
  dom.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  dom.messageInput.addEventListener('input', () => autoResizeTextarea(dom.messageInput));

  // Provider change
  dom.providerSelect.addEventListener('change', (e) => {
    state.selectedProvider = e.target.value;
    updateModelDropdown();
  });

  dom.modelSelect.addEventListener('change', (e) => {
    state.selectedModel = e.target.value;
  });

  // Sidebar toggle (mobile)
  dom.sidebarToggle.addEventListener('click', () => {
    dom.sessionsPanel.classList.toggle('open');
  });

  // Close sidebar on outside click (mobile)
  document.addEventListener('click', (e) => {
    if (dom.sessionsPanel.classList.contains('open')
      && !dom.sessionsPanel.contains(e.target)
      && !dom.sidebarToggle.contains(e.target)) {
      dom.sessionsPanel.classList.remove('open');
    }
  });
}

// ─── Connection Check ───
async function checkConnection() {
  try {
    const res = await fetch('/api/health', { method: 'GET' });
    const dot = dom.connectionStatus.querySelector('.status-dot');
    const label = dom.connectionStatus.querySelector('.status-label');
    if (res.ok) {
      dot.className = 'status-dot status-dot--success';
      label.textContent = 'Connected';
    } else {
      dot.className = 'status-dot status-dot--warning';
      label.textContent = 'Degraded';
    }
  } catch {
    const dot = dom.connectionStatus.querySelector('.status-dot');
    const label = dom.connectionStatus.querySelector('.status-label');
    dot.className = 'status-dot status-dot--error';
    label.textContent = 'Offline';
  }
}

// ─── Init ───
async function init() {
  cacheDom();
  bindEvents();

  // Parallel initial load
  await Promise.all([
    loadProviders(),
    loadSessions(),
    loadMetrics(),
  ]);

  checkConnection();
  startMetricsPolling();

  // Periodic connection check
  setInterval(checkConnection, 30000);

  dom.messageInput.focus();
}

document.addEventListener('DOMContentLoaded', init);
