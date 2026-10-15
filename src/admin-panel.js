import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from './config.js';
import { getSetting, recentErrors, recentSystemLogs, setSetting, storeSystemLog } from './db.js';
import { recordError, sanitize } from './errors.js';
import { getAntiConfig, PROTECTIONS, PROTECTION_LABELS, updateAntiConfig } from './anti.js';
import { getMissionSettings, updateMissionSettings } from './missions.js';
import { validateMissionFeedUrl } from './mission-feed.js';
import { getNewsSettings, runNewsCheck, startNewsService, stopNewsService } from './news.js';
import { askNvidia, getAiStatus, rotateNvidiaApiKey } from './ai.js';

const PANEL_MARKER = 'redcloud-central-control';
const PANEL_MESSAGE_KEY = 'redcloud_admin_panel_message';
const CUSTOM_POSTS_KEY = 'redcloud_custom_posts';
const pendingAnnouncements = new Map();
const PAGE_OPTIONS = [
  ['overview', 'Visão geral'], ['moderation', 'Moderação'], ['quest', 'Quest'],
  ['news', 'News'], ['catalog', 'Catálogo'], ['messages', 'Anúncios'],
  ['channels', 'Canais'], ['logs', 'Logs'], ['ai', 'IA'], ['system', 'Sistema'],
];

export function isCentralAdmin(userId, member) {
  if (!userId || !member) return false;
  if (userId === config.ownerId) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)
    || member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleIds = new Set([
    config.roles.founder,
    config.roles.direction,
    config.roles.management,
    ...(process.env.ADMIN_ROLE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
  ]);
  return member.roles?.cache?.some((role) => roleIds.has(role.id)) || false;
}

function isAuthorized(interaction) {
  return isCentralAdmin(interaction.user?.id, interaction.member);
}

function audit(interaction, action, details = {}) {
  storeSystemLog({
    guildId: interaction.guildId,
    module: 'redcloud-panel',
    eventType: action,
    details: { executor: interaction.user.id, ...details },
  });
}

function fieldStatus(value) {
  return value ? 'Ativo' : 'Inativo';
}

function missionFeedHost(value) {
  if (!value) return 'api.discordquest.com';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.hostname : 'URL inválida';
  } catch {
    return 'Nenhuma fonte pública configurada';
  }
}

function pageContent(guild, page) {
  const anti = getAntiConfig(guild.id);
  const missions = getMissionSettings(guild.id);
  const news = getNewsSettings(guild.id);
  const ai = getAiStatus();
  const enabledProtections = PROTECTIONS.filter((key) => anti.enabled[key]).length;
  const content = {
    overview: {
      description: 'Estado dos serviços configurados neste servidor.',
      fields: [
        { name: 'Bot', value: guild.members.me?.presence?.status || 'Conectado', inline: true },
        { name: 'IA', value: ai.configured ? `Configurada • ${ai.activeRequests} requisição(ões)` : 'Sem chave configurada', inline: true },
        { name: 'Monitor de missões', value: `${fieldStatus(missions.automatic)} • ${missionFeedHost(missions.feedUrl)}`, inline: true },
        { name: 'Jornal', value: `${fieldStatus(news.enabled)} • ${news.channelId ? `<#${news.channelId}>` : 'canal pendente'}`, inline: true },
        { name: 'Moderação', value: `${enabledProtections}/${PROTECTIONS.length} proteções ativas`, inline: true },
        { name: 'Catálogo', value: `Painel: <#${config.channels.sourceStorePanel}>`, inline: true },
      ],
    },
    moderation: {
      description: 'Alterne as proteções já existentes. Não há punições automáticas configuradas por este painel.',
      fields: PROTECTIONS.map((key) => ({
        name: PROTECTION_LABELS[key],
        value: anti.enabled[key] ? 'Ativo' : 'Inativo',
        inline: true,
      })),
    },
    quest: {
      description: 'Fonte padrão: API pública api.discordquest.com. Um feed JSON HTTPS próprio pode substituir essa fonte. Não há scraping nem acesso à API privada do cliente Discord.',
      fields: [
        { name: 'Monitor', value: fieldStatus(missions.automatic), inline: true },
        { name: 'Intervalo', value: `${missions.intervalSeconds} segundos`, inline: true },
        { name: 'Canal de missões', value: `<#${missions.availableChannelId}>`, inline: true },
        { name: 'Fonte', value: missionFeedHost(missions.feedUrl), inline: false },
      ],
    },
    news: {
      description: 'Configuração persistente de RSS/Atom. Fontes e teste real continuam disponíveis em `/jornal`.',
      fields: [
        { name: 'Agendamento', value: fieldStatus(news.enabled), inline: true },
        { name: 'Canal', value: news.channelId ? `<#${news.channelId}>` : 'Não configurado', inline: true },
        { name: 'Intervalo', value: `${news.intervalMinutes} minuto(s)`, inline: true },
        { name: 'Fontes', value: String(news.sources.length), inline: true },
        { name: 'Próxima consulta', value: news.nextAttemptAt ? `<t:${Math.floor(news.nextAttemptAt / 1000)}:R>` : 'Não agendada', inline: true },
      ],
    },
    catalog: {
      description: 'O catálogo Source Codes existente mantém cadastro, preço, disponibilidade, pedidos e entrega privada.',
      fields: [
        { name: 'Canal do catálogo', value: `<#${config.channels.sourceStoreCatalog}>`, inline: true },
        { name: 'Canal administrativo', value: `<#${config.channels.sourceStorePanel}>`, inline: true },
        { name: 'Operações', value: '`/loja cadastrar`, `/loja editar`, `/loja ativar` e `/loja painel`', inline: false },
      ],
    },
    messages: {
      description: 'Crie mensagens simples, embeds ou ambos. Emojis :emoji_N: são resolvidos pelos nomes e IDs reais do servidor; toda publicação exige prévia e confirmação.',
      fields: [{ name: 'Publicações controladas', value: String(getCustomPosts(guild.id).length) }],
    },
    channels: {
      description: 'Selecione os canais abaixo para atualizar configurações persistentes dos serviços.',
      fields: [
        { name: 'Painel administrativo', value: `<#${config.channels.controlPanel}>`, inline: true },
        { name: 'News', value: news.channelId ? `<#${news.channelId}>` : 'Não configurado', inline: true },
        { name: 'Quest', value: `<#${missions.availableChannelId}>`, inline: true },
        { name: 'Logs', value: getSetting(guild.id, 'logs_channel') ? `<#${getSetting(guild.id, 'logs_channel')}>` : 'Não configurado', inline: true },
      ],
    },
    logs: {
      description: recentSystemLogs(guild.id, 6).map((entry) => {
        let details = {};
        try { details = JSON.parse(entry.details); } catch { details = {}; }
        return `• **${entry.created_at}** ${entry.module}: ${entry.event_type}${details.executor ? ` (por <@${details.executor}>)` : ''}`;
      }).join('\n').slice(0, 3500) || 'Nenhuma ação registrada recentemente.',
      fields: [],
    },
    ai: {
      description: ai.configured
        ? `Provedor configurado via ${ai.source === 'admin-panel' ? 'painel' : 'ambiente'} • ${ai.activeRequests} requisição(ões) em andamento • timeout ${ai.timeoutMs / 1000}s.`
        : 'Nenhuma chave NVIDIA está configurada. Nenhum segredo é exibido neste painel.',
      fields: [
        { name: 'Modelo', value: ai.model, inline: true },
        { name: 'Rotação segura', value: ai.encryptionConfigured ? 'Criptografia pronta' : 'Configure REDCLOUD_KEY_ENCRYPTION_SECRET no ambiente', inline: true },
      ],
    },
    system: {
      description: [
        `Banco SQLite: ${config.databasePath.split('/').at(-1)} (caminho não sensível).`,
        `Erros recentes: ${recentErrors(5).length}.`,
        `Jornal: ${fieldStatus(news.enabled)}. Missões HueHue: ${fieldStatus(missions.automatic)}.`,
      ].join('\n'),
      fields: recentErrors(3).map((error) => ({
        name: `${error.service} • ${error.step}`.slice(0, 256),
        value: sanitize(error.message).slice(0, 700),
        inline: false,
      })),
    },
  };
  return content[page] || content.overview;
}

export function buildCentralPanelPayload(guild, page = 'overview') {
  const selected = PAGE_OPTIONS.some(([key]) => key === page) ? page : 'overview';
  const content = pageContent(guild, selected);
  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle('☁️ RedCloud • Central de Controle')
    .setDescription(`**${PAGE_OPTIONS.find(([key]) => key === selected)?.[1]}**\n${content.description}`)
    .setFooter({ text: PANEL_MARKER });
  if (config.redCloudIconUrl) {
    try {
      if (new URL(config.redCloudIconUrl).protocol === 'https:') embed.setThumbnail(config.redCloudIconUrl);
    } catch {
      recordError({ service: 'redcloud-panel', step: 'ícone configurado', error: new Error('REDCLOUD_ICON_URL não é uma URL HTTPS válida.') });
    }
  }
  if (content.fields.length) embed.addFields(content.fields);

  const rows = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('central:page')
      .setPlaceholder('Abrir seção')
      .addOptions(PAGE_OPTIONS.map(([value, label]) => ({ label, value, default: value === selected }))),
  )];
  if (selected === 'moderation') {
    for (let offset = 0; offset < PROTECTIONS.length; offset += 5) {
      rows.push(new ActionRowBuilder().addComponents(PROTECTIONS.slice(offset, offset + 5).map((key) => (
        new ButtonBuilder().setCustomId(`central:anti:${key}`)
          .setLabel(`${PROTECTION_LABELS[key]} ${getAntiConfig(guild.id).enabled[key] ? 'ON' : 'OFF'}`)
          .setStyle(getAntiConfig(guild.id).enabled[key] ? ButtonStyle.Danger : ButtonStyle.Secondary)
      ))));
    }
  } else if (selected === 'quest') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('central:quest:toggle').setLabel('Ativar / desativar').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('central:quest:source').setLabel('Fonte alternativa').setStyle(ButtonStyle.Primary),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('central:channel:quest').setPlaceholder('Selecionar canal de missões')
        .setChannelTypes(ChannelType.GuildText),
    ));
  } else if (selected === 'news') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('central:news:toggle').setLabel('Ativar / desativar').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('central:news:interval').setLabel('Definir intervalo').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('central:news:test').setLabel('Publicar teste').setStyle(ButtonStyle.Secondary),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('central:channel:news').setPlaceholder('Selecionar canal de notícias')
        .setChannelTypes(ChannelType.GuildText),
    ));
  } else if (selected === 'channels') {
    rows.push(...[
      ['central:channel:news', 'Canal do jornal'],
      ['central:channel:quest', 'Canal de missões'],
      ['central:channel:logs', 'Canal de logs'],
    ].map(([customId, placeholder]) => new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder)
        .setChannelTypes(ChannelType.GuildText),
    )));
  } else if (selected === 'catalog') {
    const messageId = getSetting(guild.id, 'store_admin_panel_message');
    if (messageId) {
      const url = `https://discord.com/channels/${guild.id}/${config.channels.sourceStorePanel}/${messageId}`;
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir painel do catálogo').setURL(url),
      ));
    }
  } else if (selected === 'messages') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('central:post:create-embed').setLabel('Criar embed').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('central:post:create-text').setLabel('Mensagem simples').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('central:post:create-both').setLabel('Mensagem + embed').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('central:post:list').setLabel('Gerenciar publicações').setStyle(ButtonStyle.Secondary),
    ));
  } else if (selected === 'ai') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('central:ai:key').setLabel('Atualizar chave NVIDIA').setStyle(ButtonStyle.Secondary)
        .setDisabled(!getAiStatus().encryptionConfigured),
      new ButtonBuilder().setCustomId('central:ai:diagnose').setLabel('Executar diagnóstico').setStyle(ButtonStyle.Primary)
        .setDisabled(!getAiStatus().configured),
    ));
  }
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

async function notifyOwner(client, message) {
  try {
    const owner = await client.users.fetch(config.ownerId);
    await owner.send(message);
  } catch (error) {
    recordError({ service: 'redcloud-panel', step: 'notificar proprietário', error });
  }
}

export async function ensureCentralPanel(client, guildId = config.discordGuildId) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(config.channels.controlPanel).catch(() => null);
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
  if (!channel || channel.type !== ChannelType.GuildText
    || !channel.permissionsFor(guild.members.me)?.has(required)) {
    const error = new Error(`Canal central ${config.channels.controlPanel} indisponível ou sem permissões necessárias.`);
    recordError({ service: 'redcloud-panel', step: 'inicialização do painel central', error });
    await notifyOwner(client, `Não consegui localizar ou atualizar o painel RedCloud no canal configurado ${config.channels.controlPanel}. Verifique o canal e as permissões do bot.`);
    return null;
  }
  const messageId = getSetting(guild.id, PANEL_MESSAGE_KEY);
  let panelMessage = messageId ? await channel.messages.fetch(messageId).catch(() => null) : null;
  if (!panelMessage) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    panelMessage = recent?.find((message) => message.author.id === client.user.id
      && message.embeds.some((embed) => embed.footer?.text === PANEL_MARKER)) || null;
  }
  const payload = buildCentralPanelPayload(guild);
  if (panelMessage) await panelMessage.edit(payload);
  else panelMessage = await channel.send(payload);
  setSetting(guild.id, PANEL_MESSAGE_KEY, panelMessage.id);
  setSetting(guild.id, 'redcloud_admin_panel_channel', channel.id);
  return panelMessage;
}

export async function showCentralPanel(interaction) {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'A central de controle é restrita ao proprietário e administradores autorizados.', ephemeral: true });
    return;
  }
  const panel = await ensureCentralPanel(interaction.client, interaction.guildId);
  await interaction.reply({
    content: panel ? `Painel central atualizado: <#${config.channels.controlPanel}>.` : 'Não foi possível atualizar o painel. O erro foi registrado e o proprietário será notificado.',
    ephemeral: true,
  });
}

export function handlesCentralInteraction(interaction) {
  return Boolean(interaction.customId?.startsWith('central:'));
}

function getCustomPosts(guildId) {
  const posts = getSetting(guildId, CUSTOM_POSTS_KEY, []);
  return Array.isArray(posts) ? posts.filter((post) => post?.id && post.channelId && post.messageId).slice(0, 100) : [];
}

function showModal(interaction, modal) {
  return interaction.showModal(modal);
}

function createEmbedModal(mode, channelId, initial = {}) {
  const modal = new ModalBuilder()
    .setCustomId(`central:modal:post-create:${mode}:${channelId}`)
    .setTitle(mode === 'both' ? 'Criar mensagem + embed' : 'Criar embed');
  return modal
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Título')
        .setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(initial.title || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Descrição')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(3500).setRequired(true).setValue(initial.description || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Mensagem (opcional)')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(1900).setRequired(mode === 'both').setValue(initial.content || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Imagem HTTPS (opcional)')
        .setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(initial.image || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Rodapé (opcional)')
        .setStyle(TextInputStyle.Short).setMaxLength(2048).setRequired(false).setValue(initial.footer || '')),
    );
}

function createTextModal(channelId, initial = {}) {
  return new ModalBuilder().setCustomId(`central:modal:post-create:text:${channelId}`).setTitle('Criar mensagem simples')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Conteúdo')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(1900).setRequired(true).setValue(initial.content || '')),
    );
}

function createNvidiaKeyModal() {
  return new ModalBuilder().setCustomId('central:modal:ai-key').setTitle('Atualizar chave NVIDIA')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('api-key').setLabel('Nova NVIDIA_API_KEY; não será exibida após salvar')
        .setStyle(TextInputStyle.Short).setMinLength(20).setMaxLength(4000).setRequired(true),
    ));
}

function createEditModal(post) {
  const modal = new ModalBuilder().setCustomId(`central:modal:post-edit:${post.id}`)
    .setTitle(post.type === 'text' ? 'Editar mensagem' : 'Editar embed');
  if (post.type === 'text') {
    return modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('content').setLabel('Conteúdo')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(1900).setRequired(true).setValue(post.content || ''),
    ));
  }
  if (post.type === 'both') {
    return modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Título')
        .setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(post.title || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Descrição')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(3500).setRequired(true).setValue(post.description || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Mensagem')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(1900).setRequired(true).setValue(post.content || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Imagem HTTPS (opcional)')
        .setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(post.image || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Rodapé (opcional)')
        .setStyle(TextInputStyle.Short).setMaxLength(2048).setRequired(false).setValue(post.footer || '')),
    );
  }
  return modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Título')
      .setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(post.title || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Descrição')
      .setStyle(TextInputStyle.Paragraph).setMaxLength(3500).setRequired(true).setValue(post.description || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Imagem HTTPS (opcional)')
      .setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(post.image || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Rodapé (opcional)')
      .setStyle(TextInputStyle.Short).setMaxLength(2048).setRequired(false).setValue(post.footer || '')),
  );
}

function validateImageUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('A imagem precisa ser uma URL HTTPS válida.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A imagem precisa usar HTTPS sem credenciais.');
  return url.toString();
}

export function resolveAnnouncementAliases(value, emojis) {
  const missing = new Set();
  const text = String(value ?? '').replace(/:(emoji_\d+):/g, (alias, name) => {
    const emoji = emojis?.find((candidate) => candidate.name === name && candidate.available !== false);
    if (!emoji) {
      missing.add(alias);
      return alias;
    }
    return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
  });
  return { text, missing: [...missing] };
}

async function resolvePostValues(guild, fields) {
  const emojis = await guild.emojis.fetch().catch(() => guild.emojis.cache);
  const resolved = {};
  const missing = new Set();
  for (const [key, value] of Object.entries(fields)) {
    const result = resolveAnnouncementAliases(value, emojis);
    resolved[key] = result.text;
    result.missing.forEach((alias) => missing.add(alias));
  }
  return { fields: resolved, missing: [...missing] };
}

function buildAnnouncementPayload(type, fields, image) {
  if (type === 'text') return { content: fields.content };
  const embed = new EmbedBuilder().setColor(0xFFFFFF).setTitle(fields.title).setDescription(fields.description);
  if (fields.footer) embed.setFooter({ text: fields.footer });
  if (image) embed.setImage(image);
  return {
    ...(type === 'both' ? { content: fields.content } : {}),
    embeds: [embed],
  };
}

function prunePendingAnnouncements() {
  const now = Date.now();
  for (const [id, draft] of pendingAnnouncements) {
    if (draft.expiresAt <= now) pendingAnnouncements.delete(id);
  }
  while (pendingAnnouncements.size >= 100) {
    pendingAnnouncements.delete(pendingAnnouncements.keys().next().value);
  }
}

async function showAnnouncementPreview(interaction, type, channelId, rawFields) {
  if (!['text', 'embed', 'both'].includes(type)) throw new Error('Formato de anúncio inválido.');
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
    throw new Error('O canal precisa ser um canal de texto deste servidor.');
  }
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (type !== 'text') required.push(PermissionFlagsBits.EmbedLinks);
  if (!channel.permissionsFor(interaction.guild.members.me)?.has(required)) {
    throw new Error('O bot não possui as permissões necessárias no canal selecionado.');
  }
  const image = type === 'text' ? null : validateImageUrl(rawFields.image || '');
  const { fields, missing } = await resolvePostValues(interaction.guild, rawFields);
  const payload = buildAnnouncementPayload(type, fields, image);
  const id = crypto.randomUUID();
  const draft = {
    id,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId,
    type,
    rawFields,
    fields,
    image,
    missing,
    payload,
    expiresAt: Date.now() + 15 * 60_000,
    sending: false,
  };
  prunePendingAnnouncements();
  pendingAnnouncements.set(id, draft);
  const warning = missing.length
    ? `Aliases não encontrados: ${missing.map((alias) => `\`${alias}\``).join(', ')}. Confirme os nomes dos emojis do servidor ou edite o anúncio; o envio está desativado nesta prévia.`
    : `Prévia do anúncio para <#${channelId}>. Confirme o envio em até 15 minutos.`;
  const previewText = payload.content ? `\n\n**Conteúdo da mensagem:**\n${payload.content}` : '';
  await interaction.reply({
    content: `${warning}${previewText}`,
    embeds: payload.embeds || [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`central:post:confirm:${id}`).setLabel('Confirmar envio')
        .setStyle(ButtonStyle.Success).setDisabled(missing.length > 0),
      new ButtonBuilder().setCustomId(`central:post:edit-draft:${id}`).setLabel('Editar anúncio').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`central:post:cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger),
    )],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function publishCustomPost(interaction, draft) {
  const channelId = draft.channelId;
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
    throw new Error('O canal precisa ser um canal de texto deste servidor.');
  }
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (draft.payload.embeds?.length) required.push(PermissionFlagsBits.EmbedLinks);
  if (!channel.permissionsFor(interaction.guild.members.me)?.has(required)) {
    throw new Error('O bot não possui as permissões necessárias no canal selecionado.');
  }
  const published = await channel.send({ ...draft.payload, allowedMentions: { parse: [] } });
  const posts = getCustomPosts(interaction.guildId);
  const record = {
    type: draft.type,
    title: draft.fields.title || '',
    description: draft.fields.description || '',
    content: draft.fields.content || '',
    footer: draft.fields.footer || '',
    image: draft.image,
    id: published.id,
    channelId,
    messageId: published.id,
    createdBy: interaction.user.id,
  };
  setSetting(interaction.guildId, CUSTOM_POSTS_KEY, [record, ...posts].slice(0, 100));
  audit(interaction, 'anúncio publicado', { channelId, messageId: published.id, title: record.title || null });
  return published;
}

async function showPostManager(interaction) {
  const posts = getCustomPosts(interaction.guildId);
  if (!posts.length) {
    await interaction.reply({ content: 'Não há publicações administradas por este painel.', ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder().setCustomId('central:post:select').setPlaceholder('Selecionar publicação')
    .addOptions(posts.slice(0, 25).map((post) => ({
      label: (post.title || post.content || 'Mensagem').slice(0, 100),
      description: `Canal ${post.channelId}`.slice(0, 100),
      value: post.id,
    })));
  await interaction.reply({ content: 'Selecione uma publicação administrada:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
}

export async function handleCentralInteraction(interaction) {
  if (!isAuthorized(interaction)) {
    const reply = { content: 'Esta ação é restrita ao proprietário e administradores autorizados.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
    else await interaction.reply(reply);
    return;
  }

  const id = interaction.customId;
  if (interaction.isStringSelectMenu() && id === 'central:page') {
    await interaction.update(buildCentralPanelPayload(interaction.guild, interaction.values[0]));
    return;
  }
  if (interaction.isChannelSelectMenu()) {
    const channel = await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guildId) {
      throw new Error('Selecione um canal de texto válido deste servidor.');
    }
    if (id.startsWith('central:post:choose:')) {
      const mode = id.slice('central:post:choose:'.length);
      if (!['text', 'embed', 'both'].includes(mode)) throw new Error('Formato de anúncio inválido.');
      const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
      if (mode !== 'text') required.push(PermissionFlagsBits.EmbedLinks);
      if (!channel.permissionsFor(interaction.guild.members.me)?.has(required)) {
        throw new Error('O bot não possui as permissões necessárias para publicar nesse canal.');
      }
      await showModal(interaction, mode === 'text'
        ? createTextModal(channel.id)
        : createEmbedModal(mode, channel.id));
      return;
    }
    if (id === 'central:channel:news') {
      const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
      if (!channel.permissionsFor(interaction.guild.members.me)?.has(required)) throw new Error('O bot precisa de Ver canal, Enviar mensagens e Incorporar links no canal do jornal.');
      setSetting(interaction.guildId, 'news_channel_id', channel.id);
      const news = getNewsSettings(interaction.guildId);
      if (news.enabled) {
        setSetting(interaction.guildId, 'news_next_attempt_at', Date.now());
        startNewsService(interaction.client, interaction.guildId);
      }
    } else if (id === 'central:channel:quest') {
      updateMissionSettings(interaction.guildId, { availableChannelId: channel.id });
    } else if (id === 'central:channel:logs') {
      const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
      if (!channel.permissionsFor(interaction.guild.members.me)?.has(required)) throw new Error('O bot precisa de Ver canal, Enviar mensagens e Incorporar links no canal de logs.');
      setSetting(interaction.guildId, 'logs_channel', channel.id);
    } else {
      throw new Error('Seletor de canal desconhecido.');
    }
    audit(interaction, 'canal configurado', { setting: id, channelId: channel.id });
    await interaction.update(buildCentralPanelPayload(interaction.guild, 'channels'));
    return;
  }
  if (interaction.isModalSubmit()) {
    if (id === 'central:modal:ai-key') {
      rotateNvidiaApiKey(interaction.fields.getTextInputValue('api-key'), { guildId: interaction.guildId });
      audit(interaction, 'chave NVIDIA rotacionada', { source: 'admin-panel' });
      await interaction.reply({ content: 'Nova chave NVIDIA salva criptografada e ativada. O segredo não foi incluído nos logs.', ephemeral: true });
      return;
    }
    if (id.startsWith('central:modal:post-create:')) {
      const [, , , type, channelId] = id.split(':');
      const rawFields = type === 'text'
        ? { content: interaction.fields.getTextInputValue('content').trim() }
        : {
          title: interaction.fields.getTextInputValue('title').trim(),
          description: interaction.fields.getTextInputValue('description').trim(),
          content: interaction.fields.getTextInputValue('content').trim(),
          image: interaction.fields.getTextInputValue('image').trim(),
          footer: interaction.fields.getTextInputValue('footer').trim(),
        };
      if (type === 'text' && !rawFields.content) throw new Error('A mensagem não pode ficar vazia.');
      if (type !== 'text' && (!rawFields.title || !rawFields.description)) {
        throw new Error('Título e descrição do embed não podem ficar vazios.');
      }
      if (type === 'both' && !rawFields.content) throw new Error('O conteúdo da mensagem não pode ficar vazio.');
      await showAnnouncementPreview(interaction, type, channelId, rawFields);
      return;
    }
    if (id === 'central:modal:news-interval') {
      const minutes = Number(interaction.fields.getTextInputValue('minutes'));
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('O intervalo precisa ser entre 1 e 1.440 minutos.');
      setSetting(interaction.guildId, 'news_interval_minutes', minutes);
      const news = getNewsSettings(interaction.guildId);
      if (news.enabled) {
        setSetting(interaction.guildId, 'news_next_attempt_at', Date.now() + minutes * 60_000);
        startNewsService(interaction.client, interaction.guildId);
      }
      audit(interaction, 'intervalo de notícias alterado', { minutes });
      await interaction.reply({ content: `Intervalo do jornal definido para ${minutes} minuto(s).`, ephemeral: true });
      return;
    }
    if (id === 'central:modal:quest-source') {
      const value = interaction.fields.getTextInputValue('url').trim();
      const feedUrl = value ? await validateMissionFeedUrl(value) : null;
      updateMissionSettings(interaction.guildId, { feedUrl });
      audit(interaction, 'fonte pública de missões alterada', { configured: Boolean(feedUrl), hostname: missionFeedHost(feedUrl) });
      await interaction.reply({ content: feedUrl ? `Fonte alternativa configurada: ${missionFeedHost(feedUrl)}.` : 'Fonte alternativa removida; será usada a API pública api.discordquest.com.', ephemeral: true });
      return;
    }
    if (id.startsWith('central:modal:post-edit:')) {
      const postId = id.slice('central:modal:post-edit:'.length);
      const posts = getCustomPosts(interaction.guildId);
      const index = posts.findIndex((entry) => entry.id === postId);
      if (index < 0) throw new Error('A publicação não está mais registrada.');
      const post = posts[index];
      const channel = await interaction.guild.channels.fetch(post.channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) throw new Error('O canal da publicação não está disponível.');
      const message = await channel.messages.fetch(post.messageId).catch(() => null);
      if (!message || message.author.id !== interaction.client.user.id) throw new Error('A mensagem não existe mais ou não pertence ao bot.');
      let updated;
      const rawFields = post.type === 'text'
        ? { content: interaction.fields.getTextInputValue('content').trim() }
        : {
          title: interaction.fields.getTextInputValue('title').trim(),
          description: interaction.fields.getTextInputValue('description').trim(),
          content: post.type === 'both' ? interaction.fields.getTextInputValue('content').trim() : '',
          footer: interaction.fields.getTextInputValue('footer').trim(),
        };
      if (Object.values(rawFields).some((value) => typeof value === 'string' && !value.trim())
        && (post.type === 'text' || post.type === 'both')) throw new Error('O conteúdo da publicação não pode ficar vazio.');
      if (post.type !== 'text' && (!rawFields.title || !rawFields.description)) throw new Error('Título e descrição não podem ficar vazios.');
      const { fields, missing } = await resolvePostValues(interaction.guild, rawFields);
      if (missing.length) throw new Error(`Emojis não encontrados no servidor: ${missing.join(', ')}.`);
      const image = post.type === 'text' ? null : validateImageUrl(interaction.fields.getTextInputValue('image').trim());
      const payload = buildAnnouncementPayload(post.type, fields, image);
      await message.edit({ content: payload.content || '', embeds: payload.embeds || [], allowedMentions: { parse: [] } });
      updated = { ...post, ...fields, image };
      posts[index] = updated;
      setSetting(interaction.guildId, CUSTOM_POSTS_KEY, posts);
      audit(interaction, 'anúncio editado', { channelId: post.channelId, messageId: post.messageId });
      await interaction.reply({ content: 'Publicação atualizada.', ephemeral: true });
      return;
    }
    throw new Error('Formulário expirado ou desconhecido. Abra o painel novamente.');
  }
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) throw new Error('Interação administrativa inválida.');

  if (id.startsWith('central:post:confirm:')) {
    const draftId = id.slice('central:post:confirm:'.length);
    const draft = pendingAnnouncements.get(draftId);
    if (!draft || draft.expiresAt <= Date.now() || draft.guildId !== interaction.guildId
      || draft.userId !== interaction.user.id) {
      pendingAnnouncements.delete(draftId);
      await interaction.reply({ content: 'Esta prévia expirou ou não pertence a você. Crie uma nova prévia.', ephemeral: true });
      return;
    }
    if (draft.missing.length || draft.sending) {
      await interaction.reply({ content: draft.missing.length ? 'Corrija os emojis não encontrados antes de publicar.' : 'Este anúncio já está sendo enviado.', ephemeral: true });
      return;
    }
    draft.sending = true;
    try {
      const published = await publishCustomPost(interaction, draft);
      pendingAnnouncements.delete(draftId);
      await interaction.update({
        content: `Anúncio publicado em <#${draft.channelId}>. Mensagem: ${published.id}.`,
        embeds: [],
        components: [],
      });
    } catch (error) {
      draft.sending = false;
      throw error;
    }
    return;
  }
  if (id.startsWith('central:post:edit-draft:')) {
    const draftId = id.slice('central:post:edit-draft:'.length);
    const draft = pendingAnnouncements.get(draftId);
    if (!draft || draft.expiresAt <= Date.now() || draft.guildId !== interaction.guildId
      || draft.userId !== interaction.user.id) {
      pendingAnnouncements.delete(draftId);
      await interaction.reply({ content: 'Esta prévia expirou ou não pertence a você. Crie uma nova prévia.', ephemeral: true });
      return;
    }
    pendingAnnouncements.delete(draftId);
    await showModal(interaction, draft.type === 'text'
      ? createTextModal(draft.channelId, draft.rawFields)
      : createEmbedModal(draft.type, draft.channelId, draft.rawFields));
    return;
  }
  if (id.startsWith('central:post:cancel:')) {
    const draftId = id.slice('central:post:cancel:'.length);
    const draft = pendingAnnouncements.get(draftId);
    if (draft && draft.guildId === interaction.guildId && draft.userId === interaction.user.id) {
      pendingAnnouncements.delete(draftId);
    }
    await interaction.update({ content: 'Prévia cancelada; nenhum anúncio foi enviado.', embeds: [], components: [] });
    return;
  }

  if (id.startsWith('central:anti:')) {
    const protection = id.slice('central:anti:'.length);
    if (!PROTECTIONS.includes(protection)) throw new Error('Proteção desconhecida.');
    const enabled = !getAntiConfig(interaction.guildId).enabled[protection];
    updateAntiConfig(interaction.guildId, { enabled: { [protection]: enabled } });
    audit(interaction, 'proteção alterada', { protection, enabled });
    await interaction.update(buildCentralPanelPayload(interaction.guild, 'moderation'));
    return;
  }
  if (id === 'central:quest:toggle') {
    const missions = getMissionSettings(interaction.guildId);
    const next = updateMissionSettings(interaction.guildId, { automatic: !missions.automatic });
    audit(interaction, 'monitor de missões alterado', {
      enabled: next.automatic,
      provider: next.feedUrl ? 'configured-json-feed' : 'discordquest-api',
    });
    await interaction.update(buildCentralPanelPayload(interaction.guild, 'quest'));
    return;
  }
  if (id === 'central:quest:source') {
    const modal = new ModalBuilder().setCustomId('central:modal:quest-source').setTitle('Fonte pública de missões')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('url').setLabel('URL HTTPS pública de feed JSON (vazio remove)')
          .setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false)
          .setValue(getMissionSettings(interaction.guildId).feedUrl || ''),
      ));
    await showModal(interaction, modal);
    return;
  }
  if (id === 'central:news:toggle') {
    const news = getNewsSettings(interaction.guildId);
    const enabled = !news.enabled;
    if (enabled && !news.channelId) throw new Error('Selecione primeiro o canal do jornal na seção News ou Canais.');
    setSetting(interaction.guildId, 'news_enabled', enabled);
    if (enabled) {
      setSetting(interaction.guildId, 'news_next_attempt_at', Date.now());
      startNewsService(interaction.client, interaction.guildId);
    } else {
      setSetting(interaction.guildId, 'news_next_attempt_at', null);
      stopNewsService(interaction.guildId);
    }
    audit(interaction, 'jornal alterado', { enabled });
    await interaction.update(buildCentralPanelPayload(interaction.guild, 'news'));
    return;
  }
  if (id === 'central:news:interval') {
    const modal = new ModalBuilder().setCustomId('central:modal:news-interval').setTitle('Intervalo do jornal')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('minutes').setLabel('Minutos (1 a 1440)')
          .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(4).setRequired(true)
          .setValue(String(getNewsSettings(interaction.guildId).intervalMinutes)),
      ));
    await showModal(interaction, modal);
    return;
  }
  if (id === 'central:news:test') {
    await interaction.deferReply({ ephemeral: true });
    const result = await runNewsCheck(interaction.client, interaction.guildId);
    await interaction.editReply(result.published
      ? `Notícia real publicada: ${result.article.title}`
      : result.failures ? 'As fontes falharam ou não tinham notícia nova. Consulte Logs.' : 'Nenhuma notícia nova; nada foi inventado ou publicado.');
    return;
  }
  if (id === 'central:ai:diagnose') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await askNvidia('Responda somente com a palavra OK.', { requestKey: `redcloud-diagnostic:${interaction.user.id}:${Date.now()}` });
      await interaction.editReply(`A API da IA respondeu: ${sanitize(result).slice(0, 100)}.`);
    } catch (error) {
      await interaction.editReply(`Diagnóstico da IA falhou: ${sanitize(error.message)}. Os demais serviços não dependem desta requisição.`);
    }
    return;
  }
  if (id === 'central:ai:key') {
    if (!getAiStatus().encryptionConfigured) {
      throw new Error('Configure REDCLOUD_KEY_ENCRYPTION_SECRET no ambiente antes de salvar chaves pelo painel.');
    }
    await showModal(interaction, createNvidiaKeyModal());
    return;
  }
  if (['central:post:create-embed', 'central:post:create-text', 'central:post:create-both'].includes(id)) {
    const mode = id.endsWith('create-text') ? 'text' : id.endsWith('create-both') ? 'both' : 'embed';
    await interaction.reply({
      content: 'Selecione o canal de destino do anúncio.',
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId(`central:post:choose:${mode}`)
          .setPlaceholder('Selecionar canal de texto').setChannelTypes(ChannelType.GuildText),
      )],
      ephemeral: true,
    });
    return;
  }
  if (id === 'central:post:list') return showPostManager(interaction);
  if (interaction.isStringSelectMenu() && id === 'central:post:select') {
    const post = getCustomPosts(interaction.guildId).find((entry) => entry.id === interaction.values[0]);
    if (!post) throw new Error('A publicação não está mais registrada.');
    await interaction.reply({ content: `Publicação em <#${post.channelId}> • mensagem ${post.messageId}.`, components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`central:post:edit:${post.id}`).setLabel('Editar publicação').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`central:post:delete:${post.id}`).setLabel('Excluir publicação').setStyle(ButtonStyle.Danger),
      ),
    ], ephemeral: true });
    return;
  }
  if (id.startsWith('central:post:edit:')) {
    const postId = id.slice('central:post:edit:'.length);
    const post = getCustomPosts(interaction.guildId).find((entry) => entry.id === postId);
    if (!post) throw new Error('A publicação não está mais registrada.');
    await showModal(interaction, createEditModal(post));
    return;
  }
  if (id.startsWith('central:post:delete:')) {
    const postId = id.slice('central:post:delete:'.length);
    const post = getCustomPosts(interaction.guildId).find((entry) => entry.id === postId);
    if (!post) throw new Error('A publicação não está mais registrada.');
    await interaction.update({ content: 'Confirma excluir somente a mensagem publicada por este painel?', components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`central:post:confirm-delete:${post.id}`).setLabel('Confirmar exclusão').setStyle(ButtonStyle.Danger),
      ),
    ] });
    return;
  }
  if (id.startsWith('central:post:confirm-delete:')) {
    const postId = id.slice('central:post:confirm-delete:'.length);
    const posts = getCustomPosts(interaction.guildId);
    const post = posts.find((entry) => entry.id === postId);
    if (!post) throw new Error('A publicação não está mais registrada.');
    const channel = await interaction.guild.channels.fetch(post.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('O canal da publicação não está disponível.');
    const message = await channel.messages.fetch(post.messageId).catch(() => null);
    if (message && message.author.id === interaction.client.user.id) await message.delete();
    setSetting(interaction.guildId, CUSTOM_POSTS_KEY, posts.filter((entry) => entry.id !== postId));
    audit(interaction, 'publicação personalizada excluída', { channelId: post.channelId, messageId: post.messageId });
    await interaction.update({ content: 'Publicação removida do painel e apagada, se ainda existia.', components: [] });
    return;
  }
  if (id === 'central:refresh') {
    await interaction.update(buildCentralPanelPayload(interaction.guild));
    return;
  }
  throw new Error('Ação administrativa desconhecida ou expirada.');
}