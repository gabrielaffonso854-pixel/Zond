import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { getGuildSettings, getSetting, setSetting, storeSystemLog } from './db.js';
import { recordError } from './errors.js';

const COLOR = 0xC8102E;
const CLEAR_PREFIX = 'clear_online:';
const confirmationRequests = new Map();
const channelErrorCooldowns = new Map();
const CONFIRMATION_TTL_MS = 120_000;
const DISCORD_BULK_DELETE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function canModerate(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)
    || member?.permissions?.has(PermissionFlagsBits.ManageMessages));
}

function isTextChannel(channel, guildId) {
  return Boolean(channel && channel.guildId === guildId && channel.type === ChannelType.GuildText);
}

function requireBotPermissions(channel, guild) {
  const permissions = channel.permissionsFor(guild.members.me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
  ];
  if (!permissions?.has(required)) {
    throw new Error('O bot precisa de Ver canal, Ler histórico de mensagens e Gerenciar mensagens nesse canal.');
  }
}

function activeChannels(guildId) {
  return Object.entries(getGuildSettings(guildId))
    .filter(([key, enabled]) => key.startsWith(CLEAR_PREFIX) && enabled === true)
    .map(([key]) => key.slice(CLEAR_PREFIX.length));
}

function createConfirmation(interaction, operation, channel) {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  confirmationRequests.set(token, {
    actorId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: channel.id,
    operation,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`clear:confirm:${token}`).setLabel('Confirmar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`clear:cancel:${token}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  );
  return row;
}

function takeConfirmation(interaction, token) {
  const pending = confirmationRequests.get(token);
  if (!pending || pending.expiresAt < Date.now()) {
    confirmationRequests.delete(token);
    return null;
  }
  if (pending.actorId !== interaction.user.id || pending.guildId !== interaction.guildId) return null;
  confirmationRequests.delete(token);
  return pending;
}

async function collectChannelMessages(channel, onBatch) {
  let before;
  let total = 0;
  let errors = 0;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    const messages = [...batch.values()];
    before = messages[messages.length - 1].id;
    const result = await onBatch(messages);
    total += result.deleted;
    errors += result.errors;
    if (batch.size < 100) break;
  }
  return { deleted: total, errors };
}

async function deleteBatch(channel, messages) {
  let deleted = 0;
  let errors = 0;
  const cutoff = Date.now() - DISCORD_BULK_DELETE_AGE_MS;
  errors += messages.filter((message) => !message.deletable).length;
  const recent = messages.filter((message) => message.createdTimestamp > cutoff && message.deletable);
  const old = messages.filter((message) => message.createdTimestamp <= cutoff && message.deletable);

  if (recent.length) {
    try {
      const removed = await channel.bulkDelete(recent, true);
      deleted += removed.size;
      const removedIds = new Set(removed.keys());
      for (const message of recent.filter((candidate) => !removedIds.has(candidate.id))) {
        try {
          await message.delete();
          deleted += 1;
        } catch {
          errors += 1;
        }
      }
    } catch (error) {
      recordError({ service: 'clear', step: 'exclusão em massa; tentando exclusão individual', error });
      for (const message of recent) {
        try {
          await message.delete();
          deleted += 1;
        } catch {
          errors += 1;
        }
      }
    }
  }

  for (const message of old) {
    try {
      await message.delete();
      deleted += 1;
    } catch {
      errors += 1;
    }
  }
  return { deleted, errors };
}

async function clearChannel(channel) {
  return collectChannelMessages(channel, (messages) => deleteBatch(channel, messages));
}

function clearStatusEmbed(channelId, result) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Limpeza concluída')
    .setDescription(`Canal: <#${channelId}>\nMensagens removidas: **${result.deleted}**\nFalhas ou mensagens não removíveis: **${result.errors}**`);
}

export async function handleClearSlash(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)
    && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'Você precisa de Gerenciar mensagens ou Administrador para usar a limpeza.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'all') {
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    if (!isTextChannel(channel, interaction.guildId)) {
      await interaction.reply({ content: 'Selecione um canal de texto deste servidor.', ephemeral: true });
      return;
    }
    requireBotPermissions(channel, interaction.guild);
    const row = createConfirmation(interaction, 'all', channel);
    await interaction.reply({
      content: `Confirme a exclusão de todas as mensagens possíveis em <#${channel.id}>. Mensagens com mais de 14 dias serão removidas individualmente. Esta ação não afeta outros canais.`,
      components: [row],
      ephemeral: true,
    });
    return;
  }

  const action = interaction.options.getString('acao', true);
  const channel = interaction.options.getChannel('canal');
  if (action === 'status') {
    if (channel) {
      if (!isTextChannel(channel, interaction.guildId)) {
        await interaction.reply({ content: 'Selecione um canal de texto deste servidor.', ephemeral: true });
        return;
      }
      const enabled = getSetting(interaction.guildId, `${CLEAR_PREFIX}${channel.id}`, false) === true;
      await interaction.reply({ content: `Limpeza automática em <#${channel.id}>: **${enabled ? 'ativada' : 'desativada'}**.`, ephemeral: true });
    } else {
      const channels = activeChannels(interaction.guildId);
      await interaction.reply({
        content: channels.length ? `Canais monitorados: ${channels.map((id) => `<#${id}>`).join(', ')}` : 'Não há canais com limpeza automática ativa.',
        ephemeral: true,
      });
    }
    return;
  }

  if (!channel || !isTextChannel(channel, interaction.guildId)) {
    await interaction.reply({ content: 'Selecione um canal de texto deste servidor para ativar ou desativar o monitoramento.', ephemeral: true });
    return;
  }
  if (action === 'ativar') {
    requireBotPermissions(channel, interaction.guild);
    const row = createConfirmation(interaction, 'online', channel);
    await interaction.reply({
      content: `Aviso: todas as novas mensagens em <#${channel.id}> serão apagadas assim que detectadas, inclusive mensagens de administradores, bots, webhooks e do próprio bot. Mensagens antigas não serão apagadas. Não use em canais com notícias ou informações importantes. Confirme para ativar.`,
      components: [row],
      ephemeral: true,
    });
    return;
  }

  setSetting(interaction.guildId, `${CLEAR_PREFIX}${channel.id}`, false);
  storeSystemLog({ guildId: interaction.guildId, module: 'clear', eventType: 'monitoramento desativado', details: { executor: interaction.user.id, channelId: channel.id } });
  await interaction.reply({ content: `Limpeza automática desativada em <#${channel.id}>.`, ephemeral: true });
}

export async function handleClearButton(interaction) {
  const [, action, token] = interaction.customId.split(':');
  const pending = takeConfirmation(interaction, token);
  if (!pending) {
    await interaction.reply({ content: 'Esta confirmação expirou ou pertence a outra pessoa.', ephemeral: true });
    return;
  }
  if (action === 'cancel') {
    await interaction.update({ content: 'Operação cancelada.', components: [] });
    return;
  }
  if (action !== 'confirm') {
    await interaction.reply({ content: 'Confirmação inválida.', ephemeral: true });
    return;
  }
  if (!canModerate(interaction.member)) {
    await interaction.update({ content: 'Você não tem mais permissão de moderação para confirmar esta ação.', components: [] });
    return;
  }

  const channel = await interaction.guild.channels.fetch(pending.channelId).catch(() => null);
  if (!isTextChannel(channel, pending.guildId)) {
    await interaction.update({ content: 'O canal não está mais disponível. Nenhuma alteração foi feita.', components: [] });
    return;
  }
  requireBotPermissions(channel, interaction.guild);

  if (pending.operation === 'online') {
    setSetting(pending.guildId, `${CLEAR_PREFIX}${channel.id}`, true);
    storeSystemLog({ guildId: pending.guildId, module: 'clear', eventType: 'monitoramento ativado', details: { executor: interaction.user.id, channelId: channel.id } });
    await interaction.update({ content: `Limpeza automática ativada em <#${channel.id}>. Somente mensagens novas serão apagadas.`, components: [] });
    return;
  }

  await interaction.update({ content: `Limpando mensagens em <#${channel.id}>…`, components: [] });
  const result = await clearChannel(channel);
  storeSystemLog({ guildId: pending.guildId, module: 'clear', eventType: 'limpeza manual', details: { executor: interaction.user.id, channelId: channel.id, ...result } });
  await interaction.followUp({ embeds: [clearStatusEmbed(channel.id, result)], ephemeral: true });
}

export async function handleOnlineClearMessage(message) {
  if (!message.guildId || !message.channelId
    || getSetting(message.guildId, `${CLEAR_PREFIX}${message.channelId}`, false) !== true) return false;
  if (!message.deletable) {
    const lastLoggedAt = channelErrorCooldowns.get(message.channelId) ?? 0;
    if (Date.now() - lastLoggedAt > 60_000) {
      channelErrorCooldowns.set(message.channelId, Date.now());
      recordError({ service: 'clear', step: `mensagem não removível no canal ${message.channelId}`, error: new Error('O bot não pode remover esta mensagem.') });
    }
    return true;
  }

  try {
    await message.delete();
  } catch (error) {
    const lastLoggedAt = channelErrorCooldowns.get(message.channelId) ?? 0;
    if (Date.now() - lastLoggedAt > 60_000) {
      channelErrorCooldowns.set(message.channelId, Date.now());
      recordError({ service: 'clear', step: `limpeza automática no canal ${message.channelId}`, error });
    }
  }
  return true;
}

export function getClearOnlineChannels(guildId) {
  return activeChannels(guildId);
}

export function hasClearModerationPermission(member) {
  return canModerate(member);
}

export function clearEmbedForTest(channelId, result) {
  return clearStatusEmbed(channelId, result);
}

export function clearChannelForTest(channel) {
  return clearChannel(channel);
}
