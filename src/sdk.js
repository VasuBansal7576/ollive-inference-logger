import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import * as openaiCompat from './providers/openai-compat.js';
import * as gemini from './providers/gemini.js';
import { CONFIG } from './config.js';

// Pricing per 1M tokens (all free-tier for now)
const PRICING = {
  groq:       { input: 0, output: 0 },
  gemini:     { input: 0, output: 0 },
  openrouter: { input: 0, output: 0 },
};

function estimateCost(provider, inputTokens, outputTokens) {
  const p = PRICING[provider] || { input: 0, output: 0 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export class LLMSdk extends EventEmitter {
  constructor() {
    super();
    this.providers = {};

    // 1. Groq
    if (CONFIG.GROQ_API_KEY) {
      this.providers.groq = {
        apiKey: CONFIG.GROQ_API_KEY,
        baseUrl: openaiCompat.PROVIDERS.groq.baseUrl,
        defaultModel: openaiCompat.PROVIDERS.groq.defaultModel,
        type: 'openai-compat',
      };
    } else {
      this.providers.groq = {
        apiKey: 'demo',
        defaultModel: 'llama-3.3-70b (Demo)',
        type: 'demo',
      };
    }

    // 2. Gemini
    if (CONFIG.GEMINI_API_KEY) {
      this.providers.gemini = {
        apiKey: CONFIG.GEMINI_API_KEY,
        defaultModel: gemini.DEFAULT_MODEL,
        type: 'gemini',
      };
    } else {
      this.providers.gemini = {
        apiKey: 'demo',
        defaultModel: 'gemini-2.0-flash (Demo)',
        type: 'demo',
      };
    }

    // 3. OpenRouter
    if (CONFIG.OPENROUTER_API_KEY) {
      this.providers.openrouter = {
        apiKey: CONFIG.OPENROUTER_API_KEY,
        baseUrl: openaiCompat.PROVIDERS.openrouter.baseUrl,
        defaultModel: openaiCompat.PROVIDERS.openrouter.defaultModel,
        type: 'openai-compat',
      };
    } else {
      this.providers.openrouter = {
        apiKey: 'demo',
        defaultModel: 'llama-4-maverick (Demo)',
        type: 'demo',
      };
    }
  }

  getAvailableProviders() {
    return Object.entries(this.providers).map(([name, cfg]) => ({
      id: name,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      models: [cfg.defaultModel],
      defaultModel: cfg.defaultModel,
      type: cfg.type,
    }));
  }

  /**
   * Stream a chat completion, emitting log events.
   * @param {string} provider
   * @param {string} model
   * @param {Array<{role: string, content: string}>} messages
   * @param {string} sessionId
   * @param {AbortSignal} [abortSignal]
   * @yields {{ type: 'delta'|'done'|'error', content?: string, usage?: object }}
   */
  async *chat(provider, model, messages, sessionId, abortSignal) {
    let currentProvider = provider;
    let resolvedModel = model;
    let cfg = this.providers[currentProvider];
    if (!cfg) throw new Error(`Provider "${currentProvider}" is not configured`);

    const requestId = uuidv4();
    const startTime = Date.now();
    let firstTokenTime = null;
    let outputText = '';
    let finalUsage = null;
    let errorOccurred = null;

    // Build input preview from the last user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const inputPreview = lastUserMsg?.content?.slice(0, 200) || '';

    // If Groq is the primary provider, enable transparent fallback to Gemini
    let tryFallback = (currentProvider === 'groq' && this.providers.gemini);

    resolvedModel = resolvedModel || cfg.defaultModel;

    // Helper to get adapter stream
    const getStream = (p, m, config) => {
      if (config.type === 'openai-compat') {
        return openaiCompat.streamChat(config.baseUrl, config.apiKey, m, messages, abortSignal);
      } else if (config.type === 'gemini') {
        return gemini.streamChat(config.apiKey, m, messages, abortSignal);
      } else if (config.type === 'demo') {
        return this.streamDemoChat(m, messages, abortSignal);
      } else {
        throw new Error(`Unknown provider type: ${config.type}`);
      }
    };

    let stream;
    try {
      stream = getStream(currentProvider, resolvedModel, cfg);
    } catch (err) {
      if (tryFallback) {
        console.warn(`[sdk] Failed to initialize ${currentProvider} stream: ${err.message}. Falling back to gemini.`);
        currentProvider = 'gemini';
        cfg = this.providers.gemini;
        resolvedModel = cfg.defaultModel;
        tryFallback = false;
        try {
          stream = getStream(currentProvider, resolvedModel, cfg);
        } catch (fallbackErr) {
          errorOccurred = { type: 'error', message: fallbackErr.message };
        }
      } else {
        errorOccurred = { type: 'error', message: err.message };
      }
    }

    if (stream && !errorOccurred) {
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'delta') {
            if (firstTokenTime === null) firstTokenTime = Date.now();
            outputText += chunk.content;
            yield chunk;
          } else if (chunk.type === 'done') {
            finalUsage = chunk.usage;
            yield chunk;
          } else if (chunk.type === 'error') {
            // If main provider stream yields an error before returning any tokens, try falling back
            if (tryFallback && firstTokenTime === null) {
              console.warn(`[sdk] ${currentProvider} stream yielded error before first token: ${chunk.message}. Falling back to gemini.`);
              currentProvider = 'gemini';
              cfg = this.providers.gemini;
              resolvedModel = cfg.defaultModel;
              tryFallback = false;
              
              // Start the fallback stream
              let fallbackStream;
              try {
                fallbackStream = getStream(currentProvider, resolvedModel, cfg);
                for await (const fbChunk of fallbackStream) {
                  if (fbChunk.type === 'delta') {
                    if (firstTokenTime === null) firstTokenTime = Date.now();
                    outputText += fbChunk.content;
                    yield fbChunk;
                  } else if (fbChunk.type === 'done') {
                    finalUsage = fbChunk.usage;
                    yield fbChunk;
                  } else if (fbChunk.type === 'error') {
                    errorOccurred = fbChunk;
                    yield fbChunk;
                  }
                }
              } catch (fbErr) {
                errorOccurred = { type: 'error', message: fbErr.message };
                yield errorOccurred;
              }
              break; // Break the main stream loop
            } else {
              errorOccurred = chunk;
              yield chunk;
            }
          }
        }
      } catch (err) {
        if (tryFallback && firstTokenTime === null) {
          console.warn(`[sdk] Caught error in ${currentProvider} stream before first token: ${err.message}. Falling back to gemini.`);
          currentProvider = 'gemini';
          cfg = this.providers.gemini;
          resolvedModel = cfg.defaultModel;
          tryFallback = false;

          let fallbackStream;
          try {
            fallbackStream = getStream(currentProvider, resolvedModel, cfg);
            for await (const fbChunk of fallbackStream) {
              if (fbChunk.type === 'delta') {
                if (firstTokenTime === null) firstTokenTime = Date.now();
                outputText += fbChunk.content;
                yield fbChunk;
              } else if (fbChunk.type === 'done') {
                finalUsage = fbChunk.usage;
                yield fbChunk;
              } else if (fbChunk.type === 'error') {
                errorOccurred = fbChunk;
                yield fbChunk;
              }
            }
          } catch (fbErr) {
            errorOccurred = { type: 'error', message: fbErr.message };
            yield errorOccurred;
          }
        } else {
          errorOccurred = { type: 'error', message: err.message };
          yield errorOccurred;
        }
      }
    } else if (errorOccurred) {
      yield errorOccurred;
    }

    // Compute metrics
    const latencyMs = Date.now() - startTime;
    const ttft = firstTokenTime ? firstTokenTime - startTime : null;
    const usage = finalUsage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const tps = latencyMs > 0 ? (usage.output_tokens / (latencyMs / 1000)) : 0;
    const cost = estimateCost(currentProvider, usage.input_tokens, usage.output_tokens);

    const isCancelled = !!(
      abortSignal?.aborted ||
      (errorOccurred && (
        errorOccurred.message?.toLowerCase().includes('abort') ||
        errorOccurred.message?.toLowerCase().includes('cancel') ||
        errorOccurred.name === 'AbortError'
      ))
    );

    const logEntry = {
      requestId,
      sessionId,
      provider: currentProvider,
      model: resolvedModel,
      status: isCancelled ? 'cancelled' : (errorOccurred ? 'error' : 'success'),
      latencyMs,
      timeToFirstTokenMs: ttft,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      tokensPerSecond: Math.round(tps * 100) / 100,
      costEstimate: cost,
      inputPreview,
      outputPreview: outputText.slice(0, 200),
      errorMessage: isCancelled ? 'Request cancelled by user.' : (errorOccurred?.message || null),
      errorCode: isCancelled ? 'USER_CANCELLED' : (errorOccurred ? 'STREAM_ERROR' : null),
    };

    this.emit('log', logEntry);
  }

  async *streamDemoChat(model, messages, abortSignal) {
    const responses = [
      "Hello! I am Ollive's built-in simulation model. I can demonstrate real-time streaming, latency metrics, and PII redaction. Try typing an email like test@example.com or a phone number like 555-0199 to see the PII Shield in action!",
      "Observability is key for production LLM deployments. By tracking metrics like Time-to-First-Token (TTFT), tokens per second, and error rates, Ollive helps teams monitor LLM health in real-time.",
      "Ollive separates chat messages from telemetry logs. This design decision ensures that chat history remains high-fidelity for users, while telemetry logs are securely redacted for security and auditing.",
      "SQLite in WAL (Write-Ahead Logging) mode is highly concurrent and perfect for local development and demos. It requires zero configuration and provides extremely fast read and write speeds.",
      "The ingestion pipeline is decoupled from the chat loop via an asynchronous EventEmitter. This prevents slow database writes or validation checks from blocking the client's streaming response."
    ];

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let responseText = responses[Math.floor(Math.random() * responses.length)];

    if (lastUserMsg.toLowerCase().includes('hello') || lastUserMsg.toLowerCase().includes('hi')) {
      responseText = "Hi there! Welcome to Ollive's interactive demo. Feel free to ask me anything about LLM observability, latency tracking, or PII compliance!";
    } else if (lastUserMsg.toLowerCase().includes('email') || lastUserMsg.toLowerCase().includes('phone') || lastUserMsg.toLowerCase().includes('key') || lastUserMsg.toLowerCase().includes('@')) {
      responseText = "I detected you mentioned sensitive information or PII patterns! In the background, Ollive's ingestion pipeline is scanning these previews. Check the right Analytics panel after this response finishes: the 'PII Shield' alert and statistics will update, and the log preview will show [EMAIL_REDACTED] or [PHONE_REDACTED]!";
    }

    const words = responseText.split(' ');
    let outputTokens = 0;
    
    // Simulate first token delay
    await new Promise(resolve => setTimeout(resolve, 150 + Math.random() * 100));

    for (let i = 0; i < words.length; i++) {
      if (abortSignal?.aborted) {
        yield { type: 'error', message: 'Request cancelled' };
        return;
      }
      
      const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
      outputTokens += Math.ceil(chunk.length / 4);
      yield { type: 'delta', content: chunk };
      
      await new Promise(resolve => setTimeout(resolve, 30 + Math.random() * 20));
    }

    const inputTokens = Math.ceil(lastUserMsg.length / 4);
    yield {
      type: 'done',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    };
  }
}
