import 'dotenv/config';
import path from 'node:path';

const guildChannels = {
  missionsAvailable: '1553754448336134217',
  missionsUnavailable: '1553754453876674590',
  help: '1558800456015159316',
  newspaper: '1559187059200229527',
  changelog: '1553754390504931389',
  settings: '1553754443676123188',
  commands: '1553754428086026261',
  generalChat: '1553754422641692682',
  generalAnnouncements: '1546624099357429863',
  serverAnnouncements: '1553754373195309076',
  controlPanel: '1559371103120527450',
  adminLogs: '1554980393394897046',
  sourceStorePanel: '1559199953237184573',
  sourceStoreAnnouncements: '1559193612963676181',
  sourceStoreCatalog: '1559193420617097216',
  sourceStorePurchases: '1559193502598832138',
  sourceStorePurchaseLogs: '1554980500416893139',
  sourceStorePaymentLogs: '1554980597112504380',
};

const staffRoleIds = {
  founder: '1553754260766859415',
  direction: '1554981142791192596',
  management: '1554298196816044062',
  staff: '1554298379495018526',
  general: '1553816808560136342',
};

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  discordGuildId: process.env.DISCORD_GUILD_ID || '1546624097604345928',
  huehueApiKey: process.env.HUEHUE_API_KEY,
  nvidiaApiKey: process.env.NVIDIA_API_KEY,
  redCloudIconUrl: process.env.REDCLOUD_ICON_URL || null,
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/zond.sqlite'),
  productStoragePath: path.resolve(process.env.PRODUCT_STORAGE_PATH || './data/private-products'),
  productMaxZipBytes: Number(process.env.PRODUCT_MAX_ZIP_BYTES || 10 * 1024 * 1024),
  productMaxStorageBytes: Number(process.env.PRODUCT_MAX_STORAGE_BYTES || 1024 * 1024 * 1024),
  missionPollIntervalSeconds: Number(process.env.MISSION_POLL_INTERVAL_SECONDS || 300),
  missionExpiryWarningMinutes: Number(process.env.MISSION_EXPIRY_WARNING_MINUTES || 60),
  missionRemoveExpiredPosts: process.env.MISSION_REMOVE_EXPIRED_POSTS === 'true',
  missionActiveDays: Number(process.env.MISSION_ACTIVE_DAYS || 30),
  newsDefaultSources: [
    { name: 'BBC News World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  ],
  storeStaffOperations: (process.env.STORE_STAFF_OPERATIONS || 'list,catalog,stats')
    .split(',')
    .map((operation) => operation.trim())
    .filter(Boolean),
  channels: guildChannels,
  roles: staffRoleIds,
  emojiFallbacks: {
    warning: '⚠️',
    loading: '⏳',
    tools: '🛠️',
    search: '🔎',
    notFound: '❔',
    connectionFailure: '🔌',
    messages: '💬',
    files: '📁',
    highlight: '🌟',
    crown: '👑',
    help: '❓',
    buyer: '👤',
    purchases: '🛒',
    announcements: '📢',
    security: '🔐',
    form: '📝',
    ticket: '🎫',
    mission: '🎯',
    orb: '🔮',
  },
  prefix: '!red',
  ownerId: '1465430333007859948',
};

export function isAllowedGuild(guildId) {
  return Boolean(guildId && guildId === config.discordGuildId);
}

export function validateConfig() {
  const missing = ['DISCORD_TOKEN']
    .filter((name) => !process.env[name]);

  if (missing.length) {
    throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(', ')}`);
  }
  const numericSettings = [
    ['PRODUCT_MAX_ZIP_BYTES', config.productMaxZipBytes, 22, 25 * 1024 * 1024],
    ['PRODUCT_MAX_STORAGE_BYTES', config.productMaxStorageBytes, 22, Number.MAX_SAFE_INTEGER],
    ['MISSION_POLL_INTERVAL_SECONDS', config.missionPollIntervalSeconds, 60, 86400],
    ['MISSION_EXPIRY_WARNING_MINUTES', config.missionExpiryWarningMinutes, 1, 10080],
    ['MISSION_ACTIVE_DAYS', config.missionActiveDays, 1, 365],
  ];
  for (const [name, value, minimum, maximum] of numericSettings) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} deve ser um número inteiro entre ${minimum} e ${maximum}.`);
    }
  }
}
