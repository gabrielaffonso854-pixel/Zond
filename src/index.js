import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from 'discord.js';
import { config, isAllowedGuild, validateConfig } from './config.js';
import { recordError } from './errors.js';
import { handleGuildMessage, handleMemberJoin, handleWebhookUpdate } from './anti.js';
import { bindEvents, getReadyHandler } from './handlers.js';
import { recordMissionActivity } from './missions.js';

validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const rest = new REST({ version: '10' }).setToken(config.discordToken);

bindEvents(client);
client.once(Events.ClientReady, getReadyHandler(client, rest, Routes));
client.on(Events.MessageCreate, (message) => {
  if (!isAllowedGuild(message.guildId)) return;
  if (!message.author.bot) recordMissionActivity(message.guildId, message.author.id);
  handleGuildMessage(message).catch((error) => {
    recordError({ service: 'anti', step: 'análise de mensagem', error });
  });
});
client.on(Events.GuildMemberAdd, (member) => {
  if (!isAllowedGuild(member.guild.id)) return;
  handleMemberJoin(member).catch((error) => {
    recordError({ service: 'anti', step: 'entrada de membro', error });
  });
});
client.on(Events.WebhooksUpdate, (channel) => {
  if (!isAllowedGuild(channel.guildId)) return;
  handleWebhookUpdate(channel.guild).catch((error) => {
    recordError({ service: 'anti-webhook', step: 'evento de webhook', error });
  });
});
client.on(Events.Error, (error) => {
  recordError({ service: 'discord', step: 'cliente', error });
});

process.on('unhandledRejection', (error) => {
  recordError({ service: 'node', step: 'unhandledRejection', error });
});
process.on('uncaughtException', (error) => {
  recordError({ service: 'node', step: 'uncaughtException', error });
  process.exitCode = 1;
});

client.login(config.discordToken).catch((error) => {
  recordError({ service: 'discord', step: 'login', error });
  console.error('Não foi possível iniciar a sessão Discord; verifique DISCORD_TOKEN.');
  process.exitCode = 1;
});
