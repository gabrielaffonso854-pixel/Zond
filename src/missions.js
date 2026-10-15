import crypto from 'node:crypto';
import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config.js';
import { db, getSetting, recentErrors, setSetting } from './db.js';
import { recordError } from './errors.js';
import {
  DISCORD_QUESTS_API_URL,
  fetchPublicMissionFeed,
  validateMissionFeedUrl,
} from './mission-feed.js';

const COLOR = 0xC8102E;
const MAX_MISSION_DESCRIPTION = 2000;
const schedulerByGuild = new Map();

db.exec(`
  CREATE TABLE IF NOT EXISTS external_missions (
    guild_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    origin TEXT NOT NULL,
    reward_orbs INTEGER,
    starts_at TEXT,
    ends_at TEXT NOT NULL,
    official_url TEXT,
    official_status TEXT,
    status TEXT NOT NULL CHECK (status IN ('available', 'expiring', 'expired')),
    available_message_id TEXT,
    expired_message_id TEXT,
    available_payload TEXT,
    original_expiry_handled INTEGER NOT NULL DEFAULT 0,
    image_url TEXT,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expired_at TEXT,
    PRIMARY KEY (guild_id, source_id)
  );
  CREATE INDEX IF NOT EXISTS external_missions_due
    ON external_missions(guild_id, status, ends_at);
  CREATE TABLE IF NOT EXISTS mission_service_events (
    guild_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    source_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'published')),
    message_id TEXT,
    target_channel_id TEXT,
    embed_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, event_key)
  );
  CREATE TABLE IF NOT EXISTS mission_activity (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS mission_service_state (
    guild_id TEXT PRIMARY KEY,
    last_started_at TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    total_orbs_obtained INTEGER,
    active_members_updated_at TEXT,
    stats_fingerprint TEXT,
    stats_news_at TEXT
  );
`);

const missionEventColumns = new Set(db.prepare('PRAGMA table_info(mission_service_events)').all().map((column) => column.name));
if (!missionEventColumns.has('target_channel_id')) {
  db.exec('ALTER TABLE mission_service_events ADD COLUMN target_channel_id TEXT');
}
if (!missionEventColumns.has('embed_json')) {
  db.exec('ALTER TABLE mission_service_events ADD COLUMN embed_json TEXT');
}
const missionStateColumns = new Set(db.prepare('PRAGMA table_info(mission_service_state)').all().map((column) => column.name));
if (!missionStateColumns.has('stats_fingerprint')) {
  db.exec('ALTER TABLE mission_service_state ADD COLUMN stats_fingerprint TEXT');
}
if (!missionStateColumns.has('stats_news_at')) {
  db.exec('ALTER TABLE mission_service_state ADD COLUMN stats_news_at TEXT');
}
if (!missionStateColumns.has('last_result')) {
  db.exec('ALTER TABLE mission_service_state ADD COLUMN last_result TEXT');
}
if (!missionStateColumns.has('last_checked_count')) {
  db.exec('ALTER TABLE mission_service_state ADD COLUMN last_checked_count INTEGER');
}
const missionColumns = new Set(db.prepare('PRAGMA table_info(external_missions)').all().map((column) => column.name));
if (!missionColumns.has('image_url')) {
  db.exec('ALTER TABLE external_missions ADD COLUMN image_url TEXT');
}

export const missionCommand = new SlashCommandBuilder()
  .setName('missoes')
  .setDescription('Sincronizar e configurar missões verificadas')
  .addSubcommand((subcommand) => subcommand.setName('estado').setDescription('Consultar o estado do serviço'))
  .addSubcommand((subcommand) => subcommand.setName('sincronizar').setDescription('Executar uma sincronização manual'))
  .addSubcommand((subcommand) => subcommand.setName('configurar').setDescription('Configurar publicação e estatísticas')
    .addStringOption((option) => option.setName('fonte_url').setDescription('URL HTTPS pública de feed JSON; vazio remove a fonte')
      .setMaxLength(500))
    .addBooleanOption((option) => option.setName('automatico').setDescription('Ativar publicação automática'))
    .addChannelOption((option) => option.setName('disponiveis').setDescription('Canal de missões disponíveis')
      .addChannelTypes(ChannelType.GuildText))
    .addChannelOption((option) => option.setName('expiradas').setDescription('Canal de missões expiradas')
      .addChannelTypes(ChannelType.GuildText))
    .addIntegerOption((option) => option.setName('intervalo').setDescription('Intervalo de verificação em segundos')
      .setMinValue(60).setMaxValue(86400))
    .addBooleanOption((option) => option.setName('avisos_expiracao').setDescription('Publicar aviso ao entrar na janela de expiração'))
    .addChannelOption((option) => option.setName('canal_ativos').setDescription('Canal de voz para usuários ativos recentes')
      .addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption((option) => option.setName('canal_missoes_mes').setDescription('Canal de voz para missões verificadas neste mês')
      .addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption((option) => option.setName('canal_orbs').setDescription('Canal de voz para total de Orbs obtidos')
      .addChannelTypes(ChannelType.GuildVoice))
  );

const missionDefaults = () => ({
  automatic: false,
  availableChannelId: config.channels.missionsAvailable,
  unavailableChannelId: config.channels.missionsUnavailable,
  newspaperChannelId: config.channels.newspaper,
  intervalSeconds: config.missionPollIntervalSeconds,
  expiryWarnings: true,
  expiryWarningMinutes: config.missionExpiryWarningMinutes,
  removeExpiredPosts: config.missionRemoveExpiredPosts,
  activeDays: config.missionActiveDays,
  activeVoiceChannelId: null,
  monthlyMissionsVoiceChannelId: null,
  totalOrbsVoiceChannelId: null,
});

export function getMissionSettings(guildId) {
  const stored = getSetting(guildId, 'mission_service', {});
  return {
    ...missionDefaults(),
    ...stored,
    feedUrl: getSetting(guildId, 'mission_feed_url', stored.feedUrl || null),
    availableChannelId: getSetting(guildId, 'missions_available_channel', stored.availableChannelId || config.channels.missionsAvailable),
    unavailableChannelId: getSetting(guildId, 'missions_unavailable_channel', stored.unavailableChannelId || config.channels.missionsUnavailable),
  };
}

export function updateMissionSettings(guildId, update) {
  if (!guildId) throw new Error('A configuração de missões exige um servidor.');
  const current = getMissionSettings(guildId);
  const next = { ...current, ...update };
  if (!Number.isSafeInteger(next.intervalSeconds) || next.intervalSeconds < 60 || next.intervalSeconds > 86400) {
    throw new Error('O intervalo de sincronização deve ser entre 60 e 86.400 segundos.');
  }
  if (!Number.isSafeInteger(next.expiryWarningMinutes) || next.expiryWarningMinutes < 1 || next.expiryWarningMinutes > 10080) {
    throw new Error('A janela de aviso deve ser entre 1 e 10.080 minutos.');
  }
  setSetting(guildId, 'mission_service', next);
  if (Object.hasOwn(update, 'feedUrl')) setSetting(guildId, 'mission_feed_url', update.feedUrl);
  if (update.availableChannelId) setSetting(guildId, 'missions_available_channel', update.availableChannelId);
  if (update.unavailableChannelId) setSetting(guildId, 'missions_unavailable_channel', update.unavailableChannelId);
  return next;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function parseDate(value, field, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`A missão não contém uma data de expiração válida (${field}).`);
    return null;
  }
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`Data inválida no campo ${field}.`);
  return new Date(timestamp).toISOString();
}

function parseRewardOrbs(item) {
  const reward = firstDefined(item.reward, item.rewards);
  const raw = firstDefined(
    item.reward_orbs,
    item.orb_reward,
    item.orbs,
    reward && !Array.isArray(reward) ? reward.orbs : undefined,
  );
  if (raw === undefined) return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function findMissionRows(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') throw new Error('A fonte de missões retornou um formato desconhecido.');
  for (const key of ['missoes', 'missions', 'data']) {
    const value = body[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      for (const nestedKey of ['missoes', 'missions']) {
        if (Array.isArray(value[nestedKey])) return value[nestedKey];
      }
    }
  }
  throw new Error('A fonte respondeu, mas não contém uma lista de missões reconhecida.');
}

function normalizeMission(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('A fonte retornou um registro de missão inválido.');
  }
  const questConfig = item.config && typeof item.config === 'object' ? item.config : {};
  const messages = questConfig.messages || {};
  const application = questConfig.application || {};
  const sourceId = firstDefined(item.id, item.mission_id, item.quest_id, questConfig.id);
  const title = firstDefined(item.name, item.title, item.nome, item.titulo, messages.quest_name);
  const rawEnd = firstDefined(item.expires_at, item.expiresAt, item.end_at, item.ends_at, item.endsAt, item.end_date, questConfig.expires_at);
  if (sourceId === undefined || !String(sourceId).trim() || String(sourceId).length > 200) {
    throw new Error('A missão não possui identificador válido na fonte.');
  }
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 256) {
    throw new Error('A missão não possui nome válido na fonte.');
  }
  const endAt = parseDate(rawEnd, 'expires_at', true);
  const startAt = parseDate(firstDefined(item.starts_at, item.startsAt, item.start_at, item.start_date, questConfig.starts_at), 'starts_at');
  const description = firstDefined(item.description, item.descricao, item.details, item.instructions, questConfig.description);
  const game = firstDefined(application.name, messages.game_title);
  const publisher = firstDefined(messages.game_publisher, application.publisher);
  const rewardItems = [
    ...(Array.isArray(questConfig.rewards) ? questConfig.rewards : []),
    ...(Array.isArray(questConfig.rewards_config?.rewards) ? questConfig.rewards_config.rewards : []),
  ];
  const rewardNames = [...new Set(rewardItems.map((reward) => {
    const name = firstDefined(reward?.messages?.name, reward?.name);
    const orbs = firstDefined(reward?.orb_quantity, reward?.orbs);
    if (typeof name === 'string' && name.trim()) return name.trim();
    if (Number.isSafeInteger(orbs) && orbs >= 0) return `${orbs} Orbs`;
    return null;
  }).filter(Boolean))];
  const rawRegions = firstDefined(item.regions, item.region, item.available_regions, questConfig.regions, questConfig.region);
  const regions = (Array.isArray(rawRegions) ? rawRegions : [rawRegions])
    .map((region) => typeof region === 'string' ? region : region?.name || region?.code)
    .filter((region) => typeof region === 'string' && region.trim());
  const details = [
    typeof game === 'string' && game.trim() ? `Jogo: ${game.trim()}` : null,
    typeof publisher === 'string' && publisher.trim() ? `Publicadora: ${publisher.trim()}` : null,
    rewardNames.length ? `Recompensas informadas: ${rewardNames.join(', ')}` : null,
    regions.length ? `Regiões informadas: ${[...new Set(regions)].join(', ')}` : null,
    typeof application.link === 'string' && /^https:\/\//i.test(application.link)
      ? `Link oficial do jogo: ${application.link}` : null,
  ].filter(Boolean);
  const descriptionText = [description, ...details].filter((value) => typeof value === 'string' && value.trim()).join('\n\n');
  const origin = firstDefined(item.origin, item.source, item.provider, item.origem, game, publisher,
    questConfig.id ? 'Discord Quests API' : null);
  const rawUrl = firstDefined(item.url, item.link, item.official_url, item.officialUrl);
  let officialUrl = null;
  if (typeof rawUrl === 'string') {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:') officialUrl = parsed.href;
    } catch {
      officialUrl = null;
    }
  }
  const status = firstDefined(item.status, item.state);
  const rawImage = firstDefined(item.image_url, item.imageUrl, item.image, questConfig.image_url,
    questConfig.assets?.hero_url, questConfig.assets?.hero);
  let imageUrl = null;
  if (typeof rawImage === 'string') {
    try {
      const parsed = new URL(rawImage);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) imageUrl = parsed.href;
    } catch {
      imageUrl = null;
    }
  }
  const apiOrbs = rewardItems.map((reward) => reward?.orb_quantity ?? reward?.orbs)
    .find((value) => Number.isSafeInteger(value) && value >= 0);
  return {
    sourceId: String(sourceId).trim(),
    title: title.trim(),
    description: descriptionText.trim().slice(0, MAX_MISSION_DESCRIPTION),
    origin: typeof origin === 'string' && origin.trim() ? origin.trim().slice(0, 100) : 'Discord',
    rewardOrbs: Number.isSafeInteger(apiOrbs) ? apiOrbs : parseRewardOrbs(item),
    startsAt: startAt,
    endsAt: endAt,
    officialUrl,
    officialStatus: typeof status === 'string' ? status.trim().toLowerCase().slice(0, 40) : null,
    imageUrl,
  };
}

export function parseMissionFeed(body) {
  const rows = findMissionRows(body);
  const missions = [];
  const rejected = [];
  const seenIds = new Set();
  for (const [index, row] of rows.entries()) {
    try {
      const mission = normalizeMission(row);
      if (seenIds.has(mission.sourceId)) throw new Error('A fonte repetiu o identificador de uma missão.');
      seenIds.add(mission.sourceId);
      missions.push(mission);
    } catch (error) {
      rejected.push({ index, reason: error.message });
    }
  }
  const rawMetrics = body && !Array.isArray(body)
    ? firstDefined(body.statistics, body.stats, body.estatisticas)
    : null;
  const totalOrbsObtained = rawMetrics && Number.isSafeInteger(rawMetrics.total_orbs_obtained)
    && rawMetrics.total_orbs_obtained >= 0
    ? rawMetrics.total_orbs_obtained
    : null;
  return { missions, rejected, totalOrbsObtained };
}

function remainingTime(endAt, now = Date.now()) {
  const milliseconds = Date.parse(endAt) - now;
  if (milliseconds <= 0) return 'expirada';
  const minutes = Math.ceil(milliseconds / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  if (days) return `${days}d ${hours}h restantes`;
  if (hours) return `${hours}h ${remainingMinutes}min restantes`;
  return `${remainingMinutes}min restantes`;
}

function statusForMission(mission, settings, now = Date.now()) {
  if (Date.parse(mission.endsAt) <= now
    || ['expired', 'ended', 'completed'].includes(mission.officialStatus)) return 'expired';
  if (Date.parse(mission.endsAt) <= now + settings.expiryWarningMinutes * 60_000) return 'expiring';
  return 'available';
}

function missionEmbed(mission, status, settings, now = Date.now(), marker = '') {
  const statusLabel = {
    available: 'Vigente na fonte',
    expiring: 'Prazo próximo',
    expired: 'Expirada conforme a data da fonte',
  }[status];
  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
      .setTitle('☁️ RedCloud • Quest')
      .setDescription(`**${mission.title}**\n${mission.description || 'A fonte não forneceu uma descrição.'}`)
    .addFields(
      { name: 'Origem', value: mission.origin, inline: true },
      { name: 'Status', value: statusLabel, inline: true },
      { name: 'Tempo restante', value: remainingTime(mission.endsAt, now), inline: true },
      { name: 'Início', value: mission.startsAt ? `<t:${Math.floor(Date.parse(mission.startsAt) / 1000)}:F>` : 'Não informado pela fonte', inline: true },
      { name: 'Término', value: `<t:${Math.floor(Date.parse(mission.endsAt) / 1000)}:F>`, inline: true },
      { name: 'Recompensa', value: mission.rewardOrbs === null ? 'Orbs não informados pela fonte' : `${mission.rewardOrbs} Orbs`, inline: true },
    )
    .setFooter({ text: marker ? `zond-mission-event:${marker}` : `Missão ${mission.sourceId} • Fonte pública configurada` });
  if (mission.officialUrl) embed.setURL(mission.officialUrl);
  if (mission.imageUrl) embed.setImage(mission.imageUrl);
  return embed;
}

function missionSnapshot(mission, status, settings, now = Date.now()) {
  return JSON.stringify({
    sourceId: mission.sourceId,
    title: mission.title,
    description: mission.description,
    origin: mission.origin,
    rewardOrbs: mission.rewardOrbs,
    startsAt: mission.startsAt,
    endsAt: mission.endsAt,
    officialUrl: mission.officialUrl,
    imageUrl: mission.imageUrl,
    status,
  });
}

function isOfficiallyExpired(officialStatus) {
  return ['expired', 'ended', 'completed'].includes(officialStatus);
}

function getTextChannel(guild, channelId, operation) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`Canal ${channelId} ausente ou não é um canal de texto (${operation}).`);
  }
  const me = guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ])) {
    throw new Error(`O bot não tem permissões para ${operation} no canal ${channelId}.`);
  }
  return channel;
}

async function findEventMessage(channel, marker) {
  const messages = await channel.messages.fetch({ limit: 100 });
  return messages.find((message) => message.embeds.some((embed) => embed.footer?.text === `zond-mission-event:${marker}`));
}

async function publishEvent(guild, settings, { eventKey, sourceId, eventType, channelId, embed }) {
  const existing = db.prepare(`
    SELECT status, message_id FROM mission_service_events
    WHERE guild_id = ? AND event_key = ?
  `).get(guild.id, eventKey);
  if (existing?.status === 'published') return existing.message_id;
  db.prepare(`
    INSERT INTO mission_service_events
      (guild_id, event_key, source_id, event_type, status, target_channel_id, embed_json, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(guild_id, event_key) DO UPDATE SET
      target_channel_id = CASE WHEN mission_service_events.status = 'pending' THEN excluded.target_channel_id ELSE mission_service_events.target_channel_id END,
      embed_json = CASE WHEN mission_service_events.status = 'pending' THEN excluded.embed_json ELSE mission_service_events.embed_json END
  `).run(guild.id, eventKey, sourceId, eventType, channelId, JSON.stringify(embed.toJSON()), new Date().toISOString());

  const channel = getTextChannel(guild, channelId, `publicar ${eventType}`);
  let message = existing?.message_id ? await channel.messages.fetch(existing.message_id).catch(() => null) : null;
  if (!message) message = await findEventMessage(channel, eventKey);
  if (!message) message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  db.prepare(`
    UPDATE mission_service_events SET status = 'published', message_id = ?
    WHERE guild_id = ? AND event_key = ?
  `).run(message.id, guild.id, eventKey);
  return message.id;
}

async function retryPendingMissionEvents(guild) {
  const pending = db.prepare(`
    SELECT event_key, source_id, event_type, target_channel_id, embed_json
    FROM mission_service_events WHERE guild_id = ? AND status = 'pending'
    ORDER BY created_at ASC LIMIT 100
  `).all(guild.id);
  for (const event of pending) {
    try {
      if (!event.target_channel_id || !event.embed_json) {
        throw new Error(`Evento pendente ${event.event_key} não possui dados suficientes para recuperação.`);
      }
      await publishEvent(guild, getMissionSettings(guild.id), {
        eventKey: event.event_key,
        sourceId: event.source_id,
        eventType: event.event_type,
        channelId: event.target_channel_id,
        embed: EmbedBuilder.from(JSON.parse(event.embed_json)),
      });
    } catch (error) {
      recordError({ service: 'missions', step: `retentativa de publicação ${event.event_type}`, error });
    }
  }
  return pending.length;
}

function storeSyncState(guildId, values) {
  const current = db.prepare('SELECT * FROM mission_service_state WHERE guild_id = ?').get(guildId) || {};
  db.prepare(`
    INSERT INTO mission_service_state
      (guild_id, last_started_at, last_synced_at, last_error, total_orbs_obtained, active_members_updated_at,
       stats_fingerprint, stats_news_at, last_result, last_checked_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      last_started_at = excluded.last_started_at,
      last_synced_at = excluded.last_synced_at,
      last_error = excluded.last_error,
      total_orbs_obtained = excluded.total_orbs_obtained,
      active_members_updated_at = excluded.active_members_updated_at,
      stats_fingerprint = excluded.stats_fingerprint,
      stats_news_at = excluded.stats_news_at,
      last_result = excluded.last_result,
      last_checked_count = excluded.last_checked_count
  `).run(
    guildId,
    values.lastStartedAt === undefined ? current.last_started_at ?? null : values.lastStartedAt,
    values.lastSyncedAt === undefined ? current.last_synced_at ?? null : values.lastSyncedAt,
    values.lastError === undefined ? current.last_error ?? null : values.lastError,
    values.totalOrbsObtained === undefined ? current.total_orbs_obtained ?? null : values.totalOrbsObtained,
    values.activeMembersUpdatedAt === undefined ? current.active_members_updated_at ?? null : values.activeMembersUpdatedAt,
    values.statsFingerprint === undefined ? current.stats_fingerprint ?? null : values.statsFingerprint,
    values.statsNewsAt === undefined ? current.stats_news_at ?? null : values.statsNewsAt,
    values.lastResult === undefined ? current.last_result ?? null : values.lastResult,
    values.lastCheckedCount === undefined ? current.last_checked_count ?? null : values.lastCheckedCount,
  );
}

function storeMissionBaseline(guildId, mission, settings, now) {
  const snapshot = `baseline:${missionSnapshot(mission, statusForMission(mission, settings))}`;
  db.prepare(`
    INSERT INTO external_missions
      (guild_id, source_id, title, description, origin, reward_orbs, starts_at, ends_at,
       official_url, official_status, status, available_payload, image_url, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, source_id) DO NOTHING
  `).run(
    guildId, mission.sourceId, mission.title, mission.description, mission.origin,
    mission.rewardOrbs, mission.startsAt, mission.endsAt, mission.officialUrl,
    mission.officialStatus, statusForMission(mission, settings), snapshot,
    mission.imageUrl, now, now,
  );
}

async function sendMissionNews(guild, settings, mission, eventType, eventVersion = '') {
  const marker = `${mission.sourceId}:${eventType}${eventVersion ? `:${eventVersion}` : ''}`;
  return publishEvent(guild, settings, {
    eventKey: `news:${marker}`,
    sourceId: mission.sourceId,
    eventType: `news-${eventType}`,
    channelId: settings.newspaperChannelId,
    embed: missionEmbed(mission, statusForMission(mission, settings), settings, Date.now(), marker),
  });
}

async function publishOrUpdateAvailable(guild, settings, mission, status) {
  const row = db.prepare(`
    SELECT * FROM external_missions WHERE guild_id = ? AND source_id = ?
  `).get(guild.id, mission.sourceId);
  const snapshot = missionSnapshot(mission, status, settings);
  if (row?.available_payload === `baseline:${snapshot}` && !row.available_message_id) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO external_missions
      (guild_id, source_id, title, description, origin, reward_orbs, starts_at, ends_at,
       official_url, official_status, status, image_url, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, source_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      origin = excluded.origin,
      reward_orbs = excluded.reward_orbs,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      official_url = excluded.official_url,
      official_status = excluded.official_status,
      status = excluded.status,
      image_url = excluded.image_url,
      updated_at = excluded.updated_at
  `).run(
    guild.id,
    mission.sourceId,
    mission.title,
    mission.description,
    mission.origin,
    mission.rewardOrbs,
    mission.startsAt,
    mission.endsAt,
    mission.officialUrl,
    mission.officialStatus,
    status,
    mission.imageUrl,
    row?.first_seen_at || now,
    now,
  );

  const channel = getTextChannel(guild, settings.availableChannelId, 'publicar missões');
  const embed = missionEmbed(mission, status, settings);
  let message = row?.available_message_id
    ? await channel.messages.fetch(row.available_message_id).catch(() => null)
    : null;
  if (!message) {
    const marker = `available:${mission.sourceId}`;
    message = await findEventMessage(channel, marker);
    if (message) {
      db.prepare('UPDATE external_missions SET available_message_id = ? WHERE guild_id = ? AND source_id = ?')
        .run(message.id, guild.id, mission.sourceId);
    } else {
      message = await channel.send({ embeds: [missionEmbed(mission, status, settings, Date.now(), marker)] });
      db.prepare('UPDATE external_missions SET available_message_id = ? WHERE guild_id = ? AND source_id = ?')
        .run(message.id, guild.id, mission.sourceId);
    }
  } else if (row?.available_payload !== snapshot) {
    await message.edit({ embeds: [embed], allowedMentions: { parse: [] } });
  }
  db.prepare('UPDATE external_missions SET available_payload = ? WHERE guild_id = ? AND source_id = ?')
    .run(snapshot, guild.id, mission.sourceId);

  const isNew = !row;
  const changed = row && [
    row.title !== mission.title,
    row.description !== mission.description,
    row.origin !== mission.origin,
    row.reward_orbs !== mission.rewardOrbs,
    row.starts_at !== mission.startsAt,
    row.ends_at !== mission.endsAt,
    row.official_url !== mission.officialUrl,
    row.image_url !== mission.imageUrl,
  ].some(Boolean);
  const enteredExpiryWindow = row?.status === 'available' && status === 'expiring';
  const eventVersion = crypto.createHash('sha256').update(snapshot).digest('hex').slice(0, 12);
  if (isNew) {
    await sendMissionNews(guild, settings, mission, 'nova');
  } else if (changed) {
    await sendMissionNews(guild, settings, mission, 'alterada', eventVersion);
  } else if (enteredExpiryWindow && settings.expiryWarnings) {
    await sendMissionNews(guild, settings, mission, 'expirando');
  }
}

export async function synchronizeMissions(guild, { manual = false, missionFeedOptions } = {}) {
  if (!guild) throw new Error('Não foi possível acessar o servidor para sincronizar missões.');
  const settings = getMissionSettings(guild.id);
  if (!manual && !settings.automatic) return { skipped: true, reason: 'Publicação automática desativada.' };
  const startedAt = new Date().toISOString();
  storeSyncState(guild.id, { lastStartedAt: startedAt, lastError: null });
  try {
    const usingDiscordQuestApi = !settings.feedUrl;
    const sourceUrl = settings.feedUrl || DISCORD_QUESTS_API_URL;
    const { body } = await fetchPublicMissionFeed(sourceUrl, missionFeedOptions);
    const parsed = parseMissionFeed(body);
    const now = new Date();
    const missions = usingDiscordQuestApi
      ? parsed.missions.filter((mission) => Date.parse(mission.endsAt) > now.getTime())
      : parsed.missions;
    const { rejected, totalOrbsObtained } = parsed;
    if (rejected.length) {
      recordError({
        service: 'missions',
        step: 'validação da fonte',
        error: new Error(`${rejected.length} registros da fonte foram rejeitados por dados inválidos.`),
      });
    }
    const completedAt = now.toISOString();
    const baselineKey = 'discordquest_api_baseline_v1';
    if (usingDiscordQuestApi && getSetting(guild.id, baselineKey, false) !== true) {
      for (const mission of missions) storeMissionBaseline(guild.id, mission, settings, completedAt);
      setSetting(guild.id, baselineKey, true);
      storeSyncState(guild.id, {
        lastSyncedAt: completedAt,
        lastError: rejected.length ? `${rejected.length} registros da fonte foram rejeitados por dados inválidos.` : null,
        totalOrbsObtained,
        lastResult: 'baseline',
        lastCheckedCount: missions.length,
      });
      return { checked: missions.length, rejected: rejected.length, published: 0, updated: 0, expired: 0, baseline: true, syncedAt: completedAt };
    }
    let published = 0;
    let updated = 0;
    for (const mission of missions) {
      const previous = db.prepare(`
        SELECT title, description, origin, reward_orbs, starts_at, ends_at, official_url, image_url
        FROM external_missions WHERE guild_id = ? AND source_id = ?
      `).get(guild.id, mission.sourceId);
      const state = statusForMission(mission, settings);
      await publishOrUpdateAvailable(guild, settings, mission, state);
      if (!previous) published += 1;
      else if ([
        previous.title !== mission.title,
        previous.description !== mission.description,
        previous.origin !== mission.origin,
        previous.reward_orbs !== mission.rewardOrbs,
        previous.starts_at !== mission.startsAt,
        previous.ends_at !== mission.endsAt,
        previous.official_url !== mission.officialUrl,
      ].some(Boolean)) updated += 1;
    }
    const result = published ? 'new_quests' : updated ? 'updated_quests' : 'no_changes';
    storeSyncState(guild.id, {
      lastSyncedAt: completedAt,
      lastError: rejected.length ? `${rejected.length} registros da fonte foram rejeitados por dados inválidos.` : null,
      totalOrbsObtained,
      lastResult: result,
      lastCheckedCount: missions.length,
    });
    return { checked: missions.length, rejected: rejected.length, published, updated, expired: 0, result, syncedAt: completedAt };
  } catch (error) {
    storeSyncState(guild.id, { lastError: error.message, lastResult: 'failed' });
    recordError({ service: 'missions', step: 'sincronização', error });
    throw error;
  }
}

async function publishExpiredMission(guild, settings, mission) {
  const row = db.prepare(`
    SELECT * FROM external_missions WHERE guild_id = ? AND source_id = ?
  `).get(guild.id, mission.sourceId);
  if (!row) return;
  if (!row.available_message_id && !row.expired_message_id) {
    db.prepare(`
      UPDATE external_missions SET original_expiry_handled = 1, status = 'expired',
        expired_at = COALESCE(expired_at, ?)
      WHERE guild_id = ? AND source_id = ?
    `).run(new Date().toISOString(), guild.id, mission.sourceId);
    return;
  }
  if (!row.original_expiry_handled) {
    if (row.available_message_id && !settings.removeExpiredPosts) {
      const channel = getTextChannel(guild, settings.availableChannelId, 'atualizar missão expirada');
      const message = await channel.messages.fetch(row.available_message_id).catch(() => null);
      if (message) {
        await message.edit({
          embeds: [missionEmbed(mission, 'expired', settings)],
          allowedMentions: { parse: [] },
        });
      } else {
        recordError({
          service: 'missions',
          step: 'mensagem original de expiração',
          error: new Error(`A mensagem da missão ${mission.sourceId} não foi encontrada para atualizar.`),
        });
      }
    } else if (row.available_message_id && settings.removeExpiredPosts) {
      const channel = getTextChannel(guild, settings.availableChannelId, 'remover missão expirada');
      const message = await channel.messages.fetch(row.available_message_id).catch(() => null);
      if (message) await message.delete();
    }
    db.prepare(`
      UPDATE external_missions SET original_expiry_handled = 1
      WHERE guild_id = ? AND source_id = ?
    `).run(guild.id, mission.sourceId);
  }
  const marker = `expired:${mission.sourceId}`;
  const expiredMessageId = await publishEvent(guild, settings, {
    eventKey: marker,
    sourceId: mission.sourceId,
    eventType: 'expired',
    channelId: settings.unavailableChannelId,
    embed: missionEmbed(mission, 'expired', settings, Date.now(), marker),
  });
  db.prepare(`
    UPDATE external_missions SET expired_message_id = ?, status = 'expired', expired_at = COALESCE(expired_at, ?)
    WHERE guild_id = ? AND source_id = ?
  `).run(expiredMessageId, new Date().toISOString(), guild.id, mission.sourceId);
  await sendMissionNews(guild, settings, mission, 'expirada');
}

function toMission(row) {
  return {
    sourceId: row.source_id,
    title: row.title,
    description: row.description,
    origin: row.origin,
    rewardOrbs: row.reward_orbs,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    officialUrl: row.official_url,
    officialStatus: row.official_status,
    imageUrl: row.image_url,
  };
}

export async function processExpiredMissions(guild) {
  const settings = getMissionSettings(guild.id);
  await retryPendingMissionEvents(guild);
  const due = db.prepare(`
    SELECT * FROM external_missions
    WHERE guild_id = ? AND status != 'expired' AND ends_at <= ?
    ORDER BY ends_at ASC
  `).all(guild.id, new Date().toISOString());
  for (const row of due) {
    db.prepare(`
      UPDATE external_missions SET status = 'expired', expired_at = COALESCE(expired_at, ?)
      WHERE guild_id = ? AND source_id = ?
    `).run(new Date().toISOString(), guild.id, row.source_id);
    await publishExpiredMission(guild, settings, toMission(row));
  }
  const retryExpired = db.prepare(`
    SELECT * FROM external_missions
    WHERE guild_id = ? AND status = 'expired'
      AND (original_expiry_handled = 0 OR (expired_message_id IS NULL AND available_message_id IS NOT NULL))
    ORDER BY ends_at ASC
  `).all(guild.id);
  for (const row of retryExpired) await publishExpiredMission(guild, settings, toMission(row));
  return due.length + retryExpired.length;
}

export function recordMissionActivity(guildId, userId, at = new Date()) {
  if (!guildId || !userId) return;
  const timestamp = at.toISOString();
  const writeThreshold = new Date(at.getTime() - 60_000).toISOString();
  db.prepare(`
    INSERT INTO mission_activity (guild_id, user_id, last_active_at)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET last_active_at = excluded.last_active_at
    WHERE mission_activity.last_active_at <= ?
  `).run(guildId, userId, timestamp, writeThreshold);
}

function countActiveMembers(guildId, days) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db.prepare(`
    SELECT COUNT(*) AS count FROM mission_activity
    WHERE guild_id = ? AND last_active_at >= ?
  `).get(guildId, since).count;
}

function countMissionsThisMonth(guildId) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return db.prepare(`
    SELECT COUNT(*) AS count FROM external_missions
    WHERE guild_id = ? AND starts_at >= ? AND starts_at < ?
  `).get(guildId, start, end).count;
}

async function updateVoiceCounter(guild, channelId, expectedName, operation) {
  if (!channelId) return false;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`O canal de voz configurado para ${operation} não existe ou não é um canal de voz.`);
  }
  if (channel.name !== expectedName) await channel.setName(expectedName, `Atualização de estatística verificada: ${operation}`);
  return true;
}

export async function updateMissionStatistics(guild) {
  const settings = getMissionSettings(guild.id);
  const active = countActiveMembers(guild.id, settings.activeDays);
  const monthly = countMissionsThisMonth(guild.id);
  if (settings.activeVoiceChannelId) {
    await updateVoiceCounter(guild, settings.activeVoiceChannelId, `Ativos (${settings.activeDays}d): ${active}`, 'usuários ativos recentes');
  }
  if (settings.monthlyMissionsVoiceChannelId) {
    await updateVoiceCounter(guild, settings.monthlyMissionsVoiceChannelId, `Missões verificadas/mês: ${monthly}`, 'missões verificadas do mês');
  }
  const state = db.prepare('SELECT * FROM mission_service_state WHERE guild_id = ?').get(guild.id);
  if (settings.totalOrbsVoiceChannelId && state?.total_orbs_obtained !== null && state?.total_orbs_obtained !== undefined) {
    await updateVoiceCounter(guild, settings.totalOrbsVoiceChannelId, `Orbs obtidos: ${state.total_orbs_obtained}`, 'total de Orbs informado pela fonte');
  }
  const orbTotal = state?.total_orbs_obtained ?? null;
  const statistics = {
    activeUsers: active,
    activeDays: settings.activeDays,
    verifiedMissionsThisMonth: monthly,
    totalOrbsObtained: orbTotal,
  };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(statistics)).digest('hex').slice(0, 16);
  const lastNewsAt = state?.stats_news_at ? Date.parse(state.stats_news_at) : 0;
  if (fingerprint !== state?.stats_fingerprint && Date.now() - lastNewsAt >= 3_600_000) {
    const marker = `statistics:${fingerprint}`;
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle(`${config.emojiFallbacks.highlight} Estatísticas verificadas do serviço de missões`)
      .setDescription([
        `Usuários ativos por mensagens nos últimos ${settings.activeDays} dias: **${active}**`,
        `Missões oficiais observadas, com início neste mês: **${monthly}**`,
        `Total de Orbs obtidos: **${orbTotal === null ? 'não informado pela fonte' : orbTotal}**`,
      ].join('\n'))
      .setFooter({ text: `zond-mission-event:${marker}` })
      .setTimestamp();
    await publishEvent(guild, settings, {
      eventKey: marker,
      sourceId: 'statistics',
      eventType: 'statistics',
      channelId: settings.newspaperChannelId,
      embed,
    });
    storeSyncState(guild.id, { statsFingerprint: fingerprint, statsNewsAt: new Date().toISOString() });
  }
  storeSyncState(guild.id, { activeMembersUpdatedAt: new Date().toISOString() });
  return {
    ...statistics,
  };
}

export function missionServiceStatus(guildId) {
  const settings = getMissionSettings(guildId);
  const state = db.prepare('SELECT * FROM mission_service_state WHERE guild_id = ?').get(guildId) || {};
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM external_missions
    WHERE guild_id = ? GROUP BY status
  `).all(guildId);
  return {
    settings,
    lastStartedAt: state.last_started_at ?? null,
    lastSyncedAt: state.last_synced_at ?? null,
    lastError: state.last_error ?? null,
    lastResult: state.last_result ?? null,
    lastCheckedCount: state.last_checked_count ?? null,
    totalOrbsObtained: state.total_orbs_obtained ?? null,
    recentErrors: recentErrors(20)
      .filter((entry) => entry.service === 'missions' || entry.service === 'huehue-missoes')
      .slice(0, 5)
      .map((entry) => ({
        createdAt: entry.created_at,
        step: String(entry.step || 'serviço').slice(0, 100),
        message: String(entry.message || '').slice(0, 240),
      })),
    missionCounts: Object.fromEntries(counts.map((row) => [row.status, row.count])),
  };
}

export function buildMissionServiceEmbed(guildId) {
  const status = missionServiceStatus(guildId);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${config.emojiFallbacks.mission} Estado do monitor de missões`)
    .setDescription([
      `Publicação automática: **${status.settings.automatic ? 'ativada' : 'desativada'}**`,
      `Fonte: ${status.settings.feedUrl ? new URL(status.settings.feedUrl).hostname : 'api.discordquest.com'}`,
      `Última consulta: ${status.lastStartedAt ? `<t:${Math.floor(Date.parse(status.lastStartedAt) / 1000)}:R>` : 'nunca'}`,
      `Resultado: ${status.lastResult || 'ainda não consultado'}${status.lastCheckedCount === null ? '' : ` • ${status.lastCheckedCount} Quest(s) vigente(s) processada(s)`}`,
      `Última tentativa: ${status.lastStartedAt ? `<t:${Math.floor(Date.parse(status.lastStartedAt) / 1000)}:R>` : 'nunca'}`,
      `Missões observadas — disponíveis: ${status.missionCounts.available ?? 0}, expirando: ${status.missionCounts.expiring ?? 0}, expiradas: ${status.missionCounts.expired ?? 0}`,
      `Orbs obtidos: ${status.totalOrbsObtained === null ? 'não informado por fonte confiável' : status.totalOrbsObtained}`,
      `Falha recente: ${status.lastError || 'nenhuma'}`,
      ...(status.recentErrors.length
        ? [`Erros recentes:\n${status.recentErrors.map((entry) => `• ${entry.step}: ${entry.message}`).join('\n')}`]
        : []),
    ].join('\n'))
    .addFields(
      { name: 'Canal disponíveis', value: `<#${status.settings.availableChannelId}>`, inline: true },
      { name: 'Canal expiradas', value: `<#${status.settings.unavailableChannelId}>`, inline: true },
      { name: 'Intervalo', value: `${status.settings.intervalSeconds}s`, inline: true },
      { name: 'Usuários ativos', value: `Mensagens nos últimos ${status.settings.activeDays} dias`, inline: true },
      { name: 'Missões mensais', value: 'Missões verificadas pela fonte e observadas neste mês', inline: true },
      { name: 'Orbs', value: 'Não serão inferidos a partir de recompensas individuais.', inline: true },
    );
}

function canConfigureMissions(member) {
  return member?.permissions?.has(PermissionFlagsBits.Administrator)
    || member?.permissions?.has(PermissionFlagsBits.ManageGuild);
}

function validateConfiguredChannel(channel, guild, expectedType) {
  if (!channel || channel.guildId !== guild.id || channel.type !== expectedType) {
    throw new Error('Selecione um canal do tipo correto pertencente a este servidor.');
  }
  const me = guild.members.me;
  const required = expectedType === ChannelType.GuildVoice
    ? [PermissionFlagsBits.ManageChannels]
    : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
  if (!me || !channel.permissionsFor(me)?.has(required)) {
    throw new Error('O bot não possui as permissões necessárias no canal selecionado.');
  }
}

export async function handleMissionSlash(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'estado') {
    await interaction.reply({ embeds: [buildMissionServiceEmbed(interaction.guildId)], ephemeral: true });
    return;
  }
  if (!canConfigureMissions(interaction.member)) {
    throw new Error('Você precisa da permissão Gerenciar servidor para configurar ou sincronizar missões.');
  }
  if (subcommand === 'sincronizar') {
    await interaction.deferReply({ ephemeral: true });
    const result = await synchronizeMissions(interaction.guild, { manual: true });
    await processExpiredMissions(interaction.guild);
    await interaction.editReply({
      content: result.skipped
        ? result.reason
        : `Sincronização concluída: ${result.checked} registros válidos, ${result.rejected} rejeitados, ${result.published} novos, ${result.updated} alterados e ${result.expired} já expirados.`,
    });
    return;
  }
  if (subcommand === 'configurar') {
    const update = {};
    const feedUrl = interaction.options.getString('fonte_url');
    if (feedUrl !== null) update.feedUrl = feedUrl.trim() ? await validateMissionFeedUrl(feedUrl.trim()) : null;
    const automatic = interaction.options.getBoolean('automatico');
    const available = interaction.options.getChannel('disponiveis');
    const unavailable = interaction.options.getChannel('expiradas');
    const interval = interaction.options.getInteger('intervalo');
    const warnings = interaction.options.getBoolean('avisos_expiracao');
    const activeVoice = interaction.options.getChannel('canal_ativos');
    const monthlyVoice = interaction.options.getChannel('canal_missoes_mes');
    const orbsVoice = interaction.options.getChannel('canal_orbs');
    if (automatic !== null) update.automatic = automatic;
    if (available) {
      validateConfiguredChannel(available, interaction.guild, ChannelType.GuildText);
      update.availableChannelId = available.id;
      setSetting(interaction.guildId, 'missions_available_channel', available.id);
    }
    if (unavailable) {
      validateConfiguredChannel(unavailable, interaction.guild, ChannelType.GuildText);
      update.unavailableChannelId = unavailable.id;
      setSetting(interaction.guildId, 'missions_unavailable_channel', unavailable.id);
    }
    if (interval !== null) update.intervalSeconds = interval;
    if (warnings !== null) update.expiryWarnings = warnings;
    for (const [channel, key] of [
      [activeVoice, 'activeVoiceChannelId'],
      [monthlyVoice, 'monthlyMissionsVoiceChannelId'],
      [orbsVoice, 'totalOrbsVoiceChannelId'],
    ]) {
      if (channel) {
        validateConfiguredChannel(channel, interaction.guild, ChannelType.GuildVoice);
        update[key] = channel.id;
      }
    }
    if (!Object.keys(update).length) throw new Error('Informe ao menos uma opção para alterar.');
    const result = updateMissionSettings(interaction.guildId, update);
    await interaction.reply({ content: `Configuração atualizada. Publicação automática: ${result.automatic ? 'ativada' : 'desativada'}; intervalo: ${result.intervalSeconds}s.`, ephemeral: true });
    return;
  }
  throw new Error('Subcomando de missões inválido.');
}

export async function handleMissionPrefix(message, args) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'estado' || subcommand === 'status') {
    await message.reply({ embeds: [buildMissionServiceEmbed(message.guildId)], allowedMentions: { parse: [] } });
    return;
  }
  if (!canConfigureMissions(message.member)) {
    throw new Error('Você precisa da permissão Gerenciar servidor para configurar ou sincronizar missões.');
  }
  if (subcommand === 'sincronizar' || subcommand === 'sync') {
    await message.reply('Sincronização manual iniciada.');
    const result = await synchronizeMissions(message.guild, { manual: true });
    await processExpiredMissions(message.guild);
    await message.channel.send(result.skipped
      ? result.reason
      : `Sincronização concluída: ${result.checked} registros válidos, ${result.rejected} rejeitados, ${result.published} novos, ${result.updated} alterados.`);
    return;
  }
  if (subcommand === 'automatico') {
    const value = rest[0]?.toLowerCase();
    if (!['on', 'off'].includes(value)) throw new Error('Uso: `!red missoes automatico on|off`.');
    updateMissionSettings(message.guildId, { automatic: value === 'on' });
    await message.reply(`Publicação automática ${value === 'on' ? 'ativada' : 'desativada'}.`);
    return;
  }
  if (subcommand === 'intervalo') {
    const intervalSeconds = Number(rest[0]);
    updateMissionSettings(message.guildId, { intervalSeconds });
    await message.reply(`Intervalo de sincronização definido para ${intervalSeconds} segundos.`);
    return;
  }
  await message.reply('Uso: `!red missoes estado`, `!red missoes sincronizar`, `!red missoes automatico on|off` ou `!red missoes intervalo <60-86400>`.');
}

async function runMissionCycle(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    recordError({ service: 'missions', step: 'servidor autorizado', error: new Error(`O servidor configurado ${guildId} não está disponível.`) });
    return;
  }
  try {
    const settings = getMissionSettings(guildId);
    if (settings.automatic && !settings.feedUrl) {
      storeSyncState(guildId, {
        lastStartedAt: new Date().toISOString(),
        lastError: 'Nenhuma fonte pública de missões foi configurada; consulta omitida.',
      });
    } else if (settings.automatic) {
      await synchronizeMissions(guild);
    }
  } catch (error) {
    recordError({ service: 'missions', step: 'agendamento da sincronização', error });
  }
  try {
    await processExpiredMissions(guild);
  } catch (error) {
    storeSyncState(guildId, { lastError: error.message });
    recordError({ service: 'missions', step: 'processamento de expiração', error });
  }
  try {
    await updateMissionStatistics(guild);
  } catch (error) {
    recordError({ service: 'missions', step: 'atualização das estatísticas', error });
  }
}

export async function startMissionService(client, guildId = config.discordGuildId) {
  if (schedulerByGuild.has(guildId)) return;
  let stopped = false;
  let timer;
  const schedule = async () => {
    if (stopped) return;
    await runMissionCycle(client, guildId);
    if (stopped) return;
    const interval = getMissionSettings(guildId).intervalSeconds;
    if (!Number.isSafeInteger(interval) || interval < 60 || interval > 86400) {
      schedulerByGuild.get(guildId)?.();
      const error = new Error('O intervalo persistido de missões está inválido; o agendamento foi interrompido.');
      recordError({ service: 'missions', step: 'intervalo do agendador', error });
      return;
    }
    const intervalMs = interval * 1000;
    timer = setTimeout(schedule, intervalMs);
    timer.unref?.();
  };
  schedulerByGuild.set(guildId, () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    schedulerByGuild.delete(guildId);
  });
  await schedule();
}

export function stopMissionService(guildId = config.discordGuildId) {
  schedulerByGuild.get(guildId)?.();
}
