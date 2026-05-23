/**
 * OpenAI-compatible streaming provider for Groq and OpenRouter.
 */

export const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-4-maverick:free',
  },
};

/**
 * Stream chat completions from an OpenAI-compatible endpoint.
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {AbortSignal} [abortSignal]
 * @yields {{ type: 'delta'|'done'|'error', content?: string, usage?: object, message?: string }}
 */
export async function* streamChat(baseUrl, apiKey, model, messages, abortSignal) {
  const url = `${baseUrl}/chat/completions`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: abortSignal,
    });
  } catch (err) {
    yield { type: 'error', message: err.name === 'AbortError' ? 'Request cancelled' : err.message };
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => 'Unknown error');
    yield { type: 'error', message: `${response.status}: ${body}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6);
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        // Extract usage if present (some providers send it on the final chunk)
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || 0;
          outputTokens = parsed.usage.completion_tokens || 0;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          yield { type: 'delta', content: delta.content };
        }

        // Some providers signal finish_reason on last chunk
        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason && finishReason !== 'null') {
          // Will emit 'done' after loop
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      yield { type: 'error', message: 'Request cancelled' };
      return;
    }
    yield { type: 'error', message: err.message };
    return;
  }

  yield {
    type: 'done',
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
