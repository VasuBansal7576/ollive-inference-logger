const PATTERNS = [
  {
    name: 'EMAIL',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL_REDACTED]',
  },
  {
    name: 'PHONE',
    regex: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replacement: '[PHONE_REDACTED]',
  },
  {
    name: 'SSN',
    regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    replacement: '[SSN_REDACTED]',
  },
  {
    name: 'CREDIT_CARD',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: '[CC_REDACTED]',
  },
  {
    name: 'API_KEY',
    regex: /\b(sk-[a-zA-Z0-9]{20,}|gsk_[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{35})\b/g,
    replacement: '[API_KEY_REDACTED]',
  },
];

/**
 * Scan text for PII and replace with redaction markers.
 * @param {string} text
 * @returns {{ text: string, detected: string[], redacted: boolean }}
 */
export function redact(text) {
  if (!text || typeof text !== 'string') {
    return { text: text ?? '', detected: [], redacted: false };
  }

  const detected = [];
  let result = text;

  for (const pattern of PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(result)) {
      detected.push(pattern.name);
      pattern.regex.lastIndex = 0;
      result = result.replace(pattern.regex, pattern.replacement);
    }
  }

  return {
    text: result,
    detected,
    redacted: detected.length > 0,
  };
}
