import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { recordError } from './errors.js';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 5_000_000;
export const DISCORD_QUESTS_API_URL = 'https://api.discordquest.com/api/quests';

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || octets[0] >= 224;
}

export async function validateMissionFeedUrl(value, { resolveHost = lookup } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Informe a URL HTTPS pública de um feed JSON de missões.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.local')
    || url.hostname.endsWith('.internal') || isIP(url.hostname)) {
    throw new Error('A fonte deve ser HTTPS público, sem credenciais, parâmetros, porta ou endereço IP.');
  }
  let addresses;
  try {
    addresses = await resolveHost(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Não foi possível resolver o domínio público da fonte de missões.');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('A fonte não pode apontar para endereços privados ou locais.');
  }
  return url.toString();
}

export async function fetchPublicMissionFeed(value, { resolveHost = lookup, fetchImpl = fetch } = {}) {
  if (!value) throw new Error('Nenhuma fonte pública de missões foi configurada.');
  let sourceUrl;
  try {
    sourceUrl = await validateMissionFeedUrl(value, { resolveHost });
  } catch (error) {
    recordError({ service: 'missions', step: 'validar fonte pública', error });
    throw error;
  }

  try {
    const response = await fetchImpl(sourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_FEED_BYTES) throw new Error('resposta acima de 1 MB');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_FEED_BYTES) throw new Error('resposta acima de 1 MB');
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || typeof body !== 'object') throw new Error('JSON de missões inválido');
    return { body };
  } catch (error) {
    const status = String(error?.message || '').match(/^HTTP (\d{3})$/)?.[1];
    const summary = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'A fonte pública de missões excedeu o tempo limite.'
      : status ? `A fonte pública de missões respondeu HTTP ${status}.`
        : 'A fonte pública de missões falhou na rede ou retornou dados inválidos.';
    const safeError = new Error(summary);
    recordError({ service: 'missions', step: 'consulta da fonte pública', error: safeError });
    throw safeError;
  }
}

export function fetchDiscordQuestsApi(options) {
  return fetchPublicMissionFeed(DISCORD_QUESTS_API_URL, options);
}