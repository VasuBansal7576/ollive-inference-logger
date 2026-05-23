import { parentPort } from 'worker_threads';
import { redact } from '../redactor.js';

parentPort.on('message', ({ id, text }) => {
  const result = redact(text);
  parentPort.postMessage({ id, result });
});
