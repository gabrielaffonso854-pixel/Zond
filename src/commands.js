import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { ticketCommand } from './tickets.js';
import { questCommand } from './quests.js';
import { missionCommand } from './missions.js';
import { storeCommand } from './store.js';
import { createNewsCommand } from './news.js';

const clearCommand = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Limpar mensagens ou configurar limpeza automática por canal')
  .addSubcommand((subcommand) => subcommand.setName('all').setDescription('Limpar as mensagens possíveis de um canal')
    .addChannelOption((option) => option.setName('canal').setDescription('Canal de texto; padrão: canal atual')
      .addChannelTypes(ChannelType.GuildText)))
  .addSubcommand((subcommand) => subcommand.setName('online').setDescription('Configurar limpeza automática de novas mensagens')
    .addStringOption((option) => option.setName('acao').setDescription('Ativar, desativar ou consultar o monitoramento')
      .addChoices(
        { name: 'ativar', value: 'ativar' },
        { name: 'desativar', value: 'desativar' },
        { name: 'status', value: 'status' },
      ).setRequired(true))
    .addChannelOption((option) => option.setName('canal').setDescription('Canal de texto monitorado')
      .addChannelTypes(ChannelType.GuildText)));

const antiCommand = new SlashCommandBuilder()
  .setName('anti')
  .setDescription('Configura as proteções do servidor')
  .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Consultar o estado das proteções'))
  .addSubcommand((subcommand) => subcommand.setName('config').setDescription('Abrir painel de configuração'))
  .addSubcommand((subcommand) => subcommand.setName('logs').setDescription('Consultar eventos recentes de proteção'))
  .addSubcommand((subcommand) => subcommand.setName('logchannel').setDescription('Configurar o canal de logs')
    .addChannelOption((option) => option.setName('canal').setDescription('Canal de texto de logs')
      .addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommandGroup((group) => group.setName('raid').setDescription('Controle anti-raid')
    .addSubcommand((subcommand) => subcommand.setName('on').setDescription('Ativar anti-raid'))
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('Desativar anti-raid')))
  .addSubcommandGroup((group) => group.setName('spam').setDescription('Controle anti-spam')
    .addSubcommand((subcommand) => subcommand.setName('on').setDescription('Ativar anti-spam'))
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('Desativar anti-spam')))
  .addSubcommandGroup((group) => group.setName('mention').setDescription('Controle anti-mention')
    .addSubcommand((subcommand) => subcommand.setName('on').setDescription('Ativar anti-mention'))
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('Desativar anti-mention')))
  .addSubcommandGroup((group) => group.setName('webhook').setDescription('Controle anti-webhook')
    .addSubcommand((subcommand) => subcommand.setName('on').setDescription('Ativar anti-webhook'))
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('Desativar anti-webhook')))
  .addSubcommandGroup((group) => group.setName('joins').setDescription('Controle anti-joins')
    .addSubcommand((subcommand) => subcommand.setName('on').setDescription('Ativar anti-joins'))
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('Desativar anti-joins')))
  .addSubcommandGroup((group) => group.setName('links').setDescription('Controle anti-links')
    .addSubcommand((subcommand) => subcommand.setName('on').setDescription('Ativar anti-links'))
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('Desativar anti-links'))
    .addSubcommand((subcommand) => subcommand.setName('domain').setDescription('Adicionar ou remover domínio bloqueado')
      .addStringOption((option) => option.setName('acao').setDescription('Operação')
        .addChoices({ name: 'adicionar', value: 'add' }, { name: 'remover', value: 'remove' }).setRequired(true))
      .addStringOption((option) => option.setName('lista').setDescription('Lista de domínios')
        .addChoices({ name: 'bloqueados', value: 'blocked' }, { name: 'autorizados', value: 'allowed' }).setRequired(true))
      .addStringOption((option) => option.setName('dominio').setDescription('Domínio sem protocolo')
        .setMaxLength(253).setRequired(true))
    )
    .addSubcommand((subcommand) => subcommand.setName('exception').setDescription('Gerenciar exceção de cargo ou canal')
      .addStringOption((option) => option.setName('acao').setDescription('Operação')
        .addChoices({ name: 'adicionar', value: 'add' }, { name: 'remover', value: 'remove' }).setRequired(true))
      .addRoleOption((option) => option.setName('cargo').setDescription('Cargo isento'))
      .addChannelOption((option) => option.setName('canal').setDescription('Canal isento')
        .addChannelTypes(ChannelType.GuildText))
    )
  );

export const commands = [
  new SlashCommandBuilder().setName('painel').setDescription('Atualizar ou localizar a Central RedCloud'),
  new SlashCommandBuilder().setName('status').setDescription('Consultar o estado geral dos serviços'),
  new SlashCommandBuilder().setName('discordinvite').setDescription('Divulgar o convite oficial da Zonde'),
  new SlashCommandBuilder().setName('discordver').setDescription('Consultar informações do servidor Discord Developers'),
  new SlashCommandBuilder().setName('ver').setDescription('Abrir o menu de ajuda da Zonde'),
  new SlashCommandBuilder().setName('zonde').setDescription('Informações da RedCloud')
    .addSubcommand((subcommand) => subcommand.setName('info').setDescription('Conheça a RedCloud'))
    .addSubcommand((subcommand) => subcommand.setName('owner').setDescription('Exibir a identificação do proprietário')),
  new SlashCommandBuilder().setName('ia').setDescription('Conversar com NVIDIA GLM-5.3 Flash')
    .addStringOption((option) => option.setName('mensagem').setDescription('O que você gostaria de saber?')
      .setMaxLength(4000).setRequired(true)),
  new SlashCommandBuilder().setName('iacriar').setDescription('Criar ou configurar recursos com assistência da IA'),
  new SlashCommandBuilder().setName('errorver').setDescription('Consultar erros técnicos recentes (restrito)'),
  antiCommand,
  clearCommand,
  createNewsCommand(),
  new SlashCommandBuilder().setName('news').setDescription('Consultar o estado do jornal RedCloud')
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Consultar agendamento e canal do jornal')),
  ticketCommand(),
  questCommand,
  missionCommand,
  storeCommand,
  new SlashCommandBuilder().setName('disponiveis').setDescription('Configurar canal de missões disponíveis')
    .addChannelOption((option) => option.setName('canal').setDescription('Canal de texto')
      .addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('indisponiveis').setDescription('Configurar canal de missões indisponíveis')
    .addChannelOption((option) => option.setName('canal').setDescription('Canal de texto')
      .addChannelTypes(ChannelType.GuildText).setRequired(true)),
];

export function commandPayload() {
  return commands.map((command) => command.toJSON());
}

export function parseAntiSlash(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  if (group) return { group, subcommand };
  if (subcommand === 'logchannel') return { group: null, subcommand, channel: interaction.options.getChannel('canal') };
  return { group: null, subcommand };
}

export function isAdmin(member) {
  return member?.permissions?.has(PermissionFlagsBits.Administrator) || false;
}
