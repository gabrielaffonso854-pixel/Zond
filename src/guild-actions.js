import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { askNvidia } from './ai.js';
import {
  getPublishedPanel,
  setSetting,
  recordPublishedPanel,
  recordVote,
  voteCounts,
} from './db.js';
import { recordError, sanitize } from './errors.js';
import { sendGuildLog } from './anti.js';

const pendingPlans = new Map();
const planExpiryMs = 5 * 60 * 1000;
const maxActions = 8;
const allowedOverwrites = [
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AttachFiles',
  'EmbedLinks',
];
const allowedActionTypes = new Set([
  'create_category',
  'create_text_channel',
  'set_channel_topic',
  'set_channel_permissions',
  'post_embed',
  'create_suggestion_panel',
  'create_poll',
  'post_link',
  'set_logs_channel',
  'publish_bot_panel',
  'publish_ticket_panel',
]);
const actionHelp = {
  create_category: 'criar categoria',
  create_text_channel: 'criar canal de texto',
  set_channel_topic: 'configurar descrição de canal',
  set_channel_permissions: 'configurar permissões básicas de canal',
  post_embed: 'publicar embed',
  create_suggestion_panel: 'publicar painel de sugestões e votação',
  create_poll: 'publicar enquete',
  post_link: 'publicar mensagem com link',
  set_logs_channel: 'configurar canal de logs',
  publish_bot_panel: 'publicar painel existente do bot',
  publish_ticket_panel: 'publicar o painel de atendimento existente',
};

function cleanName(value, max = 90) {
  if (typeof value !== 'string') throw new Error('Nome deve ser um texto.');
  const name = value.trim();
  if (!name || name.length > max || /[\u0000-\u001f]/.test(name)) {
    throw new Error(`Nome inválido (limite de ${max} caracteres).`);
  }
  return name;
}

function cleanText(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${field} deve ter entre 1 e ${max} caracteres.`);
  }
  return value.trim();
}

export function validateGeneratedPlan(answer) {
  const firstBrace = answer.indexOf('{');
  const lastBrace = answer.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('A IA não retornou um plano estruturado válido. Nenhuma ação foi executada.');
  }
  let parsed;
  try {
    parsed = JSON.parse(answer.slice(firstBrace, lastBrace + 1));
  } catch {
    throw new Error('A IA retornou um plano JSON inválido. Nenhuma ação foi executada.');
  }
  if (parsed.unsupported) {
    throw new Error(`Ainda não suportado: ${cleanText(parsed.explanation, 'Explicação', 1000)}`);
  }
  if (!Array.isArray(parsed.actions) || parsed.actions.length < 1 || parsed.actions.length > maxActions) {
    throw new Error(`O plano deve conter entre 1 e ${maxActions} ações suportadas.`);
  }
  return {
    summary: cleanText(parsed.summary, 'Resumo', 500),
    actions: parsed.actions.map(validateAction),
  };
}

function validateAction(action) {
  if (!action || typeof action !== 'object' || !allowedActionTypes.has(action.type)) {
    throw new Error(`Ação não suportada: ${sanitize(action?.type || 'desconhecida')}. Nenhuma ação foi executada.`);
  }
  switch (action.type) {
    case 'create_category':
      return { type: action.type, name: cleanName(action.name) };
    case 'create_text_channel':
      return {
        type: action.type,
        name: cleanName(action.name, 100).toLowerCase().replace(/\s+/g, '-'),
        ...(action.category ? { category: cleanName(action.category) } : {}),
        ...(action.topic ? { topic: cleanText(action.topic, 'Descrição', 1024) } : {}),
      };
    case 'set_channel_topic':
      return {
        type: action.type,
        channel: cleanName(action.channel, 100),
        topic: cleanText(action.topic, 'Descrição', 1024),
      };
    case 'set_channel_permissions': {
      const target = action.target;
      if (!target || !['everyone', 'role'].includes(target.type)) {
        throw new Error('Alvo de permissões inválido.');
      }
      const permissions = (value) => {
        if (!Array.isArray(value) || value.some((item) => !allowedOverwrites.includes(item))) {
          throw new Error('Ação contém permissões não autorizadas.');
        }
        return [...new Set(value)];
      };
      const allow = permissions(action.allow || []);
      const deny = permissions(action.deny || []);
      if (!allow.length && !deny.length) throw new Error('A ação de permissões está vazia.');
      if (allow.some((permission) => deny.includes(permission))) {
        throw new Error('Uma permissão não pode ser permitida e negada na mesma ação.');
      }
      return {
        type: action.type,
        channel: cleanName(action.channel, 100),
        target: target.type === 'everyone'
          ? { type: 'everyone' }
          : { type: 'role', name: cleanName(target.name, 100) },
        allow,
        deny,
      };
    }
    case 'post_embed':
      return {
        type: action.type,
        channel: cleanName(action.channel, 100),
        title: cleanText(action.title, 'Título', 256),
        description: cleanText(action.description, 'Descrição', 4000),
      };
    case 'create_suggestion_panel':
      return {
        type: action.type,
        channel: cleanName(action.channel, 100),
        title: cleanText(action.title || 'Painel de sugestões', 'Título', 256),
        description: cleanText(action.description, 'Descrição', 3000),
      };
    case 'create_poll':
      if (!Array.isArray(action.options) || action.options.length < 2 || action.options.length > 4) {
        throw new Error('Enquetes devem ter de 2 a 4 opções.');
      }
      return {
        type: action.type,
        channel: cleanName(action.channel, 100),
        question: cleanText(action.question, 'Pergunta', 256),
        options: action.options.map((option) => cleanText(option, 'Opção', 80)),
      };
    case 'post_link': {
      let url;
      try {
        url = new URL(action.url);
      } catch {
        throw new Error('O link informado é inválido.');
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Somente links HTTPS sem credenciais são permitidos.');
      }
      return {
        type: action.type,
        channel: cleanName(action.channel, 100),
        text: cleanText(action.text, 'Texto', 1500),
        url: url.toString(),
        label: cleanText(action.label || 'Abrir link', 'Texto do botão', 80),
      };
    }
    case 'set_logs_channel':
      return { type: action.type, channel: cleanName(action.channel, 100) };
    case 'publish_bot_panel':
      if (action.panel !== 'anti') throw new Error('Template de painel ainda não implementado.');
      return { type: action.type, channel: cleanName(action.channel, 100), panel: 'anti' };
    case 'publish_ticket_panel':
      if (action.panel !== 'ticket') throw new Error('Template de painel de tickets ainda não implementado.');
      return { type: action.type, channel: cleanName(action.channel, 100), panel: 'ticket' };
    default:
      throw new Error('Ação não suportada.');
  }
}

export async function createAssistantPlan(prompt, guild) {
  if (!guild) throw new Error('A criação assistida só está disponível dentro de um servidor.');
  const response = await askNvidia([
    'Interprete o pedido e retorne exclusivamente um objeto JSON, sem markdown.',
    'Nunca afirme que algo foi feito. Nunca gere código executável.',
    'Schema suportado: {"summary":"...","actions":[...]}.',
    'Ações: create_category{name}; create_text_channel{name,category?,topic?};',
    'set_channel_topic{channel,topic}; set_channel_permissions{channel,target:{type:"everyone"} ou {type:"role",name},allow:[ViewChannel,SendMessages,ReadMessageHistory,AttachFiles,EmbedLinks],deny:[mesmos]};',
    'post_embed{channel,title,description}; create_suggestion_panel{channel,title,description};',
    'create_poll{channel,question,options:[2 a 4]}; post_link{channel,text,url,label};',
    'set_logs_channel{channel}; publish_bot_panel{channel,panel:"anti"}; publish_ticket_panel{channel,panel:"ticket"} para publicar o template existente de atendimento da Zonde.',
    'Não há suporte a excluir recursos, cargos, ações de moderação, execução de código, nem outras integrações.',
    'Se o pedido exigir qualquer operação não suportada, retorne {"unsupported":true,"explanation":"..."} sem ações.',
    `Pedido do usuário: ${prompt}`,
  ].join('\n'), {
    requestKey: `plan:${guild.id}:${prompt}`,
    systemPrompt: 'Responda exclusivamente com o formato solicitado pelo sistema, sem markdown. Nunca revele credenciais, variáveis de ambiente ou informações privadas. Não execute ações.',
  });
  return validateGeneratedPlan(response);
}

function findNamedChannel(guild, name, type = ChannelType.GuildText) {
  const matches = guild.channels.cache.filter(
    (item) => item.type === type && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.size > 1) throw new Error(`Há mais de um canal chamado "${name}"; use um nome sem ambiguidades.`);
  const channel = matches.first();
  if (!channel) throw new Error(`Canal "${name}" não encontrado.`);
  return channel;
}

function findTextChannel(guild, name) {
  return findNamedChannel(guild, name, ChannelType.GuildText);
}

function requirePermission(member, permission, label) {
  if (!member.permissions.has(permission)) throw new Error(`Você precisa da permissão ${label}.`);
}

export function checkPlanPermissions(guild, member, plan) {
  const botMember = guild.members.me;
  const modifyingChannels = plan.actions.some((action) => [
    'create_category', 'create_text_channel', 'set_channel_topic',
    'set_channel_permissions', 'set_logs_channel',
  ].includes(action.type));
  if (modifyingChannels) {
    requirePermission(member, PermissionFlagsBits.ManageChannels, 'Gerenciar canais');
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error('O bot precisa da permissão Gerenciar canais.');
    }
  }

  for (const [index, action] of plan.actions.entries()) {
    if (!['set_channel_topic', 'set_channel_permissions', 'set_logs_channel', 'create_text_channel'].includes(action.type)) continue;
    if (action.type === 'create_text_channel' && action.topic
      && !botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error('O bot precisa da permissão Gerenciar canais para definir descrições.');
    }
    const createdEarlier = plan.actions.slice(0, index).some((previous) => (
      previous.type === 'create_text_channel'
      && previous.name.toLowerCase() === action.channel.toLowerCase()
    ));
    if (action.type !== 'create_text_channel' && !createdEarlier) findTextChannel(guild, action.channel);
    if (action.type === 'set_channel_permissions' && !createdEarlier) {
      const channel = findTextChannel(guild, action.channel);
      if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error(`O bot não pode gerenciar permissões em #${channel.name}.`);
      }
    }
  }

  for (const [index, action] of plan.actions.entries()) {
    if (!['post_embed', 'create_suggestion_panel', 'create_poll', 'post_link', 'publish_bot_panel'].includes(action.type)) continue;
    const createdEarlier = plan.actions.slice(0, index).some((previous) => (
      previous.type === 'create_text_channel'
      && previous.name.toLowerCase() === action.channel.toLowerCase()
    ));
    const channel = createdEarlier ? null : findTextChannel(guild, action.channel);
    const requiredForUser = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
    const requiredForBot = [...requiredForUser];
    if (action.type !== 'post_link') requiredForBot.push(PermissionFlagsBits.EmbedLinks);
    const userCanSend = channel
      ? channel.permissionsFor(member)?.has(requiredForUser)
      : requiredForUser.every((permission) => member.permissions.has(permission));
    const botCanSend = channel
      ? channel.permissionsFor(botMember)?.has(requiredForBot)
      : requiredForBot.every((permission) => botMember?.permissions.has(permission));
    if (!userCanSend) throw new Error(`Você não pode enviar o conteúdo previsto em #${action.channel}.`);
    if (!botCanSend) throw new Error(`O bot não pode enviar o conteúdo previsto em #${action.channel}.`);
  }

  for (const action of plan.actions.filter((item) => item.type === 'set_channel_permissions')) {
    requirePermission(member, PermissionFlagsBits.ManageRoles, 'Gerenciar cargos');
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('O bot precisa da permissão Gerenciar cargos.');
    }
    const roleMatches = action.target.type === 'role'
      ? guild.roles.cache.filter((role) => role.name.toLowerCase() === action.target.name.toLowerCase())
      : null;
    if (roleMatches?.size > 1) throw new Error(`Há mais de um cargo chamado "${action.target.name}"; o plano é ambíguo.`);
    const targetRole = action.target.type === 'everyone' ? guild.roles.everyone : roleMatches.first();
    if (!targetRole) throw new Error(`Cargo "${action.target.name}" não encontrado.`);
    if (targetRole.id !== guild.id
      && (targetRole.position >= botMember.roles.highest.position
        || targetRole.position >= member.roles.highest.position)) {
      throw new Error('A hierarquia impede alterar as permissões desse cargo.');
    }
    const granted = action.allow.map((name) => PermissionsBitField.Flags[name]);
    if (granted.some((flag) => !member.permissions.has(flag))) {
      throw new Error('Você não pode conceder permissões que não possui.');
    }
  }

  const newCategories = new Set();
  const channelsToCreate = plan.actions.filter((item) => (
    item.type === 'create_category' || item.type === 'create_text_channel'
  ));
  if (guild.channels.cache.size + channelsToCreate.length > 500) {
    throw new Error('O plano excede o limite de 500 canais por servidor.');
  }
  for (const action of plan.actions.filter((item) => item.type === 'create_category')) {
    if (newCategories.has(action.name.toLowerCase())) {
      throw new Error(`A categoria "${action.name}" aparece mais de uma vez no plano.`);
    }
    newCategories.add(action.name.toLowerCase());
    if (guild.channels.cache.some((channel) => channel.type === ChannelType.GuildCategory
      && channel.name.toLowerCase() === action.name.toLowerCase())) {
      throw new Error(`A categoria "${action.name}" já existe.`);
    }
  }
  const newChannels = new Set();
  for (const action of plan.actions.filter((item) => item.type === 'create_text_channel')) {
    if (newChannels.has(action.name.toLowerCase())) {
      throw new Error(`O canal "${action.name}" aparece mais de uma vez no plano.`);
    }
    newChannels.add(action.name.toLowerCase());
    if (guild.channels.cache.some((channel) => channel.type === ChannelType.GuildText
      && channel.name.toLowerCase() === action.name.toLowerCase())) {
      throw new Error(`O canal "${action.name}" já existe.`);
    }
    if (action.category && !newCategories.has(action.category.toLowerCase())) {
      const categoryMatches = guild.channels.cache.filter((item) => item.type === ChannelType.GuildCategory
        && item.name.toLowerCase() === action.category.toLowerCase());
      if (!categoryMatches.size) throw new Error(`Categoria "${action.category}" não encontrada.`);
      if (categoryMatches.size > 1) throw new Error(`Há mais de uma categoria chamada "${action.category}".`);
    }
  }
}

function textChannelPermission(guild, channel, needsEmbed = true) {
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (needsEmbed) required.push(PermissionFlagsBits.EmbedLinks);
  if (!channel.isTextBased()
    || !channel.permissionsFor(guild.members.me)?.has(required)) {
    throw new Error(`O bot não possui permissões suficientes em #${channel.name}.`);
  }
}

async function executeAction(guild, member, action, createdCategories) {
  switch (action.type) {
    case 'create_category': {
      const channel = await guild.channels.create({ name: action.name, type: ChannelType.GuildCategory });
      createdCategories.set(action.name.toLowerCase(), channel.id);
      return `Categoria "${channel.name}" criada.`;
    }
    case 'create_text_channel': {
      let parent;
      if (action.category) {
          const createdParent = createdCategories.get(action.category.toLowerCase());
          const matches = guild.channels.cache.filter((item) => item.type === ChannelType.GuildCategory
            && item.name.toLowerCase() === action.category.toLowerCase());
          if (!createdParent && matches.size > 1) throw new Error(`Há mais de uma categoria chamada "${action.category}".`);
          parent = createdParent || matches.first()?.id;
        if (!parent) throw new Error(`Categoria "${action.category}" não encontrada.`);
      }
      const channel = await guild.channels.create({
        name: action.name,
        type: ChannelType.GuildText,
        ...(parent ? { parent } : {}),
        ...(action.topic ? { topic: action.topic } : {}),
      });
      return `Canal #${channel.name} criado.`;
    }
    case 'set_channel_topic': {
      const channel = await findTextChannel(guild, action.channel);
      await channel.setTopic(action.topic);
      return `Descrição de #${channel.name} atualizada.`;
    }
    case 'set_channel_permissions': {
      const channel = await findTextChannel(guild, action.channel);
      const role = action.target.type === 'everyone'
        ? guild.roles.everyone
        : guild.roles.cache.find((item) => item.name.toLowerCase() === action.target.name.toLowerCase());
      if (!role) throw new Error('O cargo deixou de existir antes da execução.');
      const overwrite = Object.fromEntries([
        ...action.allow.map((name) => [name, true]),
        ...action.deny.map((name) => [name, false]),
      ]);
      await channel.permissionOverwrites.edit(role, overwrite);
      return `Permissões básicas de #${channel.name} atualizadas para ${role.name}.`;
    }
    case 'post_embed': {
      const channel = await findTextChannel(guild, action.channel);
      textChannelPermission(guild, channel);
      await channel.send({
        embeds: [new EmbedBuilder().setColor(0xC8102E).setTitle(action.title).setDescription(action.description)],
        allowedMentions: { parse: [] },
      });
      return `Embed publicado em #${channel.name}.`;
    }
    case 'create_suggestion_panel': {
      const channel = await findTextChannel(guild, action.channel);
      textChannelPermission(guild, channel);
      const message = await channel.send({
        embeds: [new EmbedBuilder().setColor(0xC8102E).setTitle(action.title)
          .setDescription(`${action.description}\n\nUse o botão abaixo para enviar uma sugestão.`)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('suggestion:submit').setLabel('Enviar sugestão').setStyle(ButtonStyle.Danger),
        )],
        allowedMentions: { parse: [] },
      });
      recordPublishedPanel(guild.id, channel.id, message.id, 'suggestion');
      return `Painel de sugestões publicado em #${channel.name} (mensagem ${message.id}).`;
    }
    case 'create_poll': {
      const channel = await findTextChannel(guild, action.channel);
      textChannelPermission(guild, channel);
      const message = await channel.send({
        embeds: [new EmbedBuilder().setColor(0xC8102E).setTitle(action.question)
          .setDescription(action.options.map((option, index) => `${index + 1}. ${option} — 0 votos`).join('\n'))],
        components: [new ActionRowBuilder().addComponents(
          ...action.options.map((option, index) => new ButtonBuilder()
            .setCustomId(`vote:option:${index}`)
            .setLabel(`${index + 1}. ${option.slice(0, 55)}`)
            .setStyle(ButtonStyle.Secondary)),
        )],
        allowedMentions: { parse: [] },
      });
      recordPublishedPanel(guild.id, channel.id, message.id, 'poll');
      return `Enquete publicada em #${channel.name} (mensagem ${message.id}).`;
    }
    case 'post_link': {
      const channel = await findTextChannel(guild, action.channel);
      textChannelPermission(guild, channel, false);
      await channel.send({
        content: action.text,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(action.label).setURL(action.url),
        )],
        allowedMentions: { parse: [] },
      });
      return `Link publicado em #${channel.name}.`;
    }
    case 'set_logs_channel': {
      const channel = await findTextChannel(guild, action.channel);
      textChannelPermission(guild, channel);
      setSetting(guild.id, 'logs_channel', channel.id);
      return `Canal de logs configurado para #${channel.name}.`;
    }
    case 'publish_bot_panel': {
      const channel = await findTextChannel(guild, action.channel);
      textChannelPermission(guild, channel);
      const { buildAntiPanel } = await import('./anti.js');
      const message = await channel.send(buildAntiPanel(guild.id));
      recordPublishedPanel(guild.id, channel.id, message.id, 'anti');
      return `Painel de proteção publicado em #${channel.name}.`;
    }
    case 'publish_ticket_panel': {
      const channel = await findTextChannel(guild, action.channel);
      const { publishTicketPanel } = await import('./tickets.js');
      const result = await publishTicketPanel(guild, member, member.id, channel);
      return `Painel de atendimento ${result.updated ? 'atualizado' : 'publicado'} em #${result.channel.name}.`;
    }
    default:
      throw new Error('Ação não suportada.');
  }
}

export async function executePlan(guild, member, plan) {
  checkPlanPermissions(guild, member, plan);
  const createdCategories = new Map();
  const results = [];
  for (const action of plan.actions) {
    try {
      const result = await executeAction(guild, member, action, createdCategories);
      results.push(`• ${result}`);
      await sendGuildLog(guild, 'iacriar', 'ação executada', {
        executor: member.id,
        ação: actionHelp[action.type],
        resultado: result,
      });
    } catch (error) {
      results.push(`• Falha ao ${actionHelp[action.type]}: ${sanitize(error.message)}`);
      recordError({ service: 'iacriar', step: action.type, error });
      await sendGuildLog(guild, 'iacriar', 'falha na ação', {
        executor: member.id,
        ação: actionHelp[action.type],
        erro: sanitize(error.message),
      });
    }
  }
  return results;
}

export function registerPendingPlan(userId, guildId, channelId, plan) {
  for (const [existingId, item] of pendingPlans) {
    if (item.expiresAt < Date.now()) pendingPlans.delete(existingId);
  }
  if (pendingPlans.size >= 1000) {
    const oldestId = pendingPlans.keys().next().value;
    if (oldestId) pendingPlans.delete(oldestId);
  }
  const id = randomUUID();
  pendingPlans.set(id, { userId, guildId, channelId, plan, expiresAt: Date.now() + planExpiryMs });
  return id;
}

export function takePendingPlan(id, userId, guildId, channelId) {
  const item = pendingPlans.get(id);
  if (!item) return null;
  if (item.expiresAt < Date.now()) {
    pendingPlans.delete(id);
    return null;
  }
  if (item.userId !== userId || item.guildId !== guildId || item.channelId !== channelId) return null;
  pendingPlans.delete(id);
  return item.plan;
}

export function planPreview(plan) {
  return new EmbedBuilder()
    .setColor(0xC8102E)
    .setTitle('Revisão do plano')
    .setDescription(`**Resumo:** ${plan.summary}\n\n${plan.actions.map((action, index) => (
      `**${index + 1}.** ${actionHelp[action.type]} — ${action.name || action.channel || action.title || action.question || ''}`
    )).join('\n')}`)
    .setFooter({ text: 'Nada será alterado até você confirmar. O plano expira em 5 minutos.' });
}

export async function applyVote(interaction) {
  const panel = getPublishedPanel(interaction.guildId, interaction.message.id);
  if (!panel || !['suggestion-entry', 'poll'].includes(panel.panel_type)) {
    await interaction.reply({ content: 'Este painel de votação não está registrado ou não é mais válido.', ephemeral: true });
    return;
  }
  const [_, kind, value] = interaction.customId.split(':');
  let vote;
  if (panel.panel_type === 'suggestion-entry' && (kind === 'up' || kind === 'down')) vote = kind;
  if (panel.panel_type === 'poll' && kind === 'option' && /^\d$/.test(value)
    && Number(value) < interaction.message.components[0]?.components.length) {
    vote = `option:${value}`;
  }
  if (!vote) {
    await interaction.reply({ content: 'Voto inválido.', ephemeral: true });
    return;
  }
  recordVote(interaction.guildId, interaction.message.id, interaction.user.id, vote);
  const counts = voteCounts(interaction.message.id);
  const embed = EmbedBuilder.from(interaction.message.embeds[0]);
  if (kind === 'up' || kind === 'down') {
    embed.setFields({ name: 'Votos', value: `👍 ${counts.up || 0} • 👎 ${counts.down || 0}` });
  } else {
    const options = interaction.message.components[0].components;
    embed.setDescription(options.map((button, index) => (
      `${index + 1}. ${button.label.replace(/^\d+\.\s*/, '')} — ${counts[`option:${index}`] || 0} votos`
    )).join('\n'));
  }
  await interaction.update({ embeds: [embed] });
}
