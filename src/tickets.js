import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from './config.js';
import { db, getSetting, setSetting, storeSystemLog } from './db.js';
import { recordError, sanitize } from './errors.js';

const TEAM_ROLES = {
  diretor: '1554989157175005206',
  gerente: '1554988875980742656',
  supervisor: '1554988451558985828',
  moderador: '1554987936137875527',
  suporte: '1554987217833955379',
  helper: '1554986077901688853',
};
const DEFAULT_SETTINGS = {
  categoryId: null,
  logsChannelId: '1558800667030720542',
  transcriptChannelId: '15588010595588546766',
  reviewChannelId: null,
  hoursChannelId: '1558635259065536557',
  helpChannelId: '1558800456015159316',
  adminLogsChannelId: '1554980393394897046',
  purchaseLogsChannelId: '1554980543785861280',
  staffRoleIds: Object.values(TEAM_ROLES),
  maxOpenPerUser: 1,
  closeBehavior: 'archive',
  panelTitle: 'Central de Atendimento • Zonde Lab',
  panelMessage: '',
  reviewChannelId: '1553754411497423011',
};
const CATEGORIES = {
  suporte: {
    label: 'Suporte geral',
    description: 'Dúvidas e problemas gerais.',
    emojiId: '1558631252792184935',
    fields: [
      ['subject', 'Assunto', TextInputStyle.Short, 100, true],
      ['description', 'Descrição detalhada do problema', TextInputStyle.Paragraph, 1500, true],
    ],
  },
  compras: {
    label: 'Compras',
    description: 'Ajuda com compras e pagamentos.',
    emojiId: '1558796870342545549',
    fields: [
      ['product', 'Produto ou serviço relacionado', TextInputStyle.Short, 100, true],
      ['description', 'Descrição da solicitação', TextInputStyle.Paragraph, 1200, true],
      ['order', 'Identificador do pedido (se existir)', TextInputStyle.Short, 100, false],
    ],
  },
  servicos: {
    label: 'Serviços',
    description: 'Problemas relacionados aos serviços.',
    emojiId: null,
    fields: [
      ['service', 'Serviço relacionado', TextInputStyle.Short, 100, true],
      ['description', 'Descrição do problema ou solicitação', TextInputStyle.Paragraph, 1500, true],
    ],
  },
  parcerias: {
    label: 'Parcerias',
    description: 'Solicitações de parceria.',
    emojiId: '1558796871625875607',
    fields: [
      ['project', 'Nome do servidor ou projeto', TextInputStyle.Short, 100, true],
      ['description', 'Descrição da proposta', TextInputStyle.Paragraph, 1200, true],
      ['reference', 'Link de referência (opcional)', TextInputStyle.Short, 200, false],
    ],
  },
  outros: {
    label: 'Outros assuntos',
    description: 'Assuntos que não se encaixam nas demais categorias.',
    emojiId: null,
    fields: [
      ['subject', 'Assunto', TextInputStyle.Short, 100, true],
      ['description', 'Descrição detalhada', TextInputStyle.Paragraph, 1500, true],
    ],
  },
};
const openingByUser = new Set();
const closingTickets = new Set();

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT UNIQUE,
    panel_channel_id TEXT,
    panel_message_id TEXT,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    form_json TEXT NOT NULL,
    status TEXT NOT NULL,
    assigned_to TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT,
    close_reason TEXT,
    transcript_state TEXT,
    transcript_text TEXT
  );
  CREATE INDEX IF NOT EXISTS tickets_guild_status ON tickets(guild_id, status);
  CREATE INDEX IF NOT EXISTS tickets_guild_user ON tickets(guild_id, user_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_active_per_user
    ON tickets(guild_id, user_id)
    WHERE status IN ('opening', 'open', 'in_progress');
  CREATE TABLE IF NOT EXISTS ticket_reviews (
    ticket_id TEXT PRIMARY KEY REFERENCES tickets(id),
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    category TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    user_id TEXT NOT NULL,
    attendant_id TEXT,
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ticket_reviews_guild_date ON ticket_reviews(guild_id, created_at);
`);

export function ticketCommand() {
  return new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Painel e gerenciamento de atendimento')
    .addSubcommand((subcommand) => subcommand.setName('painel').setDescription('Publicar ou atualizar o painel de atendimento'))
    .addSubcommand((subcommand) => subcommand.setName('configurar').setDescription('Configurar o sistema de tickets')
      .addChannelOption((option) => option.setName('categoria').setDescription('Categoria para novos tickets')
        .addChannelTypes(ChannelType.GuildCategory))
      .addChannelOption((option) => option.setName('logs').setDescription('Canal de logs de tickets')
        .addChannelTypes(ChannelType.GuildText))
      .addChannelOption((option) => option.setName('transcricoes').setDescription('Canal privado de transcrições')
        .addChannelTypes(ChannelType.GuildText))
      .addChannelOption((option) => option.setName('avaliacoes').setDescription('Canal de avaliações')
        .addChannelTypes(ChannelType.GuildText))
      .addChannelOption((option) => option.setName('horarios').setDescription('Canal de horários')
        .addChannelTypes(ChannelType.GuildText))
      .addChannelOption((option) => option.setName('ajuda').setDescription('Canal de ajuda')
        .addChannelTypes(ChannelType.GuildText))
      .addChannelOption((option) => option.setName('logs_admin').setDescription('Canal de logs administrativos')
        .addChannelTypes(ChannelType.GuildText))
      .addChannelOption((option) => option.setName('logs_compras').setDescription('Canal de logs de compras')
        .addChannelTypes(ChannelType.GuildText))
      .addRoleOption((option) => option.setName('cargo').setDescription('Cargo de equipe a adicionar ou remover'))
      .addIntegerOption((option) => option.setName('limite').setDescription('Máximo de tickets ativos por usuário')
        .setMinValue(1).setMaxValue(5))
      .addStringOption((option) => option.setName('fechamento').setDescription('Comportamento ao fechar')
        .addChoices({ name: 'Arquivar', value: 'archive' }, { name: 'Excluir após salvar', value: 'delete' }))
      .addStringOption((option) => option.setName('painel_titulo').setDescription('Título personalizado do painel').setMaxLength(100))
      .addStringOption((option) => option.setName('painel_texto').setDescription('Texto complementar do painel').setMaxLength(1000))
      .addStringOption((option) => option.setName('acao_cargo').setDescription('Ação para o cargo informado')
        .addChoices({ name: 'Adicionar', value: 'add' }, { name: 'Remover', value: 'remove' })))
    .addSubcommand((subcommand) => subcommand.setName('adicionar').setDescription('Adicionar participante ao ticket atual')
      .addUserOption((option) => option.setName('usuario').setDescription('Usuário autorizado').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('remover').setDescription('Remover participante do ticket atual')
      .addUserOption((option) => option.setName('usuario').setDescription('Participante').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('assumir').setDescription('Assumir o atendimento deste ticket'))
    .addSubcommand((subcommand) => subcommand.setName('fechar').setDescription('Solicitar o fechamento deste ticket')
      .addStringOption((option) => option.setName('motivo').setDescription('Motivo do encerramento').setMaxLength(300)))
    .addSubcommand((subcommand) => subcommand.setName('transcript').setDescription('Gerar uma transcrição do ticket atual'))
    .addSubcommand((subcommand) => subcommand.setName('estatisticas').setDescription('Consultar estatísticas reais de tickets'))
    .addSubcommand((subcommand) => subcommand.setName('avaliacao').setDescription('Consultar avaliações (equipe autorizada)'));
}

export function getTicketSettings(guildId) {
  const stored = getSetting(guildId, 'tickets', {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    reviewChannelId: stored.reviewChannelId || DEFAULT_SETTINGS.reviewChannelId,
    staffRoleIds: Array.isArray(stored.staffRoleIds) ? stored.staffRoleIds : DEFAULT_SETTINGS.staffRoleIds,
  };
}

export async function publishTicketPanel(guild, member, userId, channel) {
  requireGuild(guild);
  const settings = getTicketSettings(guild.id);
  if (!canConfigure(member, userId, settings)) {
    throw new Error('Somente a equipe administrativa autorizada ou o proprietário pode publicar o painel.');
  }
  const oldId = getSetting(guild.id, 'ticket_panel_message');
  const oldChannel = await getGuildChannel(guild, getSetting(guild.id, 'ticket_panel_channel'));
  const payload = await ticketPanelPayload(guild);
  if (oldId && oldChannel?.isTextBased()) {
    const existing = await oldChannel.messages.fetch(oldId).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      await recordTicketLog(guild, 'painel atualizado', { executor: userId, canal: oldChannel.id, mensagem: oldId });
      return { channel: oldChannel, message: existing, updated: true };
    }
  }
  if (!channel?.isTextBased() || channel.guildId !== guild.id) {
    throw new Error('Execute o comando em um canal de texto deste servidor.');
  }
  requireBotPermissions(channel, guild.members.me, [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  ]);
  const message = await channel.send(payload);
  setSetting(guild.id, 'ticket_panel_message', message.id);
  setSetting(guild.id, 'ticket_panel_channel', channel.id);
  await recordTicketLog(guild, 'painel publicado', { executor: userId, canal: channel.id, mensagem: message.id });
  return { channel, message, updated: false };
}

function setTicketSettings(guildId, settings) {
  setSetting(guildId, 'tickets', settings);
}

function recordTicketLog(guild, eventType, details) {
  storeSystemLog({ guildId: guild.id, module: 'tickets', eventType, details });
  const settings = getTicketSettings(guild.id);
  const channelIds = new Set([settings.logsChannelId]);
  if (eventType === 'configuração alterada' || eventType.startsWith('painel ')) {
    channelIds.add(settings.adminLogsChannelId);
  }
  if (details.categoria === CATEGORIES.compras.label) channelIds.add(settings.purchaseLogsChannelId);
  return (async () => {
    for (const channelId of channelIds) {
      const channel = await getGuildChannel(guild, channelId);
      if (!channel?.isTextBased()) {
        recordError({ service: 'tickets', step: 'canal de logs', error: new Error(`Canal ${channelId} ausente ou inacessível.`) });
        continue;
      }
      const botMember = guild.members.me;
      try {
        requireBotPermissions(channel, botMember, [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        ]);
        await channel.send({
          embeds: [new EmbedBuilder().setColor(0xC8102E).setTitle(`Tickets • ${eventType}`)
            .setDescription(Object.entries(details)
              .map(([key, value]) => `• **${key}:** ${sanitize(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 300)}`)
              .join('\n').slice(0, 3500))
            .setTimestamp()],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        recordError({ service: 'tickets', step: 'publicar log de ticket', error });
      }
    }
  })();
}

function getTicketByChannel(guildId, channelId) {
  return db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?')
    .get(guildId, channelId);
}

function getTicketById(ticketId) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
}

function activeTickets(guildId, userId) {
  db.prepare(`
    DELETE FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'opening'
      AND opened_at < ?
  `).run(guildId, userId, new Date(Date.now() - 10 * 60_000).toISOString());
  return db.prepare(`
    SELECT COUNT(*) AS count FROM tickets
    WHERE guild_id = ? AND user_id = ? AND status IN ('opening', 'open', 'in_progress')
  `).get(guildId, userId).count;
}

function hasRole(member, roleIds) {
  return roleIds.some((id) => member?.roles?.cache?.has(id));
}

function isOwner(userId) {
  return userId === config.ownerId;
}

function canHandle(member, userId, settings) {
  return isOwner(userId) || hasRole(member, settings.staffRoleIds);
}

function canManage(member, userId, settings) {
  return isOwner(userId) || hasRole(member, settings.staffRoleIds.slice(0, 4))
    || member?.permissions?.has(PermissionFlagsBits.Administrator)
    || member?.permissions?.has(PermissionFlagsBits.ManageGuild);
}

function canConfigure(member, userId, settings) {
  return isOwner(userId) || hasRole(member, settings.staffRoleIds.slice(0, 3))
    || member?.permissions?.has(PermissionFlagsBits.Administrator)
    || member?.permissions?.has(PermissionFlagsBits.ManageGuild);
}

function requireGuild(guild) {
  if (!guild) throw new Error('Este comando só pode ser usado em um servidor.');
}

async function getGuildChannel(guild, id) {
  if (!id) return null;
  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!channel || channel.guildId !== guild.id) return null;
  return channel;
}

function requireBotPermissions(channel, member, permissions) {
  const missing = permissions.filter((permission) => !channel.permissionsFor(member)?.has(permission));
  if (missing.length) throw new Error(`Permissões insuficientes do bot no canal <#${channel.id}>.`);
}

async function resolveEmoji(guild, emojiId, fallback) {
  if (!emojiId) return fallback;
  const emoji = guild.emojis.cache.get(emojiId) || await guild.emojis.fetch(emojiId).catch(() => null);
  return emoji?.available ? { id: emoji.id, name: emoji.name } : fallback;
}

async function ticketPanelPayload(guild) {
  const settings = getTicketSettings(guild.id);
  const hoursChannel = await getGuildChannel(guild, settings.hoursChannelId);
  const content = settings.panelMessage ? `\n\n${settings.panelMessage}` : '';
  const hours = hoursChannel?.isTextBased()
    ? `<#${hoursChannel.id}>`
    : 'Canal de horários não configurado. A administração deve definir um canal acessível.';
  const embed = new EmbedBuilder()
    .setColor(0xF2F2F2)
    .setTitle(settings.panelTitle)
    .setDescription([
      '» Precisa de ajuda com algum de nossos serviços?',
      '',
      'Nosso sistema de atendimento permite que você abra um ticket, onde nossa equipe poderá analisar sua solicitação e fornecer suporte de forma rápida e organizada.',
      content,
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      '🕒 **Horário de Atendimento**',
      `Olhe o canal configurado para consultar os horários de atendimento: ${hours}`,
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      '🧑‍💻 **Como funciona o atendimento**',
      'Ao selecionar uma opção abaixo, um formulário será aberto para você descrever sua solicitação.',
      'Após o envio, um ticket privado será criado automaticamente.',
      'Nossa equipe analisará sua solicitação e responderá assim que possível.',
    ].filter((line) => line !== null).join('\n').slice(0, 4000));
  const options = [];
  for (const [value, category] of Object.entries(CATEGORIES)) {
    const fallback = { suporte: '🎫', compras: '🛒', servicos: '🛠️', parcerias: '🤝', outros: '📩' }[value];
    const emoji = await resolveEmoji(guild, category.emojiId, fallback);
    options.push({ label: category.label, description: category.description, value, emoji });
  }
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:select')
        .setPlaceholder('Selecione uma opção para abrir o ticket...')
        .addOptions(options),
    )],
    allowedMentions: { parse: [] },
  };
}

function requireTicketStaff(interaction, ticket) {
  const settings = getTicketSettings(ticket.guild_id);
  if (!canHandle(interaction.member, interaction.user.id, settings)) {
    throw new Error('Você não possui um cargo autorizado para gerenciar este ticket.');
  }
  return settings;
}

function requireTicketManager(interaction, ticket) {
  const settings = getTicketSettings(ticket.guild_id);
  if (!canManage(interaction.member, interaction.user.id, settings)) {
    throw new Error('Você não possui permissão para gerenciar participantes deste ticket.');
  }
  return settings;
}

function buildTicketEmbed(ticket) {
  const category = CATEGORIES[ticket.category]?.label || ticket.category;
  const assigned = ticket.assigned_to ? `<@${ticket.assigned_to}>` : 'Aguardando atendente';
  const description = JSON.parse(ticket.form_json);
  const initial = Object.entries(description).map(([key, value]) => `**${key}:** ${value}`).join('\n\n');
  const closedStatus = ticket.status === 'closed';
  return new EmbedBuilder()
    .setColor(0xF2F2F2)
    .setTitle('🎫 Central de Atendimento')
    .setDescription([
      `Olá, <@${ticket.user_id}>!`,
      '',
      'Seu ticket foi criado com sucesso. Nossa equipe poderá analisar sua solicitação e responder assim que possível.',
      '',
      '**Informações do atendimento**',
      `• Categoria: ${category}`,
      `• Responsável: ${assigned}`,
      `• Status: ${closedStatus ? 'Encerrado' : ticket.status === 'in_progress' ? 'Em atendimento' : 'Aberto'}`,
      '',
      initial.slice(0, 2000),
      '',
      'Por favor, explique seu problema com o máximo de detalhes possível.',
    ].join('\n').slice(0, 4000))
    .addFields({ name: 'Ticket', value: `\`${ticket.id}\``, inline: true })
    .setTimestamp(new Date(ticket.opened_at));
}

async function updateTicketMessage(guild, ticket) {
  const channel = await getGuildChannel(guild, ticket.channel_id);
  if (!channel?.isTextBased() || !ticket.panel_message_id) return;
  const message = await channel.messages.fetch(ticket.panel_message_id).catch(() => null);
  if (!message) return;
  await message.edit({
    embeds: [buildTicketEmbed(ticket)],
    components: ticket.status === 'closed' ? [] : ticketActionRows(ticket),
    allowedMentions: { parse: [] },
  });
}

function ticketActionRows(ticket) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fechar ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Assumir atendimento').setEmoji('👤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Informações').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:hours:${ticket.id}`).setLabel('Horários de atendimento').setEmoji('🕒').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function resolveStaffRoles(guild, roleIds) {
  const roles = [];
  const missing = [];
  for (const id of roleIds) {
    const role = guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null);
    if (role?.guild.id === guild.id) roles.push(role);
    else missing.push(id);
  }
  if (missing.length) {
    recordError({
      service: 'tickets',
      step: 'validar cargos configurados',
      error: new Error(`Cargos de equipe ausentes em ${guild.id}: ${missing.join(', ')}`),
    });
  }
  if (!roles.length) throw new Error('Nenhum cargo de equipe configurado existe neste servidor. Ajuste /ticket configurar.');
  return roles;
}

async function createTicket(interaction, categoryKey, form) {
  const guild = interaction.guild;
  requireGuild(guild);
  const lockKey = `${guild.id}:${interaction.user.id}`;
  if (openingByUser.has(lockKey)) throw new Error('Seu ticket está sendo criado. Aguarde a confirmação.');
  openingByUser.add(lockKey);
  let reservationId;
  let createdChannel;
  let ticketPersisted = false;
  let ready = false;
  try {
    await interaction.deferReply({ ephemeral: true });
    const settings = getTicketSettings(guild.id);
    const active = activeTickets(guild.id, interaction.user.id);
    if (active >= settings.maxOpenPerUser) {
      throw new Error(`Você já possui ${active} ticket(s) ativo(s), o limite configurado é ${settings.maxOpenPerUser}.`);
    }
    const parent = await getGuildChannel(guild, settings.categoryId);
    if (!parent || parent.type !== ChannelType.GuildCategory) {
      throw new Error('A categoria de tickets não está configurada ou não existe neste servidor. Peça à administração para executar /ticket configurar categoria.');
    }
    const botMember = guild.members.me;
    if (!botMember) throw new Error('Não foi possível validar as permissões do bot neste servidor.');
    const botPerms = parent.permissionsFor(botMember);
    if (!botPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels])) {
      throw new Error('O bot precisa visualizar e gerenciar canais para criar tickets.');
    }
    const roles = await resolveStaffRoles(guild, settings.staffRoleIds);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    reservationId = id;
    const openedAt = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO tickets (id, guild_id, user_id, category, form_json, status, opened_at)
        VALUES (?, ?, ?, ?, ?, 'opening', ?)
      `).run(id, guild.id, interaction.user.id, categoryKey, JSON.stringify(form), openedAt);
    } catch (error) {
      if (String(error.message).includes('tickets_one_active_per_user')) {
        throw new Error('Você já possui um ticket em criação ou aberto neste servidor.');
      }
      throw error;
    }
    const permissionOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
      },
      {
        id: botMember.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
      },
      ...roles.map((role) => ({
        id: role.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
      })),
    ];
    const slug = CATEGORIES[categoryKey].label.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    createdChannel = await guild.channels.create({
      name: `${slug}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90),
      type: ChannelType.GuildText,
      parent: parent.id,
      permissionOverwrites,
      reason: `Ticket ${id} aberto por ${interaction.user.id}`,
    });
    db.prepare('UPDATE tickets SET channel_id = ?, status = ? WHERE id = ?')
      .run(createdChannel.id, 'open', id);
    ticketPersisted = true;
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    const message = await createdChannel.send({
      embeds: [buildTicketEmbed(ticket)],
      components: ticketActionRows(ticket),
      allowedMentions: { users: [interaction.user.id] },
    });
    db.prepare('UPDATE tickets SET panel_message_id = ? WHERE id = ?').run(message.id, id);
    ready = true;
    await recordTicketLog(guild, 'abertura', {
      ticket: id, usuário: interaction.user.tag, usuário_id: interaction.user.id,
      categoria: CATEGORIES[categoryKey].label, canal: createdChannel.name, canal_id: createdChannel.id,
      data: openedAt, descrição: JSON.stringify(form).slice(0, 1000),
    }).catch((error) => recordError({ service: 'tickets', step: 'log de abertura', error }));
    await interaction.editReply({ content: `Ticket criado: <#${createdChannel.id}>` });
  } catch (error) {
    let channelDeleted = !createdChannel;
    if (createdChannel && !ready) {
      try {
        await createdChannel.delete('Recuperação após falha parcial na criação do ticket');
        channelDeleted = true;
      } catch (deleteError) {
        recordError({ service: 'tickets', step: 'rollback de canal parcial', error: deleteError });
      }
    }
    if (reservationId && channelDeleted) db.prepare('DELETE FROM tickets WHERE id = ?').run(reservationId);
    if (reservationId && !channelDeleted && ticketPersisted) {
      recordError({ service: 'tickets', step: 'recuperação de ticket parcial', error: new Error(`Canal ${createdChannel.id} preservado com registro ${reservationId}.`) });
    }
    throw error;
  } finally {
    openingByUser.delete(lockKey);
  }
}

function showTicketForm(interaction, categoryKey) {
  const category = CATEGORIES[categoryKey];
  if (!category) throw new Error('Categoria de ticket inválida.');
  const modal = new ModalBuilder()
    .setCustomId(`ticket:form:${categoryKey}`)
    .setTitle(category.label);
  modal.addComponents(category.fields.map(([id, label, style, maxLength, required]) => (
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setMaxLength(maxLength)
        .setRequired(required)
        .setPlaceholder(required ? 'Preencha este campo' : 'Opcional'),
    )
  )));
  return interaction.showModal(modal);
}

function formFromInteraction(interaction, categoryKey) {
  const form = {};
  for (const [id, label, , , required] of CATEGORIES[categoryKey].fields) {
    const value = interaction.fields.getTextInputValue(id).trim();
    if (required && !value) throw new Error(`O campo "${label}" não pode ficar vazio.`);
    if (value) form[label] = value.slice(0, 1500);
  }
  return form;
}

async function makeTranscript(guild, ticket) {
  const channel = await getGuildChannel(guild, ticket.channel_id);
  if (!channel?.isTextBased()) throw new Error('O canal do ticket não existe; não é possível gerar a transcrição.');
  const messages = [];
  let before;
  while (messages.length < 5000) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = [
    `Zonde Lab — Transcrição do ticket ${ticket.id}`,
    `Servidor: ${guild.name} (${guild.id})`,
    `Autor: ${ticket.user_id}`,
    `Categoria: ${CATEGORIES[ticket.category]?.label || ticket.category}`,
    `Abertura: ${ticket.opened_at}`,
    `Atendente: ${ticket.assigned_to || 'Não identificado'}`,
    `Encerramento: ${ticket.closed_at || 'Em andamento'}`,
    '',
  ];
  for (const message of messages) {
    const attachments = [...message.attachments.values()].map((file) => file.url).join(' | ');
    lines.push(
      `[${new Date(message.createdTimestamp).toISOString()}] ${message.author?.tag || 'Usuário desconhecido'} (${message.author?.id || 'sem ID'}):`,
      message.content || (attachments ? '[sem texto]' : '[mensagem sem texto]'),
    );
    if (attachments) lines.push(`Anexos: ${attachments}`);
    if (message.embeds.length) lines.push(`[${message.embeds.length} embed(s)]`);
    lines.push('');
  }
  if (ticket.closed_at) lines.push(`Encerrado por: ${ticket.closed_by || 'Não identificado'}`, `Motivo: ${ticket.close_reason || 'Não informado'}`);
  return lines.join('\n').slice(0, 1_500_000);
}

function transcriptAttachment(ticket, text) {
  const filename = `ticket-${ticket.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `${filename}.txt` });
}

async function deliverTranscript(guild, ticket, text) {
  const settings = getTicketSettings(guild.id);
  const channel = await getGuildChannel(guild, settings.transcriptChannelId);
  if (!channel?.isTextBased()) return { state: 'saved_in_database_channel_unavailable', channel: null };
  const botMember = guild.members.me;
  requireBotPermissions(channel, botMember, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
  ]);
  if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('O canal de transcrições permite visualização a @everyone. Restrinja o canal à equipe antes de enviar dados privados.');
  }
  await channel.send({
    content: `Transcrição do ticket \`${ticket.id}\` • acesso restrito`,
    files: [transcriptAttachment(ticket, text)],
    allowedMentions: { parse: [] },
  });
  return { state: 'sent', channel };
}

async function sendReviewRequest(guild, ticket) {
  const user = await guild.client.users.fetch(ticket.user_id).catch(() => null);
  const payload = {
    embeds: [new EmbedBuilder().setColor(0xFFFFFF).setTitle('☁️ RedCloud • Feedback')
      .setDescription([
        '━━━━━━━━━━━━━━━━━━',
        '',
        '**Gostou do atendimento?**',
        'Sua opinião é importante para melhorarmos nosso suporte! Avalie sua experiência preenchendo o formulário abaixo.',
        '',
        '⭐ Sua avaliação é rápida e ajuda nossa equipe a melhorar.',
        '',
        `Seu ticket \`${ticket.id}\` foi encerrado.`,
        '━━━━━━━━━━━━━━━━━━',
      ].join('\n'))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`review:start:${ticket.id}`)
        .setLabel('Avaliar atendimento').setEmoji('⭐').setStyle(ButtonStyle.Primary),
    )],
  };
  if (!user) {
    recordError({ service: 'tickets', step: 'DM de avaliação', error: new Error(`Não foi possível localizar o membro ${ticket.user_id}.`) });
    return false;
  }
  try {
    await user.send(payload);
    return true;
  } catch (error) {
    recordError({ service: 'tickets', step: 'DM de avaliação', error });
    return false;
  }
}

async function closeTicket(guild, ticket, actorId, reason) {
  if (closingTickets.has(ticket.id)) throw new Error('Este ticket já está sendo encerrado.');
  closingTickets.add(ticket.id);
  try {
    const current = getTicketById(ticket.id);
    if (!current || current.status === 'closed') throw new Error('Este ticket já foi encerrado ou não existe.');
    const closureAt = new Date().toISOString();
    let transcript;
    let transcriptState = 'failed';
    try {
      transcript = await makeTranscript(guild, current);
      db.prepare('UPDATE tickets SET transcript_text = ? WHERE id = ?').run(transcript, current.id);
      const result = await deliverTranscript(guild, current, transcript);
      transcriptState = result.state;
    } catch (error) {
      recordError({ service: 'tickets', step: 'gerar ou enviar transcrição', error });
      if (transcript) {
        db.prepare('UPDATE tickets SET transcript_text = ? WHERE id = ?').run(transcript, current.id);
        transcriptState = 'saved_in_database_delivery_failed';
      }
    }
    db.prepare(`
      UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ?, transcript_state = ?
      WHERE id = ? AND status IN ('open', 'in_progress')
    `).run(closureAt, actorId, reason || null, transcriptState, current.id);
    const closed = getTicketById(current.id);
    await updateTicketMessage(guild, closed);
    await recordTicketLog(guild, 'encerramento', {
      ticket: closed.id, autor: closed.user_id, atendente: closed.assigned_to || 'Não identificado',
      encerrado_por: actorId, motivo: reason || 'Não informado', data: closureAt,
      transcricao: transcriptState,
    });
    const userReached = await sendReviewRequest(guild, closed).catch((error) => {
      recordError({ service: 'tickets', step: 'solicitar avaliação privada', error });
      return false;
    });
    if (!userReached) {
      recordError({
        service: 'tickets',
        step: 'mensagem privada de avaliação',
        error: new Error(`Não foi possível alcançar o autor ${closed.user_id}; ticket ${closed.id}.`),
      });
    }
    const settings = getTicketSettings(guild.id);
    if (settings.closeBehavior === 'delete' && transcriptState !== 'failed') {
      const channel = await getGuildChannel(guild, closed.channel_id);
      if (channel) await channel.delete('Ticket encerrado; transcrição preservada');
    } else {
      const channel = await getGuildChannel(guild, closed.channel_id);
      const member = await guild.members.fetch(closed.user_id).catch(() => null);
      if (channel && member) {
        await channel.permissionOverwrites.edit(member, { SendMessages: false }).catch((error) => {
          recordError({ service: 'tickets', step: 'arquivar canal', error });
        });
      }
    }
    return { ...closed, transcriptState, userReached };
  } finally {
    closingTickets.delete(ticket.id);
  }
}

async function requestClose(interaction, ticketId, reason = '') {
  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.guild_id !== interaction.guildId || ticket.channel_id !== interaction.channelId) {
    throw new Error('Este canal não corresponde a um ticket ativo.');
  }
  requireTicketStaff(interaction, ticket);
  if (ticket.status === 'closed') throw new Error('Este ticket já foi encerrado.');
  setSetting(ticket.guild_id, `close_reason_${ticket.id}`, reason.slice(0, 300));
  await interaction.reply({
    content: 'Confirma o encerramento? A transcrição será preservada antes de arquivar o canal.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:close-confirm:${ticket.id}`)
        .setLabel('Confirmar encerramento').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket:close-cancel:${ticket.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

async function assumeTicket(interaction, ticket) {
  requireTicketStaff(interaction, ticket);
  const result = db.prepare(`
    UPDATE tickets SET assigned_to = ?, status = 'in_progress'
    WHERE id = ? AND guild_id = ? AND status IN ('open', 'in_progress')
      AND (assigned_to IS NULL OR assigned_to = ?)
  `).run(interaction.user.id, ticket.id, ticket.guild_id, interaction.user.id);
  if (!result.changes) throw new Error('O ticket foi encerrado ou já foi assumido por outro atendente.');
  const updated = getTicketById(ticket.id);
  await updateTicketMessage(interaction.guild, updated);
  await recordTicketLog(interaction.guild, 'atendimento assumido', {
    ticket: ticket.id, atendente: interaction.user.id,
  });
  await interaction.reply({ content: `Você assumiu o atendimento de <#${ticket.channel_id}>.`, ephemeral: true });
}

async function addOrRemoveParticipant(interaction, operation, user) {
  const ticket = getTicketByChannel(interaction.guildId, interaction.channelId);
  if (!ticket || ticket.status === 'closed') throw new Error('Use este comando dentro de um ticket ativo.');
  requireTicketManager(interaction, ticket);
  const settings = getTicketSettings(ticket.guild_id);
  if (!user || user.bot && operation === 'add') throw new Error('Selecione um usuário válido.');
  if (operation === 'remove' && user.id === ticket.user_id) throw new Error('O autor original do ticket não pode ser removido.');
  const channel = await getGuildChannel(interaction.guild, ticket.channel_id);
  if (!channel?.isTextBased()) throw new Error('O canal do ticket não existe.');
  requireBotPermissions(channel, interaction.guild.members.me, [PermissionFlagsBits.ManageChannels]);
  if (operation === 'remove') {
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (member && hasRole(member, settings.staffRoleIds)) throw new Error('Não é permitido remover um cargo obrigatório de equipe do ticket.');
  }
  if (operation === 'add') {
    await channel.permissionOverwrites.edit(user, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
    });
  } else {
    await channel.permissionOverwrites.delete(user.id, 'Participante removido do ticket');
  }
  await recordTicketLog(interaction.guild, `participante ${operation === 'add' ? 'adicionado' : 'removido'}`, {
    ticket: ticket.id, executor: interaction.user.id, usuário: user.id,
  });
  await interaction.reply({
    content: operation === 'add' ? `<@${user.id}> foi adicionado ao ticket.` : `<@${user.id}> foi removido do ticket.`,
    ephemeral: true,
    allowedMentions: { users: [user.id] },
  });
}

async function showTicketInfo(interaction, ticket) {
  if (interaction.user.id !== ticket.user_id && !canHandle(interaction.member, interaction.user.id, getTicketSettings(ticket.guild_id))) {
    throw new Error('Você não pode consultar informações internas deste ticket.');
  }
  const embed = new EmbedBuilder().setColor(0xF2F2F2).setTitle('Informações do ticket')
    .addFields(
      { name: 'Autor', value: `<@${ticket.user_id}> (\`${ticket.user_id}\`)` },
      { name: 'Categoria', value: CATEGORIES[ticket.category]?.label || ticket.category, inline: true },
      { name: 'Abertura', value: `<t:${Math.floor(Date.parse(ticket.opened_at) / 1000)}:F>`, inline: true },
      { name: 'Estado', value: ticket.status === 'in_progress' ? 'Em atendimento' : ticket.status === 'closed' ? 'Encerrado' : 'Aberto', inline: true },
      { name: 'Atendente', value: ticket.assigned_to ? `<@${ticket.assigned_to}>` : 'Não identificado', inline: true },
      { name: 'Canal', value: `<#${ticket.channel_id}> (\`${ticket.channel_id}\`)` },
    );
  if (ticket.closed_at) {
    embed.addFields(
      { name: 'Encerrado por', value: ticket.closed_by ? `<@${ticket.closed_by}>` : 'Não identificado', inline: true },
      { name: 'Data de encerramento', value: `<t:${Math.floor(Date.parse(ticket.closed_at) / 1000)}:F>`, inline: true },
      { name: 'Transcrição', value: ticket.transcript_state || 'Não disponível', inline: true },
    );
  }
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function submitReview(interaction, ticketId) {
  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.status !== 'closed' || ticket.user_id !== interaction.user.id) {
    throw new Error('Esta solicitação de avaliação não é válida para sua conta.');
  }
  if (db.prepare('SELECT 1 FROM ticket_reviews WHERE ticket_id = ?').get(ticket.id)) {
    await interaction.reply({ content: 'Este ticket já recebeu uma avaliação.', ephemeral: Boolean(interaction.guildId) });
    return;
  }
  const modal = new ModalBuilder().setCustomId(`review:comment:${ticket.id}`).setTitle('Avaliar atendimento')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('comment').setLabel('Comentário (opcional)')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false),
    ));
  await interaction.showModal(modal);
}

function reviewRatingMenu(ticketId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`review:rating:${ticketId}`)
      .setPlaceholder('Selecione sua nota de 1 a 5 estrelas')
      .addOptions([1, 2, 3, 4, 5].map((rating) => ({
        label: `${'⭐'.repeat(rating)} — ${rating}/5`,
        value: String(rating),
      }))),
  );
}

function feedbackEmoji(guild, name, fallback) {
  const emoji = guild.emojis.cache.find((candidate) => candidate.name === name);
  if (!emoji) return fallback;
  return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
}

function renderReviewEmbed(review, guild) {
  const stars = '⭐'.repeat(review.rating);
  const attendant = review.attendant_id ? `<@${review.attendant_id}>` : 'Não identificado';
  const user = review.user_id ? `<@${review.user_id}>` : '@usuário-desconhecido';
  const memberEmoji = feedbackEmoji(guild, 'emoji_23', '👤');
  const attendantEmoji = feedbackEmoji(guild, 'emoji_30', '🛡️');
  const ticketEmoji = feedbackEmoji(guild, 'emoji_34', '🎫');
  return new EmbedBuilder().setColor(0xFFFFFF).setTitle('☁️ RedCloud • Feedback')
    .setDescription([
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      '⭐ **Avaliação de Atendimento**',
      '',
      `${memberEmoji} **Membro:** ${user}`,
      `${attendantEmoji} **Atendente:** ${attendant}`,
      `${ticketEmoji} **Ticket:** \"${review.channel_name}\" (\`${review.ticket_id}\`)`,
      '',
      `⭐ **Nota:** ${stars} ${review.rating}/5`,
      ...(review.comment ? ['', `💬 **Comentário:** ${review.comment}`] : []),
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      'Avaliação registrada automaticamente após o envio do formulário.',
    ].join('\n'))
    .setTimestamp(new Date(review.created_at));
}

async function saveReview(interaction, ticketId) {
  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.status !== 'closed' || ticket.user_id !== interaction.user.id) {
    throw new Error('Esta avaliação não corresponde a um ticket encerrado seu.');
  }
  if (db.prepare('SELECT 1 FROM ticket_reviews WHERE ticket_id = ?').get(ticket.id)) {
    await interaction.reply({ content: 'Este ticket já recebeu uma avaliação.', ephemeral: true });
    return;
  }
  const selection = getSetting(ticket.guild_id, `review_pending_${ticket.id}`);
  const validatedRating = Number(selection);
  if (!Number.isInteger(validatedRating) || validatedRating < 1 || validatedRating > 5) {
    throw new Error('A nota selecionada não é válida. Reabra a solicitação de avaliação.');
  }
  const comment = interaction.fields.getTextInputValue('comment').trim().slice(0, 1000);
  const createdAt = new Date().toISOString();
  const guild = interaction.guild || await interaction.client.guilds.fetch(ticket.guild_id).catch(() => null);
  if (!guild) throw new Error('O servidor deste ticket não está acessível para registrar a avaliação.');
  const channelName = ticket.channel_id
    ? (await getGuildChannel(guild, ticket.channel_id))?.name || `ticket-${ticket.id}`
    : `ticket-${ticket.id}`;
  const review = {
    ticket_id: ticket.id, guild_id: ticket.guild_id, channel_id: ticket.channel_id,
    channel_name: channelName, category: ticket.category, rating: validatedRating,
    user_id: interaction.user.id, attendant_id: ticket.assigned_to, comment, created_at: createdAt,
  };
  db.prepare(`
    INSERT INTO ticket_reviews
      (ticket_id, guild_id, channel_id, channel_name, category, rating, user_id, attendant_id, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.ticket_id, review.guild_id, review.channel_id, review.channel_name,
    review.category, review.rating, review.user_id, review.attendant_id,
    review.comment, review.created_at,
  );
  setSetting(ticket.guild_id, `review_pending_${ticket.id}`, null);
  const settings = getTicketSettings(ticket.guild_id);
  const reviewChannel = await getGuildChannel(guild, settings.reviewChannelId);
  let published = false;
  if (!reviewChannel?.isTextBased()) {
    recordError({ service: 'tickets', step: 'publicar avaliação', error: new Error('Canal de avaliações não configurado ou inacessível.') });
  } else {
    try {
      requireBotPermissions(reviewChannel, guild.members.me, [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      ]);
      await reviewChannel.send({
        embeds: [renderReviewEmbed(review, guild)],
        allowedMentions: { users: [review.user_id, ...(review.attendant_id ? [review.attendant_id] : [])] },
      });
      published = true;
    } catch (error) {
      recordError({ service: 'tickets', step: 'publicar avaliação', error });
    }
  }
  await recordTicketLog(guild, 'avaliação', {
    ticket: ticket.id, nota: validatedRating, usuário: interaction.user.id,
    atendente: ticket.assigned_to || 'Não identificado', comentário: comment, data: createdAt,
  });
  await interaction.reply({
    content: published
      ? 'Sua avaliação foi enviada com sucesso! Obrigado pelo feedback. ☁️'
      : 'Sua avaliação foi registrada, mas não foi possível publicá-la no canal de feedback. A equipe foi informada.',
    ephemeral: Boolean(interaction.guildId),
  });
}

async function handleRating(interaction, ticketId) {
  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.status !== 'closed' || ticket.user_id !== interaction.user.id) {
    throw new Error('Esta solicitação de avaliação não é válida.');
  }
  if (db.prepare('SELECT 1 FROM ticket_reviews WHERE ticket_id = ?').get(ticket.id)) {
    await interaction.reply({ content: 'Este ticket já recebeu uma avaliação.', ephemeral: true });
    return;
  }
  const rating = Number(interaction.values[0]);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('A nota deve ser um número de 1 a 5.');
  setSetting(ticket.guild_id, `review_pending_${ticket.id}`, rating);
  await submitReview(interaction, ticket.id);
}

async function sendTicketTranscript(interaction, ticket) {
  requireTicketStaff(interaction, ticket);
  const current = getTicketById(ticket.id);
  const text = current.transcript_text || await makeTranscript(interaction.guild, current);
  if (current.status === 'closed' && !current.transcript_text) {
    db.prepare('UPDATE tickets SET transcript_text = ?, transcript_state = ? WHERE id = ?')
      .run(text, 'saved_in_database', current.id);
  }
  await interaction.reply({
    files: [transcriptAttachment(current, text)],
    ephemeral: true,
  });
}

function ticketStats(guildId) {
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS active
    FROM tickets WHERE guild_id = ?
  `).get(guildId);
  const categories = db.prepare(`
    SELECT category, COUNT(*) AS count FROM tickets WHERE guild_id = ? GROUP BY category
  `).all(guildId);
  const assignees = db.prepare(`
    SELECT assigned_to, COUNT(*) AS count FROM tickets
    WHERE guild_id = ? AND assigned_to IS NOT NULL GROUP BY assigned_to ORDER BY count DESC LIMIT 10
  `).all(guildId);
  const reviewSummary = db.prepare(`
    SELECT COUNT(*) AS count, AVG(rating) AS average FROM ticket_reviews WHERE guild_id = ?
  `).get(guildId);
  const distribution = db.prepare(`
    SELECT rating, COUNT(*) AS count FROM ticket_reviews WHERE guild_id = ? GROUP BY rating
  `).all(guildId);
  return { counts, categories, assignees, reviewSummary, distribution };
}

function statsEmbed(guildId) {
  const stats = ticketStats(guildId);
  const labels = Object.fromEntries(Object.entries(CATEGORIES).map(([key, value]) => [key, value.label]));
  const categoryText = stats.categories.length
    ? stats.categories.map((row) => `• ${labels[row.category] || row.category}: ${row.count}`).join('\n')
    : 'Sem dados disponíveis.';
  const attendantText = stats.assignees.length
    ? stats.assignees.map((row) => `• <@${row.assigned_to}>: ${row.count}`).join('\n')
    : 'Sem dados disponíveis.';
  const ratingText = stats.reviewSummary.count
    ? `Média: ${stats.reviewSummary.average.toFixed(2)}/5 (${stats.reviewSummary.count} avaliações)\n`
      + [1, 2, 3, 4, 5].map((rating) => `• ${rating} ⭐: ${stats.distribution.find((row) => row.rating === rating)?.count || 0}`).join('\n')
    : 'Sem avaliações disponíveis.';
  return new EmbedBuilder().setColor(0xF2F2F2).setTitle('Estatísticas de tickets')
    .addFields(
      { name: 'Tickets criados', value: String(stats.counts.total || 0), inline: true },
      { name: 'Encerrados', value: String(stats.counts.closed || 0), inline: true },
      { name: 'Em andamento', value: String(stats.counts.active || 0), inline: true },
      { name: 'Por categoria', value: categoryText },
      { name: 'Atendimentos assumidos', value: attendantText },
      { name: 'Avaliações', value: ratingText },
    ).setTimestamp();
}

async function showReviews(interaction) {
  const settings = getTicketSettings(interaction.guildId);
  if (!canManage(interaction.member, interaction.user.id, settings)) {
    throw new Error('A consulta de avaliações é restrita à equipe administrativa autorizada.');
  }
  const rows = db.prepare(`
    SELECT channel_name, category, rating, user_id, attendant_id, comment, created_at
    FROM ticket_reviews WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(interaction.guildId);
  const description = rows.length ? rows.map((review) => (
    `• **${review.channel_name}** — ${'⭐'.repeat(review.rating)} (${review.rating}/5)\n`
    + `Usuário: <@${review.user_id}> • Atendente: ${review.attendant_id ? `<@${review.attendant_id}>` : 'Não identificado'}\n`
    + `${sanitize(review.comment || 'Sem comentário').slice(0, 250)}`
  )).join('\n\n').slice(0, 3900) : 'Sem avaliações disponíveis.';
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(0xF2F2F2).setTitle('Avaliações recentes').setDescription(description)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function configureTickets(interaction) {
  const settings = getTicketSettings(interaction.guildId);
  if (!canConfigure(interaction.member, interaction.user.id, settings)) {
    throw new Error('Somente a equipe administrativa autorizada ou o proprietário pode configurar tickets.');
  }
  const options = interaction.options;
  const updates = {};
  const category = options.getChannel('categoria');
  if (category) {
    if (category.guildId !== interaction.guildId || category.type !== ChannelType.GuildCategory) throw new Error('A categoria deve pertencer a este servidor.');
    updates.categoryId = category.id;
  }
  for (const [optionName, key] of [
    ['logs', 'logsChannelId'], ['transcricoes', 'transcriptChannelId'],
    ['avaliacoes', 'reviewChannelId'], ['horarios', 'hoursChannelId'],
    ['ajuda', 'helpChannelId'], ['logs_admin', 'adminLogsChannelId'],
    ['logs_compras', 'purchaseLogsChannelId'],
  ]) {
    const channel = options.getChannel(optionName);
    if (channel) {
      if (channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) throw new Error(`O canal "${optionName}" deve ser de texto neste servidor.`);
      requireBotPermissions(channel, interaction.guild.members.me, [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      ]);
      updates[key] = channel.id;
    }
  }
  const role = options.getRole('cargo');
  const action = options.getString('acao_cargo');
  if (Boolean(role) !== Boolean(action)) throw new Error('Para alterar cargos, informe cargo e acao_cargo juntos.');
  if (role) {
    if (role.guild.id !== interaction.guildId || role.id === interaction.guild.roles.everyone.id) throw new Error('Selecione um cargo válido deste servidor.');
    const botMember = interaction.guild.members.me;
    if (botMember && role.position >= botMember.roles.highest.position) throw new Error('O cargo precisa estar abaixo do maior cargo do bot.');
    const roleIds = settings.staffRoleIds.filter((id) => action !== 'remove' || id !== role.id);
    if (action === 'add') roleIds.push(role.id);
    if (!roleIds.length) throw new Error('Ao menos um cargo de equipe deve permanecer autorizado.');
    updates.staffRoleIds = [...new Set(roleIds)];
  }
  const limit = options.getInteger('limite');
  if (limit !== null) updates.maxOpenPerUser = limit;
  const closeBehavior = options.getString('fechamento');
  if (closeBehavior) updates.closeBehavior = closeBehavior;
  const title = options.getString('painel_titulo');
  if (title) updates.panelTitle = title.trim();
  const message = options.getString('painel_texto');
  if (message !== null) updates.panelMessage = message.trim();
  if (!Object.keys(updates).length) throw new Error('Informe ao menos uma opção para configurar.');
  const next = { ...settings, ...updates };
  setTicketSettings(interaction.guildId, next);
  await recordTicketLog(interaction.guild, 'configuração alterada', {
    executor: interaction.user.id, alterações: Object.keys(updates),
  });
  await interaction.reply({
    content: `Configuração de tickets atualizada: ${Object.keys(updates).join(', ')}.`,
    ephemeral: true,
  });
}

export async function handleTicketSlash(interaction) {
  requireGuild(interaction.guild);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'painel') {
    const result = await publishTicketPanel(interaction.guild, interaction.member, interaction.user.id, interaction.channel);
    await interaction.reply({
      content: `Painel de atendimento ${result.updated ? 'atualizado' : 'publicado'} em <#${result.channel.id}>.`,
      ephemeral: true,
    });
    if (!await getGuildChannel(interaction.guild, getTicketSettings(interaction.guildId).hoursChannelId)) {
      await interaction.followUp({
        content: `Atenção: o canal de horários configurado (${getTicketSettings(interaction.guildId).hoursChannelId}) não foi encontrado neste servidor. Ajuste com /ticket configurar horarios.`,
        ephemeral: true,
      });
    }
    return;
  }
  if (subcommand === 'configurar') return configureTickets(interaction);
  if (subcommand === 'adicionar' || subcommand === 'remover') {
    return addOrRemoveParticipant(interaction, subcommand === 'adicionar' ? 'add' : 'remove', interaction.options.getUser('usuario', true));
  }
  if (subcommand === 'assumir') {
    const ticket = getTicketByChannel(interaction.guildId, interaction.channelId);
    if (!ticket) throw new Error('Use este comando dentro de um ticket.');
    return assumeTicket(interaction, ticket);
  }
  if (subcommand === 'fechar') {
    const ticket = getTicketByChannel(interaction.guildId, interaction.channelId);
    if (!ticket) throw new Error('Use este comando dentro de um ticket.');
    return requestClose(interaction, ticket.id, interaction.options.getString('motivo') || '');
  }
  if (subcommand === 'transcript') {
    const ticket = getTicketByChannel(interaction.guildId, interaction.channelId);
    if (!ticket) throw new Error('Use este comando dentro de um ticket.');
    return sendTicketTranscript(interaction, ticket);
  }
  if (subcommand === 'estatisticas') {
    const settings = getTicketSettings(interaction.guildId);
    if (!canManage(interaction.member, interaction.user.id, settings)) throw new Error('Estatísticas restritas à equipe administrativa autorizada.');
    await interaction.reply({ embeds: [statsEmbed(interaction.guildId)], ephemeral: true });
    return;
  }
  if (subcommand === 'avaliacao') return showReviews(interaction);
  throw new Error('Subcomando de ticket inválido.');
}

export async function handleTicketInteraction(interaction) {
  const id = interaction.customId;
  if (interaction.isButton() && id.startsWith('review:start:')) {
    const ticketId = id.split(':')[2];
    const ticket = getTicketById(ticketId);
    if (!ticket || ticket.status !== 'closed' || ticket.user_id !== interaction.user.id) {
      throw new Error('Esta solicitação de avaliação não é válida para sua conta.');
    }
    if (db.prepare('SELECT 1 FROM ticket_reviews WHERE ticket_id = ?').get(ticket.id)) {
      await interaction.reply({ content: 'Este ticket já recebeu uma avaliação.', ephemeral: Boolean(interaction.guildId) });
      return true;
    }
    await interaction.update({
      content: `Como foi seu atendimento no ticket \`${ticket.id}\`? Selecione uma nota para continuar.`,
      embeds: [],
      components: [reviewRatingMenu(ticket.id)],
    });
    return true;
  }
  if (interaction.isStringSelectMenu() && id === 'ticket:select') {
    return showTicketForm(interaction, interaction.values[0]);
  }
  if (interaction.isModalSubmit() && id.startsWith('ticket:form:')) {
    const category = id.split(':')[2];
    return createTicket(interaction, category, formFromInteraction(interaction, category));
  }
  if (interaction.isModalSubmit() && id.startsWith('review:comment:')) {
    return saveReview(interaction, id.split(':')[2]);
  }
  if (interaction.isStringSelectMenu() && id.startsWith('review:rating:')) {
    return handleRating(interaction, id.split(':')[2]);
  }
  if (!interaction.isButton() || !id.startsWith('ticket:')) return false;
  const [, action, ticketId, extra] = id.split(':');
  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.guild_id !== interaction.guildId || ticket.channel_id !== interaction.channelId) {
    await interaction.reply({ content: 'Este ticket não está mais disponível neste canal.', ephemeral: true });
    return true;
  }
  if (action === 'claim') return assumeTicket(interaction, ticket);
  if (action === 'info') return showTicketInfo(interaction, ticket);
  if (action === 'hours') {
    const channel = await getGuildChannel(interaction.guild, getTicketSettings(ticket.guild_id).hoursChannelId);
    await interaction.reply({
      content: channel ? `Consulte os horários de atendimento em <#${channel.id}>.` : 'O canal de horários não está configurado ou está inacessível. Avise a administração.',
      ephemeral: true,
    });
    return true;
  }
  if (action === 'close') return requestClose(interaction, ticket.id);
  if (action === 'close-cancel') {
    await interaction.update({ content: 'Encerramento cancelado.', components: [] });
    return true;
  }
  if (action === 'close-confirm') {
    requireTicketStaff(interaction, ticket);
    await interaction.deferUpdate();
    const reason = getSetting(ticket.guild_id, `close_reason_${ticket.id}`, '') || '';
    setSetting(ticket.guild_id, `close_reason_${ticket.id}`, null);
    const result = await closeTicket(interaction.guild, ticket, interaction.user.id, reason);
    await interaction.followUp({
      content: `Ticket encerrado. Transcrição: ${result.transcriptState}.`,
      ephemeral: true,
    });
    return true;
  }
  return false;
}

export function handlesTicketInteraction(interaction) {
  return interaction.customId?.startsWith('ticket:')
    || interaction.customId?.startsWith('review:');
}

export async function handleTicketPrefix(message, args) {
  requireGuild(message.guild);
  const respond = (content) => message.reply({ content, allowedMentions: { parse: [] } });
  const [subcommand, ...rest] = args;
  const settings = getTicketSettings(message.guild.id);
  const member = message.member;
  const userId = message.author.id;
  if (subcommand === 'painel') {
    const result = await publishTicketPanel(message.guild, member, userId, message.channel);
    await respond(`Painel de atendimento ${result.updated ? 'atualizado' : 'publicado'} em <#${result.channel.id}>.`);
    return;
  }
  if (subcommand === 'configurar') {
    if (!canConfigure(member, userId, settings)) throw new Error('Você não pode configurar o sistema de tickets.');
    const updates = {};
    const aliases = {
      categoria: ['categoryId', 'category'], logs: ['logsChannelId', 'text'],
      transcricoes: ['transcriptChannelId', 'text'], avaliacoes: ['reviewChannelId', 'text'],
      horarios: ['hoursChannelId', 'text'], ajuda: ['helpChannelId', 'text'],
      logs_admin: ['adminLogsChannelId', 'text'], logs_compras: ['purchaseLogsChannelId', 'text'],
    };
    for (const [key, [setting, type]] of Object.entries(aliases)) {
      const token = rest.find((value) => value.startsWith(`${key}=`));
      if (!token) continue;
      const id = token.slice(key.length + 1).match(/^(?:<#)?(\d+)>?$/)?.[1];
      const channel = await getGuildChannel(message.guild, id);
      const valid = channel && (type === 'category' ? channel.type === ChannelType.GuildCategory : channel.type === ChannelType.GuildText);
      if (!valid) throw new Error(`O canal configurado em ${key} não existe ou é do tipo errado neste servidor.`);
      if (type !== 'category') requireBotPermissions(channel, message.guild.members.me, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
      updates[setting] = channel.id;
    }
    for (const token of rest) {
      const match = token.match(/^(limite|fechamento|cargo|acao_cargo|painel_titulo|painel_texto)=(.+)$/);
      if (!match) continue;
      if (match[1] === 'limite') {
        const value = Number(match[2]);
        if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('O limite deve estar entre 1 e 5.');
        updates.maxOpenPerUser = value;
      } else if (match[1] === 'fechamento') {
        if (!['archive', 'delete'].includes(match[2])) throw new Error('Fechamento deve ser archive ou delete.');
        updates.closeBehavior = match[2];
      } else if (match[1] === 'painel_titulo') updates.panelTitle = match[2].slice(0, 100);
      else if (match[1] === 'painel_texto') updates.panelMessage = match[2].slice(0, 1000);
      else if (match[1] === 'cargo') {
        const id = match[2].match(/^(?:<@&)?(\d+)>?$/)?.[1];
        const role = id ? message.guild.roles.cache.get(id) || await message.guild.roles.fetch(id).catch(() => null) : null;
        if (!role || role.guild.id !== message.guild.id) throw new Error('O cargo não existe neste servidor.');
        if (rest.find((value) => value.startsWith('acao_cargo='))?.split('=')[1] === 'remove') {
          const roleIds = settings.staffRoleIds.filter((roleId) => roleId !== role.id);
          if (!roleIds.length) throw new Error('Ao menos um cargo de equipe deve permanecer.');
          updates.staffRoleIds = roleIds;
        } else updates.staffRoleIds = [...new Set([...settings.staffRoleIds, role.id])];
      }
    }
    if (!Object.keys(updates).length) {
      await respond('Uso: `!red ticket configurar categoria=#categoria logs=#canal transcricoes=#canal avaliacoes=#canal horarios=#canal limite=1 fechamento=archive cargo=@equipe acao_cargo=add painel_titulo=... painel_texto=...`.');
      return;
    }
    setTicketSettings(message.guild.id, { ...settings, ...updates });
    await recordTicketLog(message.guild, 'configuração alterada', { executor: userId, alterações: Object.keys(updates) });
    await respond(`Configuração atualizada: ${Object.keys(updates).join(', ')}.`);
    return;
  }
  const ticket = getTicketByChannel(message.guild.id, message.channel.id);
  if (subcommand === 'estatisticas' || subcommand === 'avaliacao') {
    if (!canManage(member, userId, settings)) throw new Error('Consulta restrita à equipe administrativa autorizada.');
    if (subcommand === 'estatisticas') await message.channel.send({ embeds: [statsEmbed(message.guild.id)] });
    else {
      const rows = db.prepare('SELECT channel_name, rating, comment FROM ticket_reviews WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10').all(message.guild.id);
      await respond(rows.length ? rows.map((row) => `${row.channel_name}: ${'⭐'.repeat(row.rating)} ${sanitize(row.comment).slice(0, 150)}`).join('\n') : 'Sem avaliações disponíveis.');
    }
    return;
  }
  if (!ticket) throw new Error('Este comando precisa ser usado dentro de um ticket.');
  if (subcommand === 'assumir') {
    if (!canHandle(member, userId, settings)) throw new Error('Você não possui cargo autorizado para assumir tickets.');
    const result = db.prepare(`
      UPDATE tickets SET assigned_to = ?, status = 'in_progress'
      WHERE id = ? AND status IN ('open', 'in_progress') AND (assigned_to IS NULL OR assigned_to = ?)
    `).run(userId, ticket.id, userId);
    if (!result.changes) throw new Error('O ticket está encerrado ou já foi assumido por outra pessoa.');
    await updateTicketMessage(message.guild, getTicketById(ticket.id));
    await respond('Você assumiu este atendimento.');
    await recordTicketLog(message.guild, 'atendimento assumido', { ticket: ticket.id, atendente: userId });
    return;
  }
  if (subcommand === 'adicionar' || subcommand === 'remover') {
    const match = rest[0]?.match(/^<@!?(\d+)>$/);
    const user = match ? await message.client.users.fetch(match[1]).catch(() => null) : null;
    const fakeInteraction = {
      guild: message.guild, guildId: message.guild.id, channelId: message.channel.id,
      member, user: { id: userId },
      reply: (payload) => respond(payload.content),
    };
    if (!user) throw new Error('Informe um usuário válido por menção.');
    return addOrRemoveParticipant(fakeInteraction, subcommand === 'adicionar' ? 'add' : 'remove', user);
  }
  if (subcommand === 'transcript') {
    if (!canHandle(member, userId, settings)) throw new Error('Transcrições são restritas à equipe autorizada.');
    const text = ticket.transcript_text || await makeTranscript(message.guild, ticket);
    await message.author.send({ files: [transcriptAttachment(ticket, text)] });
    await respond('Transcrição enviada por mensagem privada.');
    return;
  }
  if (subcommand === 'fechar') {
    if (!canHandle(member, userId, settings)) throw new Error('Você não possui cargo autorizado para fechar tickets.');
    const confirmationCommands = new Set([`${config.prefix} ticket confirmar`]);
    await respond(`Confirme o fechamento respondendo \`${config.prefix} ticket confirmar\` nos próximos 60 segundos.`);
    const confirmation = await message.channel.awaitMessages({
      filter: (candidate) => candidate.author.id === userId
        && confirmationCommands.has(candidate.content.trim().toLowerCase()),
      max: 1, time: 60_000,
    });
    if (!confirmation.size) {
      await respond('Fechamento cancelado por tempo esgotado.');
      return;
    }
    const result = await closeTicket(message.guild, ticket, userId, rest.join(' '));
    await respond(`Ticket encerrado. Transcrição: ${result.transcriptState}.`);
    return;
  }
  await respond('Comandos: `painel`, `configurar`, `adicionar @usuário`, `remover @usuário`, `assumir`, `fechar`, `transcript`, `estatisticas`, `avaliacao`.');
}

export async function executeConfirmedClose(interaction, ticketId, reason = '') {
  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.guild_id !== interaction.guildId || ticket.channel_id !== interaction.channelId) {
    throw new Error('Este ticket não está mais disponível.');
  }
  requireTicketStaff(interaction, ticket);
  return closeTicket(interaction.guild, ticket, interaction.user.id, reason);
}

export async function saveSelectedRating(interaction, ticketId, rating) {
  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.user_id !== interaction.user.id || ticket.status !== 'closed') throw new Error('Avaliação inválida.');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('A nota deve estar entre 1 e 5.');
  if (db.prepare('SELECT 1 FROM ticket_reviews WHERE ticket_id = ?').get(ticket.id)) throw new Error('Este ticket já foi avaliado.');
  setSetting(ticket.guild_id, `review_pending_${ticket.id}`, rating);
}

export async function handleReviewForm(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('review:comment:')) return false;
  return saveReview(interaction, interaction.customId.split(':')[2]);
}
