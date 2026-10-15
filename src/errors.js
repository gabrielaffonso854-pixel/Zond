import { storeError } from './db.js';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /https:\/\/[^/\s:@]+:[^/\s@]+@/gi,
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/gi,
];

export function sanitize(value) {
  let text = String(value ?? 'Erro sem mensagem').slice(0, 1000);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redigido]');
  }
  return text;
}

export function recordError({ service, step, error, httpStatus, requestId }) {
  const entry = {
    createdAt: new Date().toISOString(),
    service,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : undefined,
    errorType: sanitize(error?.name || 'Error').slice(0, 100),
    step: sanitize(step).slice(0, 100),
    message: sanitize(error?.message || error),
    requestId: requestId ? sanitize(requestId).slice(0, 150) : undefined,
  };

  try {
    storeError(entry);
  } catch (storageError) {
    console.error('Falha ao persistir registro técnico:', sanitize(storageError.message));
  }
  console.error(`[${entry.service}/${entry.step}] ${entry.errorType}: ${entry.message}`);
  return entry;
}
