import { GoogleGenerativeAI } from '@google/generative-ai';

export const DEFAULT_MODEL = 'gemini-2.0-flash';

/**
 * Convert OpenAI-style messages to Gemini format.
 * Gemini uses 'user' and 'model' roles, and a separate systemInstruction field.
 */
function convertMessages(messages) {
  let systemInstruction = undefined;
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = msg.content;
      continue;
    }
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  // Gemini requires at least one message and the first must be 'user'
  // If history starts with 'model', prepend a placeholder
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '.' }] });
  }

  return { systemInstruction, contents };
}

/**
 * Stream chat from Google Gemini.
 * @param {string} apiKey
 * @param {string} modelName
 * @param {Array<{role: string, content: string}>} messages
 * @param {AbortSignal} [abortSignal]
 * @yields {{ type: 'delta'|'done'|'error', content?: string, usage?: object, message?: string }}
 */
export async function* streamChat(apiKey, modelName, messages, abortSignal) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const { systemInstruction, contents } = convertMessages(messages);

  const modelConfig = {};
  if (systemInstruction) {
    modelConfig.systemInstruction = systemInstruction;
  }

  const model = genAI.getGenerativeModel({ model: modelName, ...modelConfig });

  let result;
  try {
    result = await model.generateContentStream({ contents });
  } catch (err) {
    yield { type: 'error', message: err.message };
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for await (const chunk of result.stream) {
      if (abortSignal?.aborted) {
        yield { type: 'error', message: 'Request cancelled' };
        return;
      }

      const text = chunk.text();
      if (text) {
        yield { type: 'delta', content: text };
      }

      // Extract usage from chunk metadata if available
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount || 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
      }
    }
  } catch (err) {
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
