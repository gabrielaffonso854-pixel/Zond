import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config, isAllowedGuild } from './config.js';
import { handleClearButton, handleClearSlash, handleOnlineClearMessage } from './clear.js';
import { getNewsSettings, handleNewsSlash, startNewsService } from './news.js';
import { askNvidia } from './ai.js';
import { getAiStatus } from './ai.js';
import {
  getPublishedPanel,
  recentErrors,
  recentSystemLogs,
  recordPublishedPanel,
  setSetting,
} from './db.js';
import { recordError, sanitize } from './errors.js';
import { fetchDiscordServer } from './huehue.js';
import {
  applyVote,
  checkPlanPermissions,
  createAssistantPlan,
  executePlan,
  planPreview,
  registerPendingPlan,
  takePendingPlan,
} from './guild-actions.js';
import {
  buildAntiPanel,
  canConfigure,
  canReadModerationLogs,
  getAntiConfig,
  PROTECTIONS,
  PROTECTION_LABELS,
  sendGuildLog,
  updateAntiConfig,
} from './anti.js';
import { isAdmin, parseAntiSlash } from './commands.js';
import {
  buildCentralPanelPayload,
  ensureCentralPanel,
  handleCentralInteraction,
  handlesCentralInteraction,
  isCentralAdmin,
  showCentralPanel,
} from './admin-panel.js';
import {
  handleTicketInteraction,
  handleTicketPrefix,
  handleTicketSlash,
  handlesTicketInteraction,
} from './tickets.js';
import { handleQuestPrefix, handleQuestSlash } from './quests.js';
import {
  handleMissionPrefix,
  handleMissionSlash,
  startMissionService,
  updateMissionSettings,
} from './missions.js';
import {
  handleStoreInteraction,
  handleStorePrefix,
  handleStoreSlash,
  handlesStoreInteraction,
  startStoreService,
} from './store.js';

const COLOR = 0xC8102E;
const OFFICIAL = {
  website: 'https://zondesystems.netlify.app',
  profile: 'https://guns.lol/isekay.zjk',
  invite: 'https://discord.gg/qcSATA8Mq',
};
const activeAiReplies = new Set();
const activePlans = new Set();
const categoryContent = {
  anti: {
    title: '🛡️ Anti',
    description: [
      '• `/anti status` — consultar proteções',
      '• `/anti config` — painel de ativação',
      '• `/anti raid on|off`, `/anti spam on|off`',
      '• `/anti mention on|off`, `/anti webhook on|off`',
      '• `/anti joins on|off`, `/anti links on|off`',
      '• `/anti links domain` e `exception` — listas de domínio e exceções',
      '• `/anti logs`, `/anti logchannel` — consultar/configurar registros',
    ].join('\n'),
  },
  ticket: {
    title: '🎫 Ticket',
    description: [
      '• `/ticket painel` — publicar ou atualizar o painel',
      '• `/ticket configurar` — ajustar canais, cargos, limites e fechamento',
      '• `/ticket adicionar` e `/ticket remover` — gerenciar participantes',
      '• `/ticket assumir`, `/ticket fechar` e `/ticket transcript`',
      '• `/ticket estatisticas` e `/ticket avaliacao` — consultas restritas',
      '• Prefixo: `!red ticket <comando>`',
    ].join('\n'),
  },
  quests: {
    title: '🎯 Missões',
    description: [
      '• `/quest listar` — consultar missões do servidor',
      '• `/quest concluir` — registrar sua conclusão no Zond',
      '• `/quest criar` — cadastrar missão (Gerenciar servidor)',
      '• Prefixo: `!red quest listar|concluir|criar`',
      '• Conclusões não alteram quests oficiais do Discord.',
    ].join('\n'),
  },
  ia: {
    title: '🤖 IA',
    description: [
      '• `/ia mensagem` ou `!red <mensagem>` — conversar com a IA',
      '• `/iacriar` ou `!red iacriar <pedido>` — propor e confirmar ações seguras no servidor',
    ].join('\n'),
  },
  logs: {
    title: '📋 Logs',
    description: [
      '• `/errorver` — erros técnicos recentes (somente proprietário/administradores)',
      '• `/anti logs` — eventos recentes de proteção',
      '• `/anti logchannel` — configurar o canal de logs',
    ].join('\n'),
  },
};

function mainHelpEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('RedCloud • Central de ajuda')
    .setDescription('Selecione uma categoria para consultar os recursos disponíveis.')
    .addFields(
      { name: '🛡️ Anti', value: 'Proteção e moderação', inline: true },
      { name: '🎫 Ticket', value: 'Atendimento', inline: true },
      { name: '🤖 IA', value: 'Inteligência artificial', inline: true },
      { name: '📋 Logs', value: 'Registros e diagnóstico', inline: true },
      { name: '🎯 Missões', value: 'Missões do servidor', inline: true },
    );
}

function helpButtons() {
  return [new ActionRowBuilder().addComponents(
    ...Object.keys(categoryContent).map((category) => new ButtonBuilder()
      .setCustomId(`help:${category}`)
      .setLabel(categoryContent[category].title.replace(/^\S+\s/, ''))
      .setStyle(ButtonStyle.Secondary)),
  )];
}

function backButton() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help:home').setLabel('Voltar ao menu').setStyle(ButtonStyle.Secondary),
  )];
}

function invitePayload() {
  return {
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Convite oficial da RedCloud')
      .setDescription(`Acesse nosso servidor pelo convite oficial:\n${OFFICIAL.invite}`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Entrar no servidor').setURL(OFFICIAL.invite),
    )],
  };
}

function infoPayload() {
  return {
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('RedCloud')
      .setDescription('Soluções digitais e tecnologia com identidade própria.')
      .addFields(
        { name: 'Site oficial', value: `[zondesystems.netlify.app](${OFFICIAL.website})` },
        { name: 'Perfil oficial', value: `[guns.lol/isekay.zjk](${OFFICIAL.profile})` },
        { name: 'Servidor', value: `[discord.gg/qcSATA8Mq](${OFFICIAL.invite})` },
      )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Site').setURL(OFFICIAL.website),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Perfil').setURL(OFFICIAL.profile),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Entrar no Discord').setURL(OFFICIAL.invite),
    )],
  };
}

function chunkMessage(text, maxLength = 1900) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength);
    if (cut < Math.floor(maxLength * 0.5)) cut = maxLength;
    if (cut > 0 && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendChunks(send, text) {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) await send({ content: chunk, allowedMentions: { parse: [] } });
}

async function sendDiscordServerInfo(send) {
  const server = await fetchDiscordServer();
  await sendChunks(send, JSON.stringify(server, null, 2));
}

function antiStatusPayload(guildId) {
  const anti = getAntiConfig(guildId);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Estado das proteções')
    .setDescription(PROTECTIONS
      .map((key) => `• **${PROTECTION_LABELS[key]}:** ${anti.enabled[key] ? 'ON' : 'OFF'}`)
      .join('\n'))
    .setFooter({ text: 'Proteções desativadas não aplicam ações. Nenhuma punição automática está configurada.' });
}

function recentLogsPayload(guildId) {
  const records = recentSystemLogs(guildId, 10);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Eventos recentes do servidor')
    .setDescription(records.length
      ? records.map((row) => {
        const details = JSON.parse(row.details);
        const excerpt = Object.entries(details).map(([key, value]) => (
          `${key}: ${sanitize(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 100)}`
        )).join(' • ');
        return `• <t:${Math.floor(Date.parse(row.created_at) / 1000)}:R> **${row.module} / ${row.event_type}**\n${excerpt}`;
      }).join('\n\n').slice(0, 3900)
      : 'Nenhum evento registrado. Ainda não há registros para este servidor.');
}

function errorReportEmbed() {
  const errors = recentErrors(10);
  const description = errors.length ? errors.map((entry) => (
    `• **${entry.created_at}** — ${entry.service} / ${entry.step}\n`
    + `Tipo: ${entry.error_type}${entry.http_status ? ` • HTTP ${entry.http_status}` : ''}\n`
    + `${sanitize(entry.message)}${entry.request_id ? ` • ID: ${entry.request_id}` : ''}`
  )).join('\n\n').slice(0, 3900) : 'Nenhum erro recente foi registrado.';
  return new EmbedBuilder().setColor(COLOR).setTitle('Diagnóstico técnico recente').setDescription(description);
}

function hasAnyPermission(channel, member, permissions) {
  return permissions.every((permission) => channel.permissionsFor(member)?.has(permission));
}

async function authorizeAdmin(interactionOrMessage) {
  const member = interactionOrMessage.member;
  if (canConfigure(member)) return true;
  const text = 'Você precisa da permissão **Gerenciar servidor** para alterar ou consultar esta configuração.';
  if (interactionOrMessage.isChatInputCommand?.() || interactionOrMessage.isButton?.()) {
    if (interactionOrMessage.deferred || interactionOrMessage.replied) {
      await interactionOrMessage.followUp({ content: text, ephemeral: true });
    } else {
      await interactionOrMessage.reply({ content: text, ephemeral: true });
    }
  } else {
    await interactionOrMessage.reply({ content: text });
  }
  return false;
}

function normalizeDomain(value) {
  let domain = value.trim().toLowerCase();
  if (domain.includes('://')) {
    const url = new URL(domain);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/'
      || url.search || url.hash || url.username || url.password || url.port) {
      throw new Error('Informe somente um domínio, sem caminho, porta ou credenciais.');
    }
    domain = url.hostname.toLowerCase();
  }
  domain = domain.replace(/\.$/, '');
  if (!domain || domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(domain)) {
    throw new Error('Informe um domínio válido, sem caminho ou credenciais.');
  }
  return domain;
}

async function setProtection(guild, member, protection, enabled, send) {
  if (!await authorizeAdmin({ member, reply: send, isChatInputCommand: () => false, isButton: () => false })) return;
  updateAntiConfig(guild.id, { enabled: { [protection]: enabled } });
  await send({ content: `${PROTECTION_LABELS[protection]} ${enabled ? 'ativado' : 'desativado'}.` });
  await sendGuildLog(guild, 'anti', 'configuração alterada', {
    executor: member.id,
    proteção: protection,
    estado: enabled ? 'ON' : 'OFF',
  });
}

async function configureMissionChannel(guild, member, channel, key, send) {
  if (!guild) {
    await send({ content: 'A configuração de missões só pode ser usada em um servidor.' });
    return;
  }
  if (!await authorizeAdmin({ member, reply: send, isChatInputCommand: () => false, isButton: () => false })) return;
  if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
    throw new Error('Selecione um canal de texto deste servidor.');
  }
  const botMember = guild.members.me;
  if (!hasAnyPermission(channel, botMember, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new Error('O bot precisa de permissões para visualizar e enviar mensagens no canal.');
  }
  setSetting(guild.id, key, channel.id);
  updateMissionSettings(guild.id, key === 'missions_available_channel'
    ? { availableChannelId: channel.id }
    : { unavailableChannelId: channel.id });
  await send({
    content: `Canal configurado: <#${channel.id}>.\nA publicação automática permanece conforme a configuração em \`/missoes configurar\`; nenhuma missão será inventada.`,
  });
  await sendGuildLog(guild, 'missoes', 'canal configurado', { executor: member.id, canal: channel.id, configuração: key });
}

async function startAssistantPlan(prompt, guild, member, channelId, respond) {
  const key = `${guild?.id}:${member?.id}:${channelId}:${prompt}`;
  if (activePlans.has(key)) {
    await respond({ content: 'Este pedido já está sendo processado. Aguarde a prévia atual antes de tentar novamente.' });
    return;
  }
  activePlans.add(key);
  try {
    const plan = await createAssistantPlan(prompt, guild);
    checkPlanPermissions(guild, member, plan);
    const id = registerPendingPlan(member.id, guild.id, channelId, plan);
    await respond({
      embeds: [planPreview(plan)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`plan:confirm:${id}`).setLabel('Confirmar e executar').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`plan:cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
      )],
    });
  } catch (error) {
    const message = error.message.includes('NVIDIA_API_KEY') || error.message.includes('NVIDIA')
      ? 'Não foi possível obter um plano da IA. Nenhuma alteração foi realizada; tente novamente mais tarde.'
      : error.message;
    await respond({ content: message });
  } finally {
    activePlans.delete(key);
  }
}

async function sendAiResponse(prompt, userId, channel, send) {
  const key = `${channel.id}:${userId}:${prompt}`;
  if (activeAiReplies.has(key)) return false;
  activeAiReplies.add(key);
  let typingTimer;
  let step = 'indicador de digitação';
  try {
    if (channel.sendTyping) {
      try {
        await channel.sendTyping();
      } catch (error) {
        recordError({ service: 'discord', step, error });
      }
      typingTimer = setInterval(async () => {
        try {
          await channel.sendTyping();
        } catch (error) {
          recordError({ service: 'discord', step, error });
          clearInterval(typingTimer);
        }
      }, 8000);
      typingTimer.unref?.();
    }
    step = 'solicitação NVIDIA';
    const response = await askNvidia(prompt, { requestKey: key });
    step = 'envio da resposta';
    await sendChunks(send, response);
    return true;
  } catch (error) {
    if (step === 'envio da resposta') recordError({ service: 'discord', step, error });
    throw error;
  } finally {
    if (typingTimer) clearInterval(typingTimer);
    activeAiReplies.delete(key);
  }
}

async function handleAiSlash(interaction) {
  const prompt = interaction.options.getString('mensagem', true);
  await interaction.deferReply();
  try {
    let first = true;
    const sent = await sendAiResponse(prompt, interaction.user.id, interaction.channel, (payload) => {
      if (first) {
        first = false;
        return interaction.editReply(payload);
      }
      return interaction.followUp(payload);
    });
    if (!sent) await interaction.editReply({ content: 'Uma solicitação idêntica já está sendo processada.' });
  } catch {
    await interaction.editReply({ content: 'A IA está temporariamente indisponível. Nenhuma resposta foi gerada.' });
  }
}

async function handleCreateModal(interaction) {
  const prompt = interaction.fields.getTextInputValue('request').trim();
  await interaction.deferReply({ ephemeral: true });
  await startAssistantPlan(prompt, interaction.guild, interaction.member, interaction.channelId, (payload) => interaction.editReply(payload));
}

async function handleSuggestionModal(interaction) {
  const [, , panelMessageId] = interaction.customId.split(':');
  const panel = getPublishedPanel(interaction.guildId, panelMessageId);
  if (!panel || panel.panel_type !== 'suggestion') {
    await interaction.reply({ content: 'Este painel de sugestões não está mais disponível.', ephemeral: true });
    return;
  }
  const channel = interaction.guild.channels.cache.get(panel.channel_id);
  if (!channel?.isTextBased() || !hasAnyPermission(channel, interaction.guild.members.me, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])) {
    await interaction.reply({ content: 'Não foi possível publicar a sugestão neste canal.', ephemeral: true });
    return;
  }
  const text = interaction.fields.getTextInputValue('suggestion').trim();
  if (text.length < 5 || text.length > 1500) {
    await interaction.reply({ content: 'A sugestão deve ter entre 5 e 1.500 caracteres.', ephemeral: true });
    return;
  }
  const suggestion = await channel.send({
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Nova sugestão')
      .setDescription(text)
      .addFields({ name: 'Votos', value: '👍 0 • 👎 0' })
      .setFooter({ text: `Enviada por ${interaction.user.tag}` })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vote:up').setLabel('Apoiar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('vote:down').setLabel('Não apoiar').setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { parse: [] },
  });
  recordPublishedPanel(interaction.guildId, channel.id, suggestion.id, 'suggestion-entry');
  await interaction.reply({ content: 'Sugestão publicada para votação.', ephemeral: true });
}

async function handleAntiSettingsModal(interaction) {
  if (!await authorizeAdmin(interaction)) return;
  const fields = [
    ['joinLimit', 'join_limit', 2, 100],
    ['joinWindowSeconds', 'join_window', 5, 120],
    ['spamMessageLimit', 'spam_limit', 2, 30],
    ['spamWindowSeconds', 'spam_window', 3, 60],
    ['mentionLimit', 'mention_limit', 2, 50],
  ];
  const values = {};
  for (const [key, field, min, max] of fields) {
    const raw = interaction.fields.getTextInputValue(field).trim();
    if (!/^\d+$/.test(raw)) throw new Error(`O limite "${field}" deve ser numérico.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`O campo "${field}" deve estar entre ${min} e ${max}.`);
    }
    values[key] = value;
  }
  updateAntiConfig(interaction.guildId, values);
  await interaction.reply({ content: 'Limites atualizados. As proteções continuam sem punições automáticas.', ephemeral: true });
  await sendGuildLog(interaction.guild, 'anti', 'limites alterados', { executor: interaction.user.id, ...values });
}

async function handleSlash(interaction) {
  switch (interaction.commandName) {
    case 'painel':
      await showCentralPanel(interaction);
      return;
    case 'status':
      await interaction.reply({ embeds: [buildCentralPanelPayload(interaction.guild, 'overview').embeds[0]], ephemeral: true });
      return;
    case 'discordinvite':
      await interaction.reply(invitePayload());
      return;
    case 'discordver': {
      await interaction.deferReply({ ephemeral: true });
      let first = true;
      await sendDiscordServerInfo((payload) => {
        if (first) {
          first = false;
          return interaction.editReply(payload);
        }
        return interaction.followUp({ ...payload, ephemeral: true });
      });
      return;
    }
    case 'ver':
      await interaction.reply({ embeds: [mainHelpEmbed()], components: helpButtons(), ephemeral: true });
      return;
    case 'zonde': {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'info') await interaction.reply(infoPayload());
      else await interaction.reply({ content: `<@${config.ownerId}>`, allowedMentions: { users: [config.ownerId] } });
      return;
    }
    case 'ia':
      await handleAiSlash(interaction);
      return;
    case 'iacriar': {
      const modal = new ModalBuilder().setCustomId('iacriar:modal').setTitle('Criação assistida')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('request').setLabel('O que você quer criar ou configurar?')
            .setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1500).setRequired(true),
        ));
      await interaction.showModal(modal);
      return;
    }
    case 'errorver':
      await showErrors(interaction);
      return;
    case 'anti':
      await handleAntiSlash(interaction);
      return;
    case 'clear':
      await handleClearSlash(interaction);
      return;
    case 'jornal':
      await handleNewsSlash(interaction);
      return;
    case 'news': {
      const settings = getNewsSettings(interaction.guildId);
      await interaction.reply({
        content: `News: **${settings.enabled ? 'ativo' : 'inativo'}**\nCanal: ${settings.channelId ? `<#${settings.channelId}>` : 'não configurado'}\nIntervalo: **${settings.intervalMinutes} minuto(s)**\nPróxima consulta: ${settings.nextAttemptAt ? `<t:${Math.floor(settings.nextAttemptAt / 1000)}:R>` : 'não agendada'}`,
        ephemeral: true,
      });
      return;
    }
    case 'ticket':
      await handleTicketSlash(interaction);
      return;
    case 'quest':
      await handleQuestSlash(interaction);
      return;
    case 'missoes':
      await handleMissionSlash(interaction);
      return;
    case 'loja':
      await handleStoreSlash(interaction);
      return;
    case 'disponiveis':
    case 'disponíveis':
    case 'indisponiveis':
    case 'indisponíveis': {
      const available = interaction.commandName === 'disponiveis' || interaction.commandName === 'disponíveis';
      await configureMissionChannel(
        interaction.guild,
        interaction.member,
        interaction.options.getChannel('canal', true),
        available ? 'missions_available_channel' : 'missions_unavailable_channel',
        (payload) => interaction.reply({ ...payload, ephemeral: true }),
      );
      return;
    }
    default:
      await interaction.reply({ content: 'Comando não reconhecido.', ephemeral: true });
  }
}

async function handleAntiSlash(interaction) {
  const parsed = parseAntiSlash(interaction);
  if (parsed.subcommand === 'status') {
    await interaction.reply({ embeds: [antiStatusPayload(interaction.guildId)], ephemeral: true });
    return;
  }
  if (!await authorizeAdmin(interaction)) return;
  if (parsed.subcommand === 'config') {
    await interaction.reply({ ...buildAntiPanel(interaction.guildId), ephemeral: true });
    return;
  }
  if (parsed.subcommand === 'logs') {
    if (!canReadModerationLogs(interaction.member)) {
      await interaction.reply({ content: 'Você precisa da permissão **Ver registro de auditoria** para consultar estes registros.', ephemeral: true });
      return;
    }
    await interaction.reply({ embeds: [recentLogsPayload(interaction.guildId)], ephemeral: true });
    return;
  }
  if (parsed.subcommand === 'logchannel') {
    const channel = parsed.channel;
    if (!hasAnyPermission(channel, interaction.guild.members.me, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])) {
      throw new Error('O bot precisa de permissões para visualizar, enviar mensagens e incorporar embeds nesse canal.');
    }
    setSetting(interaction.guildId, 'logs_channel', channel.id);
    await interaction.reply({ content: `Canal de logs configurado para <#${channel.id}>.`, ephemeral: true });
    await sendGuildLog(interaction.guild, 'anti', 'canal de logs configurado', { executor: interaction.user.id, canal: channel.id });
    return;
  }
  if (!parsed.group) throw new Error('Subcomando de proteção inválido.');
  const enabled = parsed.subcommand === 'on';
  if (parsed.group === 'links' && parsed.subcommand === 'domain') {
    const action = interaction.options.getString('acao', true);
    const domain = normalizeDomain(interaction.options.getString('dominio', true));
    const list = interaction.options.getString('lista', true) === 'allowed' ? 'allowedDomains' : 'blockedDomains';
    const current = getAntiConfig(interaction.guildId)[list];
    const domains = action === 'add'
      ? [...new Set([...current, domain])]
      : current.filter((item) => item !== domain);
    if (domains.length > 1000) throw new Error('A lista de domínios atingiu o limite de 1.000 itens.');
    updateAntiConfig(interaction.guildId, { [list]: domains });
    const listLabel = list === 'allowedDomains' ? 'autorizados' : 'bloqueados';
    await interaction.reply({ content: action === 'add' ? `Domínio \`${domain}\` adicionado à lista de ${listLabel}.` : `Domínio \`${domain}\` removido da lista de ${listLabel}.`, ephemeral: true });
    await sendGuildLog(interaction.guild, 'anti-links', 'lista de domínios alterada', { executor: interaction.user.id, lista: listLabel, ação: action, domínio: domain });
    return;
  }
  if (parsed.group === 'links' && parsed.subcommand === 'exception') {
    const role = interaction.options.getRole('cargo');
    const channel = interaction.options.getChannel('canal');
    if (Boolean(role) === Boolean(channel)) throw new Error('Informe exatamente um cargo ou um canal para a exceção.');
    const action = interaction.options.getString('acao', true);
    const field = role ? 'exemptRoleIds' : 'exemptChannelIds';
    const id = role?.id || channel.id;
    const current = getAntiConfig(interaction.guildId)[field];
    const values = action === 'add'
      ? [...new Set([...current, id])]
      : current.filter((item) => item !== id);
    if (values.length > 1000) throw new Error('A lista de exceções atingiu o limite de 1.000 itens.');
    updateAntiConfig(interaction.guildId, { [field]: values });
    await interaction.reply({ content: `Exceção ${action === 'add' ? 'adicionada' : 'removida'} para ${role ? `<@&${id}>` : `<#${id}>`}.`, ephemeral: true });
    await sendGuildLog(interaction.guild, 'anti-links', 'exceção alterada', { executor: interaction.user.id, alvo: id, ação: action });
    return;
  }
  if (!PROTECTIONS.includes(parsed.group) || !['on', 'off'].includes(parsed.subcommand)) {
    throw new Error('Subcomando de proteção inválido.');
  }
  const next = updateAntiConfig(interaction.guildId, { enabled: { [parsed.group]: enabled } });
  await interaction.reply({ content: `${PROTECTION_LABELS[parsed.group]} ${next.enabled[parsed.group] ? 'ativado' : 'desativado'}. Nenhuma punição automática foi configurada.`, ephemeral: true });
  await sendGuildLog(interaction.guild, 'anti', 'configuração alterada', { executor: interaction.user.id, proteção: parsed.group, estado: enabled ? 'ON' : 'OFF' });
}

async function showErrors(interaction) {
  const authorized = interaction.user.id === config.ownerId || isAdmin(interaction.member);
  if (!authorized) {
    await interaction.reply({ content: 'A consulta de erros técnicos é restrita ao proprietário e a administradores.', ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [errorReportEmbed()],
    ephemeral: true,
  });
}

function normalizeCommandName(value = '') {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

async function handlePrefix(message, prefix) {
  if (message.author.bot || !message.content.startsWith(prefix)) return;
  const input = message.content.slice(prefix.length).trim();
  const [command = '', ...args] = input.split(/\s+/);
  const rest = input.slice(command.length).trim();
  const respond = (payload) => message.reply({ ...payload, allowedMentions: { parse: [] } });
  const commandName = normalizeCommandName(command);

  switch (commandName) {
    case 'painel': {
      if (!isCentralAdmin(message.author.id, message.member)) {
        await respond({ content: 'A central de controle é restrita ao proprietário e administradores autorizados.' });
        return;
      }
      const panel = await ensureCentralPanel(message.client, message.guildId);
      await respond({ content: panel ? `Painel central atualizado em <#${config.channels.controlPanel}>.` : 'Não foi possível atualizar o painel. O erro foi registrado e o proprietário será notificado.' });
      return;
    }
    case 'status':
      await message.reply({ embeds: [buildCentralPanelPayload(message.guild, 'overview').embeds[0]], allowedMentions: { parse: [] } });
      return;
    case 'discordinvite':
      await message.channel.send(invitePayload());
      return;
    case 'discordver':
      await sendDiscordServerInfo((payload) => message.channel.send(payload));
      return;
    case 'ver':
    case 'help':
      await message.channel.send({ embeds: [mainHelpEmbed()], components: helpButtons() });
      return;
    case 'info':
      await message.channel.send(infoPayload());
      return;
    case 'owner':
      await message.channel.send({ content: `<@${config.ownerId}>`, allowedMentions: { users: [config.ownerId] } });
      return;
    case 'zonde': {
      if (args[0]?.toLowerCase() === 'owner') {
        await message.channel.send({ content: `<@${config.ownerId}>`, allowedMentions: { users: [config.ownerId] } });
      } else {
        await message.channel.send(infoPayload());
      }
      return;
    }
    case 'errorver': {
      const authorized = message.author.id === config.ownerId
        || message.member?.permissions.has(PermissionFlagsBits.Administrator);
      if (!authorized) {
        await respond({ content: 'A consulta de erros técnicos é restrita ao proprietário e a administradores.' });
        return;
      }
      try {
        await message.author.send({ embeds: [errorReportEmbed()] });
        await respond({ content: 'Enviei o diagnóstico técnico por mensagem privada.' });
      } catch (error) {
        recordError({ service: 'discord', step: 'envio privado de errorver', error });
        await respond({ content: 'Não foi possível enviar o diagnóstico por mensagem privada. Nenhum dado técnico foi publicado neste canal.' });
      }
      return;
    }
    case 'anti':
      await handleAntiPrefix(message, args);
      return;
    case 'iacriar': {
      if (!message.guild) {
        await respond({ content: 'A criação assistida só está disponível em um servidor.' });
        return;
      }
      if (!rest) {
        await respond({ content: 'Descreva o que deseja criar em até 1.500 caracteres. Envie a descrição em uma única mensagem nos próximos 2 minutos.' });
        try {
          const collected = await message.channel.awaitMessages({
            filter: (candidate) => candidate.author.id === message.author.id && !candidate.author.bot,
            max: 1,
            time: 120_000,
            errors: ['time'],
          });
          await startAssistantPlan(
            collected.first().content.slice(0, 1500),
            message.guild,
            message.member,
            message.channelId,
            (payload) => message.channel.send({ ...payload, allowedMentions: { parse: [] } }),
          );
        } catch {
          await respond({ content: 'Tempo esgotado; nenhuma ação foi executada.' });
        }
        return;
      }
      await startAssistantPlan(rest.slice(0, 1500), message.guild, message.member, message.channelId, (payload) => message.channel.send({ ...payload, allowedMentions: { parse: [] } }));
      return;
    }
    case 'ticket':
      await handleTicketPrefix(message, args);
      return;
    case 'quest':
      if (args[0]?.toLowerCase() === 'status') {
        await handleMissionPrefix(message, ['status']);
        return;
      }
      await handleQuestPrefix(message, args);
      return;
    case 'news': {
      const settings = getNewsSettings(message.guildId);
      await respond({ content: `News: **${settings.enabled ? 'ativo' : 'inativo'}**\nCanal: ${settings.channelId ? `<#${settings.channelId}>` : 'não configurado'}\nIntervalo: **${settings.intervalMinutes} minuto(s)**\nPróxima consulta: ${settings.nextAttemptAt ? `<t:${Math.floor(settings.nextAttemptAt / 1000)}:R>` : 'não agendada'}` });
      return;
    }
    case 'missoes':
      await handleMissionPrefix(message, args);
      return;
    case 'loja':
      await handleStorePrefix(message, args);
      return;
    case 'disponiveis':
    case 'disponíveis':
    case 'indisponiveis':
    case 'indisponíveis': {
      const channelId = args[0]?.match(/^<#(\d+)>$/)?.[1];
      const channel = channelId ? message.guild?.channels.cache.get(channelId) : null;
      const isAvailable = commandName === 'disponiveis' || commandName === 'disponíveis';
      await configureMissionChannel(
        message.guild,
        message.member,
        channel,
        isAvailable ? 'missions_available_channel' : 'missions_unavailable_channel',
        respond,
      );
      return;
    }
    case 'ia':
      if (['status', 'diagnostico'].includes(args[0]?.toLowerCase())) {
        const status = getAiStatus();
        if (args[0].toLowerCase() === 'status') {
          await respond({ content: `IA: **${status.configured ? 'configurada' : 'indisponível'}**\nModelo: ${status.model}\nRequisições ativas: ${status.activeRequests}\nTimeout: ${status.timeoutMs / 1000}s.` });
          return;
        }
        if (!isCentralAdmin(message.author.id, message.member)) {
          await respond({ content: 'O diagnóstico ao provedor é restrito ao proprietário e administradores autorizados.' });
          return;
        }
        try {
          const result = await askNvidia('Responda somente com a palavra OK.', { requestKey: `redcloud-prefix-diagnostic:${message.author.id}:${Date.now()}` });
          await respond({ content: `Diagnóstico concluído: ${sanitize(result).slice(0, 100)}.` });
        } catch (error) {
          await respond({ content: `Diagnóstico da IA falhou: ${sanitize(error.message)}. Os demais serviços continuam independentes.` });
        }
        return;
      }
      if (!rest) {
        await respond({ content: 'Envie uma mensagem após o comando, por exemplo: `!red ia explique o que é uma API`.' });
        return;
      }
      await runPrefixAi(rest, message, respond);
      return;
    default:
      if (!input) {
        await respond({ content: 'Escreva sua mensagem após `!red` para conversar com a IA ou use `!red ver` para abrir a ajuda.' });
        return;
      }
      await runPrefixAi(input, message, respond);
  }
}

async function runPrefixAi(prompt, message, respond) {
  try {
    const sent = await sendAiResponse(prompt, message.author.id, message.channel, respond);
    if (!sent) await respond({ content: 'Uma solicitação idêntica já está sendo processada.' });
  } catch {
    await respond({ content: 'A IA está temporariamente indisponível. Nenhuma resposta foi gerada.' });
  }
}

async function handleAntiPrefix(message, args) {
  const [module, action, ...remaining] = args.map((value) => value);
  const respond = (payload) => message.reply({ ...payload, allowedMentions: { parse: [] } });
  if (!message.guild) {
    await respond({ content: 'Este comando só pode ser usado em um servidor.' });
    return;
  }
  if (!module || module === 'status') {
    await message.channel.send({ embeds: [antiStatusPayload(message.guild.id)] });
    return;
  }
  if (module === 'config') {
    if (!await authorizeAdmin(message)) return;
    const panel = await message.channel.send(buildAntiPanel(message.guild.id));
    recordPublishedPanel(message.guild.id, message.channel.id, panel.id, 'anti');
    return;
  }
  if (module === 'logs') {
    if (!canReadModerationLogs(message.member)) {
      await respond({ content: 'Você precisa da permissão **Ver registro de auditoria** para consultar estes registros.' });
      return;
    }
    try {
      await message.author.send({ embeds: [recentLogsPayload(message.guild.id)] });
      await respond({ content: 'Enviei os eventos recentes por mensagem privada.' });
    } catch (error) {
      recordError({ service: 'discord', step: 'envio privado dos logs do servidor', error });
      await respond({ content: 'Não foi possível enviar os registros por mensagem privada.' });
    }
    return;
  }
  if (module === 'logchannel') {
    if (!await authorizeAdmin(message)) return;
    const id = action?.match(/^<#(\d+)>$/)?.[1];
    const channel = id ? message.guild.channels.cache.get(id) : null;
    if (channel?.type !== ChannelType.GuildText) throw new Error('Use `!red anti logchannel #canal` com um canal de texto.');
    if (!hasAnyPermission(channel, message.guild.members.me, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])) {
      throw new Error('O bot precisa de permissões para visualizar, enviar mensagens e incorporar embeds nesse canal.');
    }
    setSetting(message.guild.id, 'logs_channel', channel.id);
    await respond({ content: `Canal de logs configurado para <#${channel.id}>.` });
    await sendGuildLog(message.guild, 'anti', 'canal de logs configurado', { executor: message.author.id, canal: channel.id });
    return;
  }
  if (module === 'config' && action === 'limits') {
    if (!await authorizeAdmin(message)) return;
    const names = {
      joinLimit: ['entradas', 2, 100],
      joinWindowSeconds: ['janela_raid', 5, 120],
      spamMessageLimit: ['mensagens', 2, 30],
      spamWindowSeconds: ['janela_spam', 3, 60],
      mentionLimit: ['menções', 2, 50],
    };
    const changes = {};
    for (const [key, [argument, minimum, maximum]] of Object.entries(names)) {
      const raw = remaining.find((item) => item.startsWith(`${argument}=`));
      if (!raw) continue;
      const value = Number(raw.slice(argument.length + 1));
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${argument} deve estar entre ${minimum} e ${maximum}.`);
      }
      changes[key] = value;
    }
    if (!Object.keys(changes).length) {
      await respond({ content: 'Informe ao menos um limite: `!red anti config limits entradas=8 janela_raid=10 mensagens=6 janela_spam=8 menções=5`.' });
      return;
    }
    updateAntiConfig(message.guild.id, changes);
    await respond({ content: 'Limites de proteção atualizados.' });
    await sendGuildLog(message.guild, 'anti', 'limites alterados', { executor: message.author.id, ...changes });
    return;
  }
  if (module === 'links' && ['domain', 'exception'].includes(action)) {
    if (!await authorizeAdmin(message)) return;
    const explicitList = action === 'domain' && ['allow', 'block'].includes(remaining[0]);
    const list = explicitList && remaining[0] === 'allow' ? 'allowedDomains' : 'blockedDomains';
    const operation = explicitList ? remaining[1] : remaining[0];
    const target = explicitList ? remaining[2] : remaining[1];
    if (!['add', 'remove'].includes(operation)) throw new Error('Use `add` ou `remove`.');
    const current = getAntiConfig(message.guild.id);
    if (action === 'domain') {
      const domain = normalizeDomain(target || '');
      const domains = operation === 'add'
        ? [...new Set([...current[list], domain])]
        : current[list].filter((item) => item !== domain);
      if (domains.length > 1000) throw new Error('A lista de domínios atingiu o limite de 1.000 itens.');
      updateAntiConfig(message.guild.id, { [list]: domains });
      await respond({ content: `Domínio \`${domain}\` ${operation === 'add' ? 'adicionado à' : 'removido da'} lista de ${list === 'allowedDomains' ? 'autorizados' : 'bloqueados'}.` });
        await sendGuildLog(message.guild, 'anti-links', 'lista de domínios alterada', {
          executor: message.author.id,
          lista: list === 'allowedDomains' ? 'autorizados' : 'bloqueados',
          ação: operation,
          domínio: domain,
        });
        return;
      }
    const id = target?.match(/^(?:<#|<@&)?(\d+)>?$/)?.[1];
    if (!id) throw new Error('Informe uma menção ou ID de cargo/canal.');
    const isChannel = target.startsWith('<#');
    if (operation === 'add') {
      const exists = isChannel
        ? message.guild.channels.cache.get(id)?.type === ChannelType.GuildText
        : message.guild.roles.cache.has(id);
      if (!exists) throw new Error('O cargo ou canal informado não existe neste servidor.');
    }
    const field = isChannel ? 'exemptChannelIds' : 'exemptRoleIds';
    const values = operation === 'add'
      ? [...new Set([...current[field], id])]
      : current[field].filter((item) => item !== id);
    if (values.length > 1000) throw new Error('A lista de exceções atingiu o limite de 1.000 itens.');
    updateAntiConfig(message.guild.id, { [field]: values });
    await respond({ content: `Exceção ${operation === 'add' ? 'adicionada' : 'removida'}.` });
    await sendGuildLog(message.guild, 'anti-links', 'exceção alterada', {
      executor: message.author.id,
      alvo: id,
      ação: operation,
    });
    return;
  }
  if (PROTECTIONS.includes(module) && ['on', 'off'].includes(action)) {
    await setProtection(message.guild, message.member, module, action === 'on', respond);
    return;
  }
  await respond({ content: 'Uso: `!red anti status|config|logs|logchannel #canal`, `!red anti <raid|spam|mention|webhook|joins|links> <on|off>`, `!red anti config limits ...` ou `!red anti links domain [allow|block] <add|remove> exemplo.com`.' });
}

async function handleButton(interaction) {
  if (interaction.customId.startsWith('help:')) {
    const category = interaction.customId.slice('help:'.length);
    if (category === 'home') {
      await interaction.update({ embeds: [mainHelpEmbed()], components: helpButtons() });
      return;
    }
    const content = categoryContent[category];
    if (!content) {
      await interaction.reply({ content: 'Categoria inválida.', ephemeral: true });
      return;
    }
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle(content.title).setDescription(content.description)],
      components: backButton(),
    });
    return;
  }
  if (interaction.customId.startsWith('anti:toggle:')) {
    if (!await authorizeAdmin(interaction)) return;
    const protection = interaction.customId.split(':')[2];
    if (!PROTECTIONS.includes(protection)) {
      await interaction.reply({ content: 'Proteção inválida.', ephemeral: true });
      return;
    }
    const nextEnabled = !getAntiConfig(interaction.guildId).enabled[protection];
    updateAntiConfig(interaction.guildId, { enabled: { [protection]: nextEnabled } });
    await interaction.update(buildAntiPanel(interaction.guildId));
    await sendGuildLog(interaction.guild, 'anti', 'configuração alterada', {
      executor: interaction.user.id,
      proteção: protection,
      estado: nextEnabled ? 'ON' : 'OFF',
    });
    return;
  }
  if (interaction.customId === 'anti:settings') {
    if (!await authorizeAdmin(interaction)) return;
    const current = getAntiConfig(interaction.guildId);
    const modal = new ModalBuilder().setCustomId('anti:settings:modal').setTitle('Limites das proteções')
      .addComponents(
        ['joinLimit', 'joinWindowSeconds', 'spamMessageLimit', 'spamWindowSeconds', 'mentionLimit'].map((key) => {
          const names = {
            joinLimit: ['join_limit', 'Máximo de entradas'],
            joinWindowSeconds: ['join_window', 'Janela de entradas (s)'],
            spamMessageLimit: ['spam_limit', 'Mensagens por janela'],
            spamWindowSeconds: ['spam_window', 'Janela anti-spam (s)'],
            mentionLimit: ['mention_limit', 'Limite de menções'],
          }[key];
          return new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(names[0]).setLabel(names[1])
              .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(3)
              .setValue(String(current[key])).setRequired(true),
          );
        }),
      );
    await interaction.showModal(modal);
    return;
  }
  if (interaction.customId === 'anti:open') {
    if (!await authorizeAdmin(interaction)) return;
    await interaction.reply({ ...buildAntiPanel(interaction.guildId), ephemeral: true });
    return;
  }
  if (interaction.customId === 'suggestion:submit') {
    const panel = getPublishedPanel(interaction.guildId, interaction.message.id);
    if (!panel || panel.panel_type !== 'suggestion') {
      await interaction.reply({ content: 'Este painel de sugestões não está mais disponível.', ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`suggestion:modal:${interaction.message.id}`)
      .setTitle('Enviar uma sugestão')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('suggestion').setLabel('Sua ideia')
          .setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1500).setRequired(true),
      ));
    await interaction.showModal(modal);
    return;
  }
  if (interaction.customId.startsWith('plan:')) {
    const [, action, ...idParts] = interaction.customId.split(':');
    const id = idParts.join(':');
    const plan = takePendingPlan(id, interaction.user.id, interaction.guildId, interaction.channelId);
    if (!plan) {
      await interaction.reply({ content: 'Este plano expirou, já foi usado ou não pertence a você.', ephemeral: true });
      return;
    }
    if (action === 'cancel') {
      await interaction.update({ content: 'Plano cancelado. Nenhuma alteração foi realizada.', embeds: [], components: [] });
      return;
    }
    if (action === 'confirm' && plan.actions.some((item) => item.type === 'set_channel_permissions')) {
      const secondConfirmationId = registerPendingPlan(
        interaction.user.id,
        interaction.guildId,
        interaction.channelId,
        plan,
      );
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Confirmação adicional necessária')
          .setDescription('Este plano altera permissões básicas de um canal. Revise cuidadosamente: usuários podem perder acesso ou capacidade de enviar mensagens.')],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`plan:final:${secondConfirmationId}`).setLabel('Confirmar alteração de permissões').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`plan:cancel:${secondConfirmationId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }
    if (!['confirm', 'final'].includes(action)) {
      await interaction.reply({ content: 'Ação inválida.', ephemeral: true });
      return;
    }
    try {
      checkPlanPermissions(interaction.guild, interaction.member, plan);
      const results = await executePlan(interaction.guild, interaction.member, plan);
      await interaction.update({
        content: `Resultado da execução:\n${results.join('\n')}`,
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.update({ content: `Plano não executado: ${sanitize(error.message)}`, embeds: [], components: [] });
    }
    return;
  }
  if (interaction.customId.startsWith('vote:')) {
    await applyVote(interaction);
  }
}

export async function onInteraction(interaction) {
  const isPrivateTicketReviewInteraction = !interaction.guildId
    && interaction.customId?.startsWith('review:');
  if (!isAllowedGuild(interaction.guildId) && !isPrivateTicketReviewInteraction) return;
  try {
    if (handlesCentralInteraction(interaction)) await handleCentralInteraction(interaction);
    else if (interaction.isChatInputCommand()) await handleSlash(interaction);
    else if (interaction.isButton() && interaction.customId.startsWith('clear:')) await handleClearButton(interaction);
    else if (handlesTicketInteraction(interaction)) await handleTicketInteraction(interaction);
    else if (handlesStoreInteraction(interaction)) await handleStoreInteraction(interaction);
    else if (interaction.isModalSubmit() && interaction.customId === 'iacriar:modal') await handleCreateModal(interaction);
    else if (interaction.isModalSubmit() && interaction.customId === 'anti:settings:modal') await handleAntiSettingsModal(interaction);
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('suggestion:modal:')) await handleSuggestionModal(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
  } catch (error) {
    recordError({ service: 'discord', step: interaction.commandName || interaction.customId || 'interaction', error });
    const response = {
      content: 'Ocorreu uma falha ao processar a solicitação. O erro foi registrado.',
      ...(interaction.guildId ? { ephemeral: true } : {}),
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ ...response, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ ...response, ephemeral: true }).catch(() => {});
    }
  }
}

export async function onMessage(message) {
  if (!isAllowedGuild(message.guildId)) return;
  try {
    await handleOnlineClearMessage(message);
    if (message.author.bot) return;
    const prefix = message.content.startsWith(config.prefix) ? config.prefix : null;
    if (prefix) await handlePrefix(message, prefix);
  } catch (error) {
    recordError({ service: 'discord', step: 'prefix-command', error });
    await message.reply({ content: 'Ocorreu uma falha ao processar o comando. O erro foi registrado.', allowedMentions: { parse: [] } }).catch(() => {});
  }
}

export function getReadyHandler(client, rest, Routes) {
  return async (readyClient) => {
    try {
      const payload = (await import('./commands.js')).commandPayload();
      const applicationId = readyClient.application.id;
      await rest.put(Routes.applicationCommands(applicationId), { body: [] });
      const route = Routes.applicationGuildCommands(applicationId, config.discordGuildId);
      await rest.put(route, { body: payload });
      console.log(`!zond_ conectado como ${readyClient.user.tag}; ${payload.length} comandos registrados.`);
    } catch (error) {
      recordError({ service: 'discord', step: 'registro de comandos slash', error });
      console.error(`Não foi possível registrar os comandos slash: ${sanitize(error.message)}`);
      return;
    }
    await startMissionService(client);
    try {
      await startStoreService(client);
    } catch (error) {
      recordError({ service: 'source-store', step: 'inicialização dos painéis', error });
      console.error(`Não foi possível inicializar os painéis da loja: ${sanitize(error.message)}`);
    }
    try {
      startNewsService(client);
    } catch (error) {
      recordError({ service: 'news', step: 'inicialização do agendador', error });
    }
    try {
      await ensureCentralPanel(client, config.discordGuildId);
    } catch (error) {
      recordError({ service: 'redcloud-panel', step: 'inicialização no ready', error });
    }
  };
}

export function bindEvents(client) {
  client.on(Events.InteractionCreate, onInteraction);
  client.on(Events.MessageCreate, onMessage);
}
