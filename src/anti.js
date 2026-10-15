import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AuditLogEvent,
  PermissionFlagsBits,
} from 'discord.js';
import { getSetting, setSetting, storeSystemLog } from './db.js';
import { recordError, sanitize } from './errors.js';

export const PROTECTIONS = ['raid', 'spam', 'mention', 'webhook', 'joins', 'links'];
export const PROTECTION_LABELS = {
  raid: 'Anti-raid',
  spam: 'Anti-spam',
  mention: 'Anti-mention',
  webhook: 'Anti-webhook',
  joins: 'Anti-joins',
  links: 'Anti-links',
};

const DEFAULT_ANTI = {
  enabled: Object.fromEntries(PROTECTIONS.map((key) => [key, false])),
  blockedDomains: [],
  allowedDomains: [],
  mentionLimit: 5,
  joinWindowSeconds: 10,
  joinLimit: 8,
  spamMessageLimit: 6,
  spamWindowSeconds: 8,
  exemptRoleIds: [],
  exemptChannelIds: [],
};
const joinWindows = new Map();
const raidAlertedAt = new Map();
const messageWindows = new Map();
const spamAlertedAt = new Map();
const webhookEventsSeen = new Set();

export function getAntiConfig(guildId) {
  const stored = getSetting(guildId, 'anti', {});
  return {
    ...DEFAULT_ANTI,
    ...stored,
    enabled: { ...DEFAULT_ANTI.enabled, ...(stored.enabled || {}) },
    blockedDomains: Array.isArray(stored.blockedDomains) ? stored.blockedDomains : [],
    allowedDomains: Array.isArray(stored.allowedDomains) ? stored.allowedDomains : [],
    exemptRoleIds: Array.isArray(stored.exemptRoleIds) ? stored.exemptRoleIds : [],
    exemptChannelIds: Array.isArray(stored.exemptChannelIds) ? stored.exemptChannelIds : [],
  };
}

export function updateAntiConfig(guildId, update) {
  const current = getAntiConfig(guildId);
  const next = { ...current, ...update, enabled: { ...current.enabled, ...update.enabled } };
  setSetting(guildId, 'anti', next);
  return next;
}

function logEvent(guildId, module, eventType, details) {
  try {
    storeSystemLog({ guildId, module, eventType, details });
  } catch (error) {
    console.error('Falha ao persistir log de proteção:', sanitize(error.message));
  }
}

export async function sendGuildLog(guild, module, eventType, details) {
  logEvent(guild.id, module, eventType, details);
  const channelId = getSetting(guild.id, 'logs_channel');
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    recordError({
      service: 'logs',
      step: 'canal configurado',
      error: new Error(`O canal de logs ${channelId} não existe ou não é de texto.`),
    });
    return;
  }
  if (!guild.members.me) {
    recordError({
      service: 'logs',
      step: 'membro do bot',
      error: new Error('Não foi possível obter o membro do bot para validar as permissões do canal de logs.'),
    });
    return;
  }
  if (!channel.permissionsFor(guild.members.me)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])) {
    recordError({
      service: 'logs',
      step: 'permissões do canal',
      error: new Error(`O bot não pode enviar embeds no canal de logs ${channelId}.`),
    });
    return;
  }
  try {
    const description = Object.entries(details)
      .map(([key, value]) => `• **${key}:** ${sanitize(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 300)}`)
      .join('\n')
      .slice(0, 3500);
    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0xC8102E)
        .setTitle(`${module} • ${eventType}`)
        .setDescription(description || 'Evento registrado.')
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    recordError({ service: 'logs', step: 'envio ao canal configurado', error });
  }
}

export function buildAntiPanel(guildId) {
  const state = getAntiConfig(guildId);
  const embed = new EmbedBuilder()
    .setColor(0xC8102E)
    .setTitle('Configuração de proteção')
    .setDescription(PROTECTIONS
      .map((key) => `• **${PROTECTION_LABELS[key]}:** ${state.enabled[key] ? 'ON' : 'OFF'}`)
      .join('\n'))
    .addFields({
      name: 'Limites atuais',
      value: `• Entradas: ${state.joinLimit} em ${state.joinWindowSeconds}s\n• Mensagens: ${state.spamMessageLimit} em ${state.spamWindowSeconds}s\n• Repetições idênticas: 3\n• Menções: ${state.mentionLimit}`,
    })
    .setFooter({ text: 'As proteções iniciam desativadas; sem punições automáticas.' });
  const rows = [
    new ActionRowBuilder().addComponents(
      ...PROTECTIONS.slice(0, 3).map((key) => new ButtonBuilder()
        .setCustomId(`anti:toggle:${key}`)
        .setLabel(`${PROTECTION_LABELS[key]} ${state.enabled[key] ? 'ON' : 'OFF'}`)
        .setStyle(state.enabled[key] ? ButtonStyle.Danger : ButtonStyle.Secondary)),
    ),
    new ActionRowBuilder().addComponents(
      ...PROTECTIONS.slice(3).map((key) => new ButtonBuilder()
        .setCustomId(`anti:toggle:${key}`)
        .setLabel(`${PROTECTION_LABELS[key]} ${state.enabled[key] ? 'ON' : 'OFF'}`)
        .setStyle(state.enabled[key] ? ButtonStyle.Danger : ButtonStyle.Secondary)),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('anti:settings').setLabel('Ajustar limites').setStyle(ButtonStyle.Primary),
    ),
  ];
  return { embeds: [embed], components: rows };
}

function isPrivileged(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator)
    || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function isLinkExempt(member, channelId, anti) {
  return anti.exemptChannelIds.includes(channelId)
    || member.roles.cache.some((role) => anti.exemptRoleIds.includes(role.id));
}

function markWindow(map, key, now, windowMs) {
  const values = (map.get(key) || []).filter((at) => now - at < windowMs);
  values.push(now);
  map.set(key, values);
  if (map.size > 5000) {
    const iterator = map.keys();
    for (let index = 0; index < 1000; index += 1) map.delete(iterator.next().value);
  }
  return values.length;
}

function setBounded(map, key, value) {
  map.set(key, value);
  if (map.size > 5000) {
    const iterator = map.keys();
    for (let index = 0; index < 1000; index += 1) map.delete(iterator.next().value);
  }
}

export async function handleMemberJoin(member) {
  const anti = getAntiConfig(member.guild.id);
  const now = Date.now();
  const key = member.guild.id;
  const count = markWindow(joinWindows, key, now, anti.joinWindowSeconds * 1000);
  const details = { usuário: member.user.id, conta_criada: member.user.createdAt.toISOString() };

  if (anti.enabled.joins) {
    await sendGuildLog(member.guild, 'anti-joins', 'entrada', details);
  }
  const lastAlert = raidAlertedAt.get(key) || 0;
  if (anti.enabled.raid && count >= anti.joinLimit && now - lastAlert >= anti.joinWindowSeconds * 1000) {
    setBounded(raidAlertedAt, key, now);
    await sendGuildLog(member.guild, 'anti-raid', 'pico de entradas', {
      ...details,
      entradas_na_janela: count,
      janela_segundos: anti.joinWindowSeconds,
      ação: 'detecção e registro; nenhuma punição automática configurada',
    });
  }
}

export async function handleGuildMessage(message) {
  if (!message.guild || message.author.bot || !message.member) return;
  const anti = getAntiConfig(message.guild.id);
  if (isPrivileged(message.member)) return;

  if (anti.enabled.spam) {
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const count = markWindow(messageWindows, key, now, anti.spamWindowSeconds * 1000);
    const content = message.content.trim().slice(0, 500);
    const duplicates = messageWindows.get(`${key}:content`) || [];
    const recentDuplicates = duplicates.filter((entry) => now - entry.time < anti.spamWindowSeconds * 1000);
    recentDuplicates.push({ content, time: now });
    messageWindows.set(`${key}:content`, recentDuplicates);
    if (messageWindows.size > 5000) {
      const iterator = messageWindows.keys();
      for (let index = 0; index < 1000; index += 1) messageWindows.delete(iterator.next().value);
    }
    const repeats = recentDuplicates.filter((entry) => entry.content === content).length;
    const lastAlert = spamAlertedAt.get(key) || 0;
    if ((count >= anti.spamMessageLimit || repeats >= 3)
      && now - lastAlert >= anti.spamWindowSeconds * 1000) {
      setBounded(spamAlertedAt, key, now);
      await sendGuildLog(message.guild, 'anti-spam', 'padrão suspeito', {
        usuário: message.author.id,
        canal: message.channelId,
        mensagens_na_janela: count,
        repetições: repeats,
        janela_segundos: anti.spamWindowSeconds,
        ação: 'detecção e registro; nenhuma punição automática configurada',
      });
    }
  }

  const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
  if (anti.enabled.mention && mentionCount > anti.mentionLimit) {
    await sendGuildLog(message.guild, 'anti-mention', 'excesso de menções', {
      usuário: message.author.id,
      canal: message.channelId,
      usuários_mencionados: message.mentions.users.size,
      cargos_mencionados: message.mentions.roles.size,
      everyone: message.mentions.everyone,
      limite: anti.mentionLimit,
    });
  }

  if (anti.enabled.links && message.content && !isLinkExempt(message.member, message.channelId, anti)) {
    const urls = message.content.match(/https?:\/\/[^\s<>()]+/gi) || [];
    const blocked = urls.filter((raw) => {
      try {
        const hostname = new URL(raw).hostname.toLowerCase();
        const matches = (domains) => domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
        return matches(anti.blockedDomains) && !matches(anti.allowedDomains);
      } catch {
        return false;
      }
    });
    if (blocked.length) {
      await sendGuildLog(message.guild, 'anti-links', 'domínio bloqueado detectado', {
        usuário: message.author.id,
        canal: message.channelId,
        domínios: blocked.map((url) => new URL(url).hostname),
        ação: 'registro; mensagens não removidas automaticamente',
      });
    }
  }
}

export async function handleWebhookUpdate(guild) {
  const anti = getAntiConfig(guild.id);
  if (!anti.enabled.webhook) return;
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate, limit: 5 });
    const entry = logs.entries.find((item) => item.createdTimestamp > Date.now() - 15_000
      && item.action === AuditLogEvent.WebhookCreate && !webhookEventsSeen.has(item.id));
    if (!entry) return;
    webhookEventsSeen.add(entry.id);
    if (webhookEventsSeen.size > 1000) webhookEventsSeen.delete(webhookEventsSeen.values().next().value);
    await sendGuildLog(guild, 'anti-webhook', 'criação de webhook detectada', {
      executor: entry.executorId || 'não identificado',
      canal: entry.extra?.channel?.id || 'não identificado',
      webhook: entry.targetId || 'não identificado',
      ação: 'evento de auditoria registrado; o webhook não foi removido',
    });
  } catch (error) {
    recordError({ service: 'anti-webhook', step: 'consulta à auditoria', error });
  }
}

export function canConfigure(member) {
  return member?.permissions?.has(PermissionFlagsBits.ManageGuild) || false;
}

export function canReadModerationLogs(member) {
  return member?.permissions?.has(PermissionFlagsBits.ViewAuditLog) || false;
}
