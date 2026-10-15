import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { db, storeSystemLog } from './db.js';

const COLOR = 0xC8102E;
const MAX_DESCRIPTION_LENGTH = 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS server_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
  );
  CREATE INDEX IF NOT EXISTS server_missions_guild_status
    ON server_missions(guild_id, status, id);
  CREATE TABLE IF NOT EXISTS server_mission_completions (
    mission_id INTEGER NOT NULL REFERENCES server_missions(id),
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (mission_id, user_id)
  );
`);

export const questCommand = new SlashCommandBuilder()
  .setName('quest')
  .setDescription('Gerenciar missões próprias deste servidor')
  .addSubcommand((subcommand) => subcommand
    .setName('criar')
    .setDescription('Cadastrar uma missão para este servidor')
    .addStringOption((option) => option
      .setName('titulo')
      .setDescription('Título da missão')
      .setMaxLength(100)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('descricao')
      .setDescription('Instruções da missão')
      .setMaxLength(MAX_DESCRIPTION_LENGTH)
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('listar')
    .setDescription('Listar missões ativas deste servidor'))
  .addSubcommand((subcommand) => subcommand
    .setName('concluir')
    .setDescription('Registrar sua conclusão de uma missão do servidor')
    .addIntegerOption((option) => option
      .setName('missao')
      .setDescription('ID exibido na lista de missões')
      .setMinValue(1)
      .setRequired(true)));

function requireGuild(guildId) {
  if (!guildId) throw new Error('Este comando só pode ser usado em um servidor.');
}

function requireMissionManager(member) {
  if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('Você precisa da permissão Gerenciar servidor para cadastrar missões.');
  }
}

export function createServerMission({ guildId, userId, title, description }) {
  requireGuild(guildId);
  const cleanTitle = String(title || '').trim();
  const cleanDescription = String(description || '').trim();
  if (!cleanTitle || cleanTitle.length > 100) {
    throw new Error('O título deve ter entre 1 e 100 caracteres.');
  }
  if (!cleanDescription || cleanDescription.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`A descrição deve ter entre 1 e ${MAX_DESCRIPTION_LENGTH} caracteres.`);
  }
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO server_missions (guild_id, title, description, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, cleanTitle, cleanDescription, userId, createdAt);
  storeSystemLog({
    guildId,
    module: 'quests',
    eventType: 'missão cadastrada',
    details: { mission_id: Number(result.lastInsertRowid), title: cleanTitle, executor: userId },
  });
  return Number(result.lastInsertRowid);
}

export function listServerMissions(guildId, userId) {
  requireGuild(guildId);
  return db.prepare(`
    SELECT m.id, m.title, m.description, m.created_at,
      c.completed_at AS user_completed_at
    FROM server_missions m
    LEFT JOIN server_mission_completions c
      ON c.mission_id = m.id AND c.user_id = ?
    WHERE m.guild_id = ? AND m.status = 'active'
    ORDER BY m.id DESC
    LIMIT 25
  `).all(userId, guildId);
}

export function completeServerMission({ guildId, userId, missionId }) {
  requireGuild(guildId);
  if (!Number.isSafeInteger(missionId) || missionId < 1) {
    throw new Error('Informe um ID de missão válido.');
  }
  const mission = db.prepare(`
    SELECT id, title FROM server_missions
    WHERE guild_id = ? AND id = ? AND status = 'active'
  `).get(guildId, missionId);
  if (!mission) throw new Error('Missão não encontrada ou não está mais ativa neste servidor.');

  const result = db.prepare(`
    INSERT INTO server_mission_completions (mission_id, guild_id, user_id, completed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(mission_id, user_id) DO NOTHING
  `).run(missionId, guildId, userId, new Date().toISOString());
  if (!result.changes) return { mission, alreadyCompleted: true };

  storeSystemLog({
    guildId,
    module: 'quests',
    eventType: 'missão concluída pelo membro',
    details: { mission_id: mission.id, title: mission.title, user: userId },
  });
  return { mission, alreadyCompleted: false };
}

export function buildMissionListEmbed(missions) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Missões deste servidor')
    .setFooter({ text: 'Conclusões são autorrelatadas e registradas somente no Zond.' });
  if (!missions.length) {
    return embed.setDescription('Não há missões ativas cadastradas neste servidor.');
  }
  return embed.setDescription(missions.map((mission) => [
    `**#${mission.id} — ${mission.title}**`,
    mission.description,
    `Seu estado: ${mission.user_completed_at ? 'concluída' : 'pendente'}`,
  ].join('\n')).join('\n\n').slice(0, 4000));
}

export async function handleQuestSlash(interaction) {
  requireGuild(interaction.guildId);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'criar') {
    requireMissionManager(interaction.member);
    const id = createServerMission({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      title: interaction.options.getString('titulo', true),
      description: interaction.options.getString('descricao', true),
    });
    await interaction.reply({
      content: `Missão **#${id}** cadastrada. Os membros podem consultar \`/quest listar\` e registrar sua conclusão com \`/quest concluir\`.`,
      ephemeral: true,
    });
    return;
  }
  if (subcommand === 'listar') {
    const missions = listServerMissions(interaction.guildId, interaction.user.id);
    await interaction.reply({ embeds: [buildMissionListEmbed(missions)], ephemeral: true });
    return;
  }
  if (subcommand === 'concluir') {
    const { mission, alreadyCompleted } = completeServerMission({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      missionId: interaction.options.getInteger('missao', true),
    });
    await interaction.reply({
      content: alreadyCompleted
        ? `Você já havia registrado a conclusão de **${mission.title}** (#${mission.id}).`
        : `Conclusão de **${mission.title}** (#${mission.id}) registrada no Zond. Isso não altera quests oficiais do Discord.`,
      ephemeral: true,
    });
    return;
  }
  throw new Error('Subcomando de missão inválido.');
}

export async function handleQuestPrefix(message, args) {
  requireGuild(message.guildId);
  const [subcommand, ...rest] = args;
  if (subcommand === 'criar') {
    requireMissionManager(message.member);
    const separator = rest.join(' ').indexOf('|');
    if (separator < 0) {
      throw new Error('Uso: `!red quest criar Título da missão | descrição e instruções`.');
    }
    const input = rest.join(' ');
    const id = createServerMission({
      guildId: message.guildId,
      userId: message.author.id,
      title: input.slice(0, separator),
      description: input.slice(separator + 1),
    });
    await message.reply({
      content: `Missão **#${id}** cadastrada. Use \`!red quest listar\` para consultá-la.`,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (subcommand === 'listar') {
    const missions = listServerMissions(message.guildId, message.author.id);
    await message.reply({
      embeds: [buildMissionListEmbed(missions)],
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (subcommand === 'concluir') {
    const missionId = Number(rest[0]);
    const { mission, alreadyCompleted } = completeServerMission({
      guildId: message.guildId,
      userId: message.author.id,
      missionId,
    });
    await message.reply({
      content: alreadyCompleted
        ? `Você já havia registrado a conclusão de **${mission.title}** (#${mission.id}).`
        : `Conclusão de **${mission.title}** (#${mission.id}) registrada no Zond. Isso não altera quests oficiais do Discord.`,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await message.reply({
    content: 'Comandos: `!red quest listar`, `!red quest concluir <id>` ou, para administradores, `!red quest criar Título | descrição`.',
    allowedMentions: { parse: [] },
  });
}
