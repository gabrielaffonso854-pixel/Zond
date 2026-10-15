import { config } from './config.js';
import { recordError } from './errors.js';

const CHAT_URL = 'https://huehue.app/v1/chatgpt';
const MISSIONS_URL = 'https://huehue.app/v1/discord/missoes';
const DISCORD_SERVER_URL = 'https://huehue.app/v1/discord/servidor/discord-developers';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000;

const activeRequests = new Map();
let missionState = {
  enabled: false,
  reason: 'A conectividade da API ainda não foi verificada.',
};

function extractText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const candidates = [
    value.resposta,
    value.response,
    value.mensagem,
    value.message,
    value.content,
    value.resultado,
    value.result,
    value.choices?.[0]?.message?.content,
    value.choices?.[0]?.text,
    value.data?.resposta,
    value.data?.response,
    value.data?.message,
    value.data?.content,
  ];
  return candidates.find((item) => typeof item === 'string' && item.trim())?.trim() ?? '';
}

async function readResponseBody(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('A API HueHue retornou uma resposta acima do limite de 1 MB.');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('A API HueHue retornou uma resposta acima do limite de 1 MB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function request(url, init, service) {
  if (!config.huehueApiKey) {
    const error = new Error('A variável HUEHUE_API_KEY não está configurada.');
    recordError({ service, step: 'configuração', error });
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.huehueApiKey}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
    if (!response.ok) {
      const error = new Error(`A API HueHue respondeu HTTP ${response.status}.`);
      recordError({
        service,
        step: 'resposta HTTP',
        error,
        httpStatus: response.status,
        requestId,
      });
      throw error;
    }
    const bodyText = await readResponseBody(response);
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }
    if (body === null) {
      const error = new Error('A API HueHue retornou uma resposta vazia ou JSON inválido.');
      recordError({ service, step: 'validação da resposta', error, requestId });
      throw error;
    }
    return { body, requestId };
  } catch (error) {
    if (error?.loggedByHuehue) throw error;
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('A solicitação à API HueHue excedeu o tempo limite.');
      recordError({ service, step: 'timeout', error: timeoutError });
      throw timeoutError;
    }
    if (/^A API HueHue/.test(error?.message || '')) {
      if (/acima do limite/.test(error.message)) {
        recordError({ service, step: 'limite da resposta', error, requestId });
      }
      throw error;
    }
    recordError({ service, step: 'rede', error });
    throw new Error('Não foi possível conectar à API HueHue.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function askHuehue(message, { requestKey } = {}) {
  const key = requestKey || message;
  if (activeRequests.has(key)) return activeRequests.get(key);
  const pending = (async () => {
    const { body } = await request(
      CHAT_URL,
      { method: 'POST', body: JSON.stringify({ mensagem: message }) },
      'huehue-chat',
    );
    const text = extractText(body);
    if (!text) {
      const error = new Error('A resposta da API não contém um campo de texto reconhecido.');
      recordError({ service: 'huehue-chat', step: 'validação do conteúdo', error });
      throw error;
    }
    return text;
  })();
  activeRequests.set(key, pending);
  try {
    return await pending;
  } finally {
    activeRequests.delete(key);
  }
}

export async function fetchMissions() {
  return request(MISSIONS_URL, { method: 'GET' }, 'huehue-missoes');
}

export async function fetchDiscordServer() {
  const { body } = await request(DISCORD_SERVER_URL, { method: 'GET' }, 'huehue-discord-server');
  return body;
}

export async function probeMissionApi() {
  if (!config.huehueApiKey) {
    missionState = {
      enabled: false,
      reason: 'HUEHUE_API_KEY não configurada; monitoramento desativado.',
    };
    return missionState;
  }
  try {
    const { body } = await fetchMissions();
    const hasRecognizedCollection = Array.isArray(body)
      || (body && typeof body === 'object'
        && ['missoes', 'missions', 'data'].some((key) => Array.isArray(body[key])
          || (body[key] && typeof body[key] === 'object'
            && ['missoes', 'missions'].some((nestedKey) => Array.isArray(body[key][nestedKey])))));
    if (!hasRecognizedCollection) {
      missionState = {
        enabled: false,
        reason: 'API acessível, mas o formato de missões não reconhecido; monitoramento desativado para evitar publicações incorretas.',
      };
      return missionState;
    }
    missionState = {
      enabled: false,
      reason: 'O endpoint respondeu, mas o monitoramento está desativado até o formato completo dos campos ser confirmado.',
    };
  } catch (error) {
    const status = error.message.match(/HTTP (\d{3})/)?.[1];
    missionState = {
      enabled: false,
      reason: status
        ? `API HueHue respondeu HTTP ${status}; monitoramento desativado.`
        : 'Não foi possível validar o acesso à API HueHue; monitoramento desativado.',
    };
  }
  return missionState;
}

export function missionStatus() {
  return missionState;
}

export function parseHuehueText(value) {
  return extractText(value);
}
