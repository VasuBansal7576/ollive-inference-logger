import test from 'node:test';
import assert from 'node:assert';
import { redact } from '../src/redactor.js';

test('PII Redactor — Email Redaction', () => {
  const input = 'My email is john.doe@example.com and secondary is jane@work.co';
  const result = redact(input);

  assert.strictEqual(result.redacted, true);
  assert.deepStrictEqual(result.detected, ['EMAIL']);
  assert.strictEqual(result.text.includes('john.doe@example.com'), false);
  assert.strictEqual(result.text.includes('jane@work.co'), false);
  assert.strictEqual(result.text, 'My email is [EMAIL_REDACTED] and secondary is [EMAIL_REDACTED]');
});

test('PII Redactor — Phone Redaction', () => {
  const input = 'Call me at 555-555-0199 or +1 800 555 1234';
  const result = redact(input);

  assert.strictEqual(result.redacted, true);
  assert.deepStrictEqual(result.detected, ['PHONE']);
  assert.strictEqual(result.text.includes('555-555-0199'), false);
  assert.strictEqual(result.text, 'Call me at [PHONE_REDACTED] or [PHONE_REDACTED]');
});

test('PII Redactor — SSN Redaction', () => {
  const input = 'My SSN number is 123-45-6789';
  const result = redact(input);

  assert.strictEqual(result.redacted, true);
  assert.deepStrictEqual(result.detected, ['SSN']);
  assert.strictEqual(result.text.includes('123-45-6789'), false);
  assert.strictEqual(result.text, 'My SSN number is [SSN_REDACTED]');
});

test('PII Redactor — Credit Card Redaction', () => {
  const input = 'My Visa card number is 4111-1111-1111-1111';
  const result = redact(input);

  assert.strictEqual(result.redacted, true);
  assert.deepStrictEqual(result.detected, ['CREDIT_CARD']);
  assert.strictEqual(result.text.includes('4111-1111-1111-1111'), false);
  assert.strictEqual(result.text, 'My Visa card number is [CC_REDACTED]');
});

test('PII Redactor — API Key Redaction', () => {
  const groqKey = 'gsk_yH7bN28vLxJkPqMw92nB10sD82fT';
  const input = `Do not share your API key: ${groqKey}`;
  const result = redact(input);

  assert.strictEqual(result.redacted, true);
  assert.deepStrictEqual(result.detected, ['API_KEY']);
  assert.strictEqual(result.text.includes(groqKey), false);
  assert.strictEqual(result.text, 'Do not share your API key: [API_KEY_REDACTED]');
});

test('PII Redactor — No PII', () => {
  const input = 'This is a normal message talking about LLM metrics and WAL sqlite mode.';
  const result = redact(input);

  assert.strictEqual(result.redacted, false);
  assert.deepStrictEqual(result.detected, []);
  assert.strictEqual(result.text, input);
});
