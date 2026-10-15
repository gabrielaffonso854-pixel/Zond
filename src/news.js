import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config.js';
import { getSetting, setSetting, storeSystemLog } from './db.js';
import { recordError } from './errors.js';

const COLOR = 0xC8102E;
const DEFAULT_INTERVAL_MINUTES = 5;
const MAX_SOURCES = 10;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const NEWS_KEYS = {
  channelId: 'news_channel_id',
  enabled: 'news_enabled',
  intervalMinutes: 'news_interval_minutes',
  sources: 'news_sources',
  published: 'news_published_ids',
  nextAttemptAt: 'news_next_attempt_at',
  statusMessageId: 'news_status_message_id',
};
const serviceTimers = new Map();
const runningCycles = new Set();

export const DEFAULT_NEWS_SOURCES = config.newsDefaultSources.map((source) => ({ ...source }));

function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlText(block, tag) {
  const expression = new RegExp(`<(?:(?:[\\w.-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}\\s*>`, 'i');
  return decodeXml(block.match(expression)?.[1] ?? '');
}

function safeArticleUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function articleHash(article) {
  const identity = article.url || `${article.sourceUrl}\n${article.title}\n${article.publishedAt ?? ''}`;
  return crypto.createHash('sha256').update(identity).digest('hex');
}

export function parseNewsFeed(xml, source) {
  if (typeof xml !== 'string' || xml.length > MAX_FEED_BYTES) {
    throw new Error('O feed está vazio ou excede o limite de tamanho.');
  }
  const entries = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)];
  return entries.flatMap(([, format, block]) => {
    const title = xmlText(block, 'title');
    const linkElement = block.match(/<(?:[\w.-]+:)?link\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?link\s*>/i);
    const linkAttribute = block.match(/<(?:[\w.-]+:)?link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
    const rawLink = linkElement?.[2].trim() || linkAttribute || xmlText(block, 'guid') || xmlText(block, 'id');
    const url = safeArticleUrl(decodeXml(rawLink));
    const summary = xmlText(block, 'description') || xmlText(block, 'summary') || xmlText(block, 'content');
    const rawDate = xmlText(block, 'pubDate') || xmlText(block, 'published')
      || xmlText(block, 'updated') || xmlText(block, 'date');
    const parsedDate = rawDate ? Date.parse(rawDate) : Number.NaN;
    if (!title || !url) return [];
    return [{
      title: title.slice(0, 256),
      summary: summary.slice(0, 3500),
      url,
      sourceName: source.name,
      sourceUrl: source.url,
      publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
      hash: articleHash({ url, title, sourceUrl: source.url, publishedAt: rawDate || null }),
      format: format.toLowerCase(),
    }];
  });
}

function isPrivateAddress(address) {
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7));
  const parts = address.split('.').map(Number);
  return parts.length === 4 && (
    parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224
  );
}

export async function validateNewsSource(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Informe uma URL válida de feed RSS/Atom.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.local')
    || url.hostname.endsWith('.internal') || isIP(url.hostname)) {
    throw new Error('A fonte deve usar HTTPS público, sem credenciais, porta, fragmento ou endereço IP.');
  }
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Não foi possível resolver o domínio da fonte.');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('O domínio da fonte não pode apontar para endereços privados.');
  }
  return url.toString();
}

export function getNewsSettings(guildId) {
  const sources = getSetting(guildId, NEWS_KEYS.sources, DEFAULT_NEWS_SOURCES);
  const intervalMinutes = getSetting(guildId, NEWS_KEYS.intervalMinutes, DEFAULT_INTERVAL_MINUTES);
  const published = getSetting(guildId, NEWS_KEYS.published, []);
  return {
    channelId: getSetting(guildId, NEWS_KEYS.channelId, null),
    enabled: getSetting(guildId, NEWS_KEYS.enabled, false) === true,
    intervalMinutes: Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 1440
      ? intervalMinutes : DEFAULT_INTERVAL_MINUTES,
    sources: Array.isArray(sources) ? sources.filter((source) => source?.name && source?.url).slice(0, MAX_SOURCES) : [],
    published: Array.isArray(published) ? published.filter((hash) => typeof hash === 'string').slice(0, 1000) : [],
    nextAttemptAt: getSetting(guildId, NEWS_KEYS.nextAttemptAt, null),
    statusMessageId: getSetting(guildId, NEWS_KEYS.statusMessageId, null),
  };
}

function canConfigure(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)
    || member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function hasChannelPermission(channel, guild, permissions) {
  return Boolean(channel.permissionsFor(guild.members.me)?.has(permissions));
}

function getArticleEmbed(article, guild) {
  const emoji = guild.emojis.cache.find((candidate) => candidate.name === 'emoji_35');
  const timestamp = article.publishedAt ? Math.floor(Date.parse(article.publishedAt) / 1000) : null;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${emoji ? `${emoji} ` : ''}RedCloud NEWS`)
    .setDescription(`**${article.title}**${article.summary ? `\n\n${article.summary}` : ''}`)
    .addFields(
      { name: 'Fonte', value: article.sourceName.slice(0, 256), inline: true },
      { name: 'Notícia original', value: `[Acessar publicação](${article.url})`, inline: true },
    );
  if (timestamp) embed.addFields({ name: 'Publicado', value: `<t:${timestamp}:F> (<t:${timestamp}:R>)` });
  return embed;
}

function getStatusEmbed({ nextAttemptAt, result, lastArticle }) {
  const timestamp = Math.floor(nextAttemptAt / 1000);
  let description;
  if (lastArticle) {
    description = `Nova edição publicada: **${lastArticle.title}**.`;
  } else if (result === 'empty') {
    description = 'Nenhuma notícia nova foi encontrada nas fontes consultadas.';
  } else if (result === 'failed') {
    description = 'Não foi possível consultar as fontes nesta tentativa.';
  } else {
    description = 'Aguardando a próxima consulta das fontes configuradas.';
  }
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('RedCloud NEWS')
    .setDescription(`${description}\n\nPróxima consulta: <t:${timestamp}:R>.\nHorário previsto: <t:${timestamp}:F>.`)
    .setFooter({ text: 'O horário indica a próxima consulta; uma nova edição depende de notícias disponíveis.' });
}

async function fetchSource(source) {
  const sourceUrl = await validateNewsSource(source.url);
  const response = await fetch(sourceUrl, {
    method: 'GET',
    headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Fonte ${source.name} respondeu HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_FEED_BYTES) throw new Error(`Fonte ${source.name} excedeu o limite de tamanho.`);
  const xml = await response.text();
  if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error(`Fonte ${source.name} excedeu o limite de tamanho.`);
  return parseNewsFeed(xml, source);
}

async function fetchNews(sources) {
  const articles = [];
  let failures = 0;
  for (const source of sources) {
    try {
      articles.push(...await fetchSource(source));
    } catch (error) {
      failures += 1;
      recordError({ service: 'news', step: `consulta da fonte ${source.name}`, error });
    }
  }
  articles.sort((left, right) => (Date.parse(right.publishedAt || '') || 0) - (Date.parse(left.publishedAt || '') || 0));
  return { articles, failures };
}

function rememberPublished(guildId, hash, published) {
  const hashes = [...new Set([hash, ...published])].slice(0, 1000);
  setSetting(guildId, NEWS_KEYS.published, hashes);
}

async function updateStatusMessage(guild, channel, settings, result, lastArticle) {
  const statusPayload = {
    embeds: [getStatusEmbed({ nextAttemptAt: settings.nextAttemptAt, result, lastArticle })],
    allowedMentions: { parse: [] },
  };
  let existing = null;
  if (settings.statusMessageId) {
    existing = await channel.messages.fetch(settings.statusMessageId).catch(() => null);
  }
  if (existing) {
    const canManage = hasChannelPermission(channel, guild, PermissionFlagsBits.ManageMessages);
    if (lastArticle && canManage) {
      try {
        await existing.delete();
        existing = null;
      } catch (error) {
        recordError({ service: 'news', step: 'substituição da mensagem de status', error });
      }
      if (existing) {
        await existing.edit(statusPayload);
        return;
      }
    } else {
      await existing.edit(statusPayload);
      return;
    }
  }
  const statusMessage = await channel.send(statusPayload);
  setSetting(guild.id, NEWS_KEYS.statusMessageId, statusMessage.id);
}

async function runCycle(client, guildId, { manual = false } = {}) {
  if (runningCycles.has(guildId)) return { busy: true };
  runningCycles.add(guildId);
  let settings = getNewsSettings(guildId);
  try {
    if (!manual && !settings.enabled) return { disabled: true };
    if (!settings.channelId) throw new Error('Configure um canal com /jornal canal antes de publicar.');
    const guild = client.guilds.cache.get(guildId);
    const channel = await guild?.channels.fetch(settings.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) {
      throw new Error('O canal de notícias configurado não está disponível.');
    }
    if (!hasChannelPermission(channel, guild, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])) {
      throw new Error('O bot precisa de Ver canal, Enviar mensagens e Incorporar links no canal de notícias.');
    }

    const { articles, failures } = await fetchNews(settings.sources);
    const published = new Set(settings.published);
    const article = articles.find((item) => !published.has(item.hash));
    settings.nextAttemptAt = Date.now() + settings.intervalMinutes * 60_000;
    if (settings.enabled) setSetting(guildId, NEWS_KEYS.nextAttemptAt, settings.nextAttemptAt);

    if (article) {
      rememberPublished(guildId, article.hash, settings.published);
      try {
        await channel.send({ embeds: [getArticleEmbed(article, guild)], allowedMentions: { parse: [] } });
      } catch (error) {
        setSetting(guildId, NEWS_KEYS.published, settings.published);
        throw error;
      }
      storeSystemLog({ guildId, module: 'jornal', eventType: 'notícia publicada', details: { title: article.title, source: article.sourceName, url: article.url } });
      if (settings.enabled) await updateStatusMessage(guild, channel, settings, 'published', article);
      return { published: true, article, nextAttemptAt: settings.nextAttemptAt };
    }

    const result = failures === settings.sources.length && failures > 0 ? 'failed' : 'empty';
    if (settings.enabled) await updateStatusMessage(guild, channel, settings, result, null);
    return { published: false, result, failures, nextAttemptAt: settings.nextAttemptAt };
  } finally {
    runningCycles.delete(guildId);
  }
}

export async function runNewsCheck(client, guildId = config.discordGuildId) {
  const result = await runCycle(client, guildId, { manual: true });
  if (getNewsSettings(guildId).enabled && result.nextAttemptAt) {
    scheduleNext(client, guildId, result.nextAttemptAt);
  }
  return result;
}

function scheduleNext(client, guildId, timestamp) {
  const current = serviceTimers.get(guildId);
  if (current) clearTimeout(current);
  const delay = Math.max(0, Math.min(timestamp - Date.now(), 2_147_000_000));
  const timer = setTimeout(async () => {
    serviceTimers.delete(guildId);
    try {
      await runCycle(client, guildId);
    } catch (error) {
      recordError({ service: 'news', step: 'ciclo automático', error });
      const settings = getNewsSettings(guildId);
      const nextAttemptAt = Date.now() + settings.intervalMinutes * 60_000;
      setSetting(guildId, NEWS_KEYS.nextAttemptAt, nextAttemptAt);
    }
    const settings = getNewsSettings(guildId);
    if (settings.enabled) {
      const nextAttemptAt = Number(settings.nextAttemptAt) > Date.now()
        ? Number(settings.nextAttemptAt)
        : Date.now() + settings.intervalMinutes * 60_000;
      setSetting(guildId, NEWS_KEYS.nextAttemptAt, nextAttemptAt);
      scheduleNext(client, guildId, nextAttemptAt);
    }
  }, delay);
  timer.unref?.();
  serviceTimers.set(guildId, timer);
}

export function startNewsService(client, guildId = config.discordGuildId) {
  const settings = getNewsSettings(guildId);
  if (!settings.enabled) return false;
  const nextAttemptAt = Number(settings.nextAttemptAt);
  const timestamp = Number.isFinite(nextAttemptAt) && nextAttemptAt > 0 ? nextAttemptAt : Date.now();
  setSetting(guildId, NEWS_KEYS.nextAttemptAt, timestamp);
  scheduleNext(client, guildId, timestamp);
  return true;
}

export function stopNewsService(guildId = config.discordGuildId) {
  const timer = serviceTimers.get(guildId);
  if (timer) clearTimeout(timer);
  serviceTimers.delete(guildId);
}

export async function handleNewsSlash(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const requiresAdmin = subcommand !== 'estado';
  if (requiresAdmin && !canConfigure(interaction.member)) {
    await interaction.reply({ content: 'Você precisa de Gerenciar servidor ou Administrador para alterar o jornal.', ephemeral: true });
    return;
  }

  const settings = getNewsSettings(interaction.guildId);
  if (subcommand === 'estado') {
    const next = settings.nextAttemptAt ? `<t:${Math.floor(settings.nextAttemptAt / 1000)}:R>` : 'não agendada';
    await interaction.reply({
      content: `Jornal: **${settings.enabled ? 'ativo' : 'inativo'}**\nCanal: ${settings.channelId ? `<#${settings.channelId}>` : 'não configurado'}\nIntervalo: **${settings.intervalMinutes} minuto(s)**\nFontes: **${settings.sources.length}**\nPróxima consulta: ${next}`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === 'canal') {
    const channel = interaction.options.getChannel('canal', true);
    if (channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: 'Selecione um canal de texto deste servidor.', ephemeral: true });
      return;
    }
    if (!hasChannelPermission(channel, interaction.guild, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      await interaction.reply({ content: 'O bot precisa de Ver canal, Enviar mensagens e Incorporar links no canal selecionado.', ephemeral: true });
      return;
    }
    setSetting(interaction.guildId, NEWS_KEYS.channelId, channel.id);
    if (settings.enabled) {
      setSetting(interaction.guildId, NEWS_KEYS.nextAttemptAt, Date.now());
      scheduleNext(interaction.client, interaction.guildId, Date.now());
    }
    storeSystemLog({ guildId: interaction.guildId, module: 'jornal', eventType: 'canal configurado', details: { executor: interaction.user.id, channelId: channel.id } });
    await interaction.reply({ content: `Canal de notícias configurado: <#${channel.id}>. O jornal permanece ${settings.enabled ? 'ativo' : 'inativo'}.`, ephemeral: true });
    return;
  }

  if (subcommand === 'automatico') {
    const enabled = interaction.options.getString('estado', true) === 'ativar';
    if (enabled && !settings.channelId) {
      await interaction.reply({ content: 'Configure primeiro o canal com `/jornal canal`.', ephemeral: true });
      return;
    }
    setSetting(interaction.guildId, NEWS_KEYS.enabled, enabled);
    if (enabled) {
      const nextAttemptAt = Date.now();
      setSetting(interaction.guildId, NEWS_KEYS.nextAttemptAt, nextAttemptAt);
      scheduleNext(interaction.client, interaction.guildId, nextAttemptAt);
    } else {
      setSetting(interaction.guildId, NEWS_KEYS.nextAttemptAt, null);
      stopNewsService(interaction.guildId);
    }
    storeSystemLog({ guildId: interaction.guildId, module: 'jornal', eventType: enabled ? 'jornal ativado' : 'jornal desativado', details: { executor: interaction.user.id } });
    await interaction.reply({ content: `Jornal automático ${enabled ? 'ativado' : 'desativado'}. As configurações e o histórico foram preservados.`, ephemeral: true });
    return;
  }

  if (subcommand === 'intervalo') {
    const minutes = interaction.options.getInteger('minutos', true);
    setSetting(interaction.guildId, NEWS_KEYS.intervalMinutes, minutes);
    if (settings.enabled) {
      const nextAttemptAt = Date.now() + minutes * 60_000;
      setSetting(interaction.guildId, NEWS_KEYS.nextAttemptAt, nextAttemptAt);
      scheduleNext(interaction.client, interaction.guildId, nextAttemptAt);
    }
    await interaction.reply({ content: `Intervalo configurado para **${minutes} minuto(s)**.`, ephemeral: true });
    return;
  }

  if (subcommandGroup === 'fonte') {
    const operation = subcommand;
    const sources = [...settings.sources];
    if (operation === 'listar') {
      await interaction.reply({ content: sources.length
        ? sources.map((source, index) => `${index + 1}. **${source.name}** — ${source.url}`).join('\n')
        : 'Nenhuma fonte está configurada.', ephemeral: true });
      return;
    }
    if (operation === 'adicionar') {
      const name = interaction.options.getString('nome', true).trim().slice(0, 80);
      if (!name) {
        await interaction.reply({ content: 'Informe um nome não vazio para a fonte.', ephemeral: true });
        return;
      }
      const url = await validateNewsSource(interaction.options.getString('url', true));
      if (sources.some((source) => source.url === url)) {
        await interaction.reply({ content: 'Essa fonte já está configurada.', ephemeral: true });
        return;
      }
      if (sources.length >= MAX_SOURCES) {
        await interaction.reply({ content: `O limite é de ${MAX_SOURCES} fontes por servidor.`, ephemeral: true });
        return;
      }
      sources.push({ name, url });
      setSetting(interaction.guildId, NEWS_KEYS.sources, sources);
      await interaction.reply({ content: `Fonte **${name}** adicionada.`, ephemeral: true });
      return;
    }
    const name = interaction.options.getString('nome', true).trim().toLowerCase();
    const updated = sources.filter((source) => source.name.toLowerCase() !== name);
    if (updated.length === sources.length) {
      await interaction.reply({ content: 'Não encontrei uma fonte com esse nome.', ephemeral: true });
      return;
    }
    setSetting(interaction.guildId, NEWS_KEYS.sources, updated);
    await interaction.reply({ content: `Fonte **${name}** removida.`, ephemeral: true });
    return;
  }

  if (subcommand === 'teste') {
    await interaction.deferReply({ ephemeral: true });
    const result = await runCycle(interaction.client, interaction.guildId, { manual: true });
    if (settings.enabled && result.nextAttemptAt) {
      scheduleNext(interaction.client, interaction.guildId, result.nextAttemptAt);
    }
    if (result.published) {
      await interaction.editReply(`Notícia real publicada no canal configurado: **${result.article.title}**.`);
    } else if (result.busy) {
      await interaction.editReply('Uma consulta já está em andamento.');
    } else {
      await interaction.editReply(result.failures
        ? 'Nenhuma notícia foi publicada; as fontes falharam ou não trouxeram notícias novas. Consulte os registros técnicos.'
        : 'Nenhuma notícia nova foi encontrada. Não foi publicado conteúdo inventado.');
    }
  }
}

export function createNewsCommand() {
  return new SlashCommandBuilder()
    .setName('jornal')
    .setDescription('Configurar e consultar o jornal automático da Zonde')
    .addSubcommand((subcommand) => subcommand.setName('canal').setDescription('Configurar o canal de notícias')
      .addChannelOption((option) => option.setName('canal').setDescription('Canal de texto para as notícias')
        .addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('automatico').setDescription('Ativar ou desativar o jornal')
      .addStringOption((option) => option.setName('estado').setDescription('Estado do agendamento')
        .addChoices({ name: 'ativar', value: 'ativar' }, { name: 'desativar', value: 'desativar' }).setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('estado').setDescription('Consultar a configuração do jornal'))
    .addSubcommand((subcommand) => subcommand.setName('teste').setDescription('Buscar e publicar uma notícia real ainda não enviada'))
    .addSubcommand((subcommand) => subcommand.setName('intervalo').setDescription('Definir o intervalo entre consultas')
      .addIntegerOption((option) => option.setName('minutos').setDescription('De 1 a 1.440 minutos; padrão: 5')
        .setMinValue(1).setMaxValue(1440).setRequired(true)))
    .addSubcommandGroup((group) => group.setName('fonte').setDescription('Gerenciar fontes RSS/Atom autorizadas')
      .addSubcommand((subcommand) => subcommand.setName('adicionar').setDescription('Adicionar um feed HTTPS público')
        .addStringOption((option) => option.setName('nome').setDescription('Nome exibido para a fonte').setMaxLength(80).setRequired(true))
        .addStringOption((option) => option.setName('url').setDescription('URL HTTPS do feed RSS ou Atom').setMaxLength(500).setRequired(true)))
      .addSubcommand((subcommand) => subcommand.setName('remover').setDescription('Remover uma fonte pelo nome')
        .addStringOption((option) => option.setName('nome').setDescription('Nome exato da fonte').setMaxLength(80).setRequired(true)))
      .addSubcommand((subcommand) => subcommand.setName('listar').setDescription('Listar as fontes configuradas')));
}

export function newsSettingsKeys() {
  return { ...NEWS_KEYS };
}

export function isNewsTimerActive(guildId) {
  return serviceTimers.has(guildId);
}
