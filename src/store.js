import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
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
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from './config.js';
import { db, getSetting, setSetting, storeSystemLog } from './db.js';
import { recordError } from './errors.js';

const COLOR = 0xC8102E;
const ZIP_DOWNLOAD_TIMEOUT_MS = 30_000;
const SAFE_STAFF_OPERATIONS = new Set(['list', 'catalog', 'stats', 'payment_confirm', 'deliver', 'resend']);
const ADMIN_OPERATIONS = new Set(['create', 'edit', 'activate', 'price', 'upload', 'buyer_order', 'payment_confirm', 'deliver', 'resend', 'panel']);
const channelLogByType = {
  product: 'sourceStorePurchaseLogs',
  payment: 'sourceStorePaymentLogs',
  delivery: 'sourceStorePurchaseLogs',
  admin: 'adminLogs',
};

db.exec(`
  CREATE TABLE IF NOT EXISTS source_store_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive')),
    current_file_id TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_store_files (
    id TEXT PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES source_store_products(id),
    internal_filename TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_store_upload_reservations (
    id TEXT PRIMARY KEY,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_store_orders (
    id TEXT PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES source_store_products(id),
    file_id TEXT NOT NULL REFERENCES source_store_files(id),
    buyer_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    status TEXT NOT NULL CHECK (status IN (
      'awaiting_payment', 'payment_confirmed', 'delivery_pending',
      'delivery_completed', 'delivery_failed', 'cancelled'
    )),
    payment_confirmed_by TEXT,
    payment_confirmed_at TEXT,
    last_delivery_authorized_by TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS source_store_orders_buyer ON source_store_orders(buyer_id, created_at);
  CREATE INDEX IF NOT EXISTS source_store_orders_status ON source_store_orders(status, created_at);
  CREATE TABLE IF NOT EXISTS source_store_delivery_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES source_store_orders(id),
    attempt_number INTEGER NOT NULL,
    authorized_by TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    error_summary TEXT,
    UNIQUE (order_id, attempt_number)
  );
  CREATE INDEX IF NOT EXISTS source_store_delivery_order ON source_store_delivery_attempts(order_id, attempt_number);
`);

export const storeCommand = new SlashCommandBuilder()
  .setName('loja')
  .setDescription('Catálogo e loja privada de códigos-fonte')
  .addSubcommand((subcommand) => subcommand.setName('painel').setDescription('Atualizar o painel administrativo persistente'))
  .addSubcommand((subcommand) => subcommand.setName('catalogo').setDescription('Consultar produtos disponíveis'))
  .addSubcommand((subcommand) => subcommand.setName('listar').setDescription('Listar produtos cadastrados'))
  .addSubcommand((subcommand) => subcommand.setName('cadastrar').setDescription('Cadastrar um produto')
    .addStringOption((option) => option.setName('nome').setDescription('Nome do produto').setMaxLength(100).setRequired(true))
    .addStringOption((option) => option.setName('descricao').setDescription('Descrição do produto').setMaxLength(1000).setRequired(true))
    .addStringOption((option) => option.setName('preco').setDescription('Preço decimal (ex.: 19.90)').setMaxLength(12).setRequired(true))
    .addStringOption((option) => option.setName('categoria').setDescription('Categoria').setMaxLength(80).setRequired(true))
    .addAttachmentOption((option) => option.setName('arquivo').setDescription('ZIP privado do produto')))
  .addSubcommand((subcommand) => subcommand.setName('editar').setDescription('Editar nome, descrição ou categoria')
    .addIntegerOption((option) => option.setName('produto').setDescription('ID do produto').setMinValue(1).setRequired(true))
    .addStringOption((option) => option.setName('nome').setDescription('Novo nome').setMaxLength(100))
    .addStringOption((option) => option.setName('descricao').setDescription('Nova descrição').setMaxLength(1000))
    .addStringOption((option) => option.setName('categoria').setDescription('Nova categoria').setMaxLength(80)))
  .addSubcommand((subcommand) => subcommand.setName('arquivo').setDescription('Anexar ou substituir o ZIP privado')
    .addIntegerOption((option) => option.setName('produto').setDescription('ID do produto').setMinValue(1).setRequired(true))
    .addAttachmentOption((option) => option.setName('zip').setDescription('Arquivo ZIP').setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('ativar').setDescription('Ativar ou desativar um produto')
    .addIntegerOption((option) => option.setName('produto').setDescription('ID do produto').setMinValue(1).setRequired(true))
    .addBooleanOption((option) => option.setName('ativo').setDescription('Disponível no catálogo').setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('preco').setDescription('Definir o preço de um produto')
    .addIntegerOption((option) => option.setName('produto').setDescription('ID do produto').setMinValue(1).setRequired(true))
    .addStringOption((option) => option.setName('valor').setDescription('Preço decimal (ex.: 19.90)').setMaxLength(12).setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('comprar').setDescription('Criar um pedido para sua conta')
    .addIntegerOption((option) => option.setName('produto').setDescription('ID do produto').setMinValue(1).setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('cancelar').setDescription('Cancelar seu pedido ainda não pago')
    .addStringOption((option) => option.setName('pedido').setDescription('ID do pedido').setMaxLength(36).setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('pedido').setDescription('Criar pedido para um comprador selecionado')
    .addIntegerOption((option) => option.setName('produto').setDescription('ID do produto').setMinValue(1).setRequired(true))
    .addUserOption((option) => option.setName('comprador').setDescription('Destinatário do pedido').setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('confirmar').setDescription('Confirmar manualmente um pagamento verificado')
    .addStringOption((option) => option.setName('pedido').setDescription('ID do pedido').setMaxLength(36).setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('entregar').setDescription('Entregar um pedido já confirmado')
    .addStringOption((option) => option.setName('pedido').setDescription('ID do pedido').setMaxLength(36).setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('reenviar').setDescription('Autorizar explicitamente o reenvio de um pedido')
    .addStringOption((option) => option.setName('pedido').setDescription('ID do pedido').setMaxLength(36).setRequired(true))
    .addBooleanOption((option) => option.setName('confirmar').setDescription('Confirma que verificou o estado do envio anterior').setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('vendas').setDescription('Consultar pedidos e entregas'));

export function parsePrice(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(text)) throw new Error('Informe um preço válido, por exemplo 19.90.');
  const [units, fraction = ''] = text.split('.');
  const cents = Number(units) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 99_999_999) throw new Error('O preço informado excede o limite permitido.');
  return cents;
}

function validatePriceCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 99_999_999) {
    throw new Error('O preço deve estar entre R$ 0,00 e R$ 999.999,99.');
  }
  return cents;
}

function formatPrice(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

export function validateZipBuffer(buffer, maxBytes = config.productMaxZipBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('O arquivo não é um ZIP completo ou está vazio.');
  if (buffer.length > maxBytes) throw new Error(`O ZIP excede o limite configurado de ${maxBytes} bytes.`);
  let eocd = -1;
  const searchStart = Math.max(0, buffer.length - 65_557);
  for (let index = buffer.length - 22; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('O ZIP não contém um diretório central final válido.');
  const commentLength = buffer.readUInt16LE(eocd + 20);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (eocd + 22 + commentLength !== buffer.length || diskNumber !== 0 || directoryDisk !== 0
    || entriesOnDisk !== entryCount || entryCount === 0 || entryCount === 0xffff
    || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || directoryOffset + directorySize > eocd) {
    throw new Error('A estrutura ZIP é inválida, vazia, segmentada ou ZIP64 não suportado.');
  }
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('O diretório central do ZIP está incompleto ou corrompido.');
    }
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + filenameLength + extraLength + fileCommentLength;
    if (next > eocd || localHeaderOffset + 30 > directoryOffset
      || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error('Um arquivo interno do ZIP possui cabeçalho ou caminho inválido.');
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > directoryOffset) {
      throw new Error('Os dados de um arquivo interno excedem os limites do ZIP.');
    }
    cursor = next;
  }
  if (cursor !== directoryOffset + directorySize) {
    throw new Error('O tamanho do diretório central do ZIP não confere.');
  }
  return { byteSize: buffer.length, entryCount };
}

export function getStoreStorageUsage() {
  return db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM source_store_files').get().bytes;
}

function reserveStoreStorage(fileId, byteSize) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cutoff = new Date(Date.now() - 3_600_000).toISOString();
    db.prepare('DELETE FROM source_store_upload_reservations WHERE created_at < ?').run(cutoff);
    const reserved = db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM source_store_upload_reservations').get().bytes;
    if (getStoreStorageUsage() + reserved + byteSize > config.productMaxStorageBytes) {
      throw new Error(`O armazenamento privado excederia a cota de ${config.productMaxStorageBytes} bytes.`);
    }
    db.prepare('INSERT INTO source_store_upload_reservations (id, byte_size, created_at) VALUES (?, ?, ?)')
      .run(fileId, byteSize, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function safeOriginalFilename(value) {
  const base = path.basename(String(value || 'produto.zip')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  if (!base || base === '.' || base === '..' || !base.toLowerCase().endsWith('.zip')) {
    throw new Error('O anexo precisa ter extensão .zip.');
  }
  return base;
}

function ensurePrivateStorage() {
  fs.mkdirSync(config.productStoragePath, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(config.productStoragePath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('PRODUCT_STORAGE_PATH precisa apontar para uma pasta privada real, não para um link simbólico.');
  }
  fs.chmodSync(config.productStoragePath, 0o700);
}

function getProduct(productId) {
  const product = db.prepare(`
    SELECT p.*, f.original_filename, f.byte_size, f.sha256
    FROM source_store_products p
    LEFT JOIN source_store_files f ON f.id = p.current_file_id
    WHERE p.id = ?
  `).get(productId);
  if (!product) throw new Error('Produto não encontrado.');
  return product;
}

function storeLog(guildId, category, eventType, details) {
  storeSystemLog({ guildId, module: 'source-store', eventType, details });
  const guild = storeClient?.guilds.cache.get(guildId);
  if (!guild) return;
  const description = Object.entries(details)
    .map(([key, value]) => `• **${key}:** ${String(value).slice(0, 200)}`)
    .join('\n')
    .slice(0, 3500);
  const channelIds = new Set([config.channels[channelLogByType[category]], config.channels.adminLogs]);
  for (const channelId of channelIds) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased() || !channel.permissionsFor(guild.members.me)?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])) {
      recordError({
        service: 'source-store',
        step: `permissões do canal de log ${category}`,
        error: new Error(`Canal de log não disponível para o evento ${eventType}.`),
      });
      continue;
    }
    void channel.send({
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle(`Loja • ${eventType}`).setDescription(description).setTimestamp()],
      allowedMentions: { parse: [] },
    }).catch((error) => recordError({ service: 'source-store', step: `log ${category}`, error }));
  }
}

let storeClient;

function rolesFor(member) {
  return member?.roles?.cache;
}

export function canManageStore(member, operation) {
  const roles = rolesFor(member);
  if (!roles) return false;
  if (roles.has(config.roles.founder)) return true;
  if (roles.has(config.roles.direction) || roles.has(config.roles.management)) {
    return ADMIN_OPERATIONS.has(operation);
  }
  if (!roles.has(config.roles.staff)) return false;
  return SAFE_STAFF_OPERATIONS.has(operation) && config.storeStaffOperations.includes(operation);
}

function requireStorePermission(member, operation) {
  if (!canManageStore(member, operation)) {
    throw new Error('Você não possui o cargo autorizado para esta operação da loja.');
  }
}

export function createStoreProduct({ name, description, price, category, actorId }) {
  const cleanName = String(name || '').trim();
  const cleanDescription = String(description || '').trim();
  const cleanCategory = String(category || '').trim();
  if (!cleanName || cleanName.length > 100 || !cleanDescription || cleanDescription.length > 1000
    || !cleanCategory || cleanCategory.length > 80) {
    throw new Error('Nome, descrição ou categoria vazios ou acima do limite permitido.');
  }
  const cents = validatePriceCents(Number.isSafeInteger(price) ? price : parsePrice(price));
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO source_store_products
      (name, description, price_cents, category, status, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, 'inactive', ?, ?, ?, ?)
  `).run(cleanName, cleanDescription, cents, cleanCategory, now, actorId, now, actorId);
  const productId = Number(result.lastInsertRowid);
  storeLog(config.discordGuildId, 'product', 'produto cadastrado', { produto: productId, nome: cleanName, responsavel: actorId });
  return getProduct(productId);
}

export function editStoreProduct({ productId, updates, actorId }) {
  const current = getProduct(productId);
  const name = updates.name === undefined ? current.name : String(updates.name).trim();
  const description = updates.description === undefined ? current.description : String(updates.description).trim();
  const category = updates.category === undefined ? current.category : String(updates.category).trim();
  if (!name || name.length > 100 || !description || description.length > 1000 || !category || category.length > 80) {
    throw new Error('Nome, descrição ou categoria vazios ou acima do limite permitido.');
  }
  db.prepare(`
    UPDATE source_store_products SET name = ?, description = ?, category = ?, updated_at = ?, updated_by = ?
    WHERE id = ?
  `).run(name, description, category, new Date().toISOString(), actorId, productId);
  storeLog(config.discordGuildId, 'product', 'produto editado', { produto: productId, responsavel: actorId });
  return getProduct(productId);
}

export function setStoreProductPrice(productId, price, actorId) {
  const product = getProduct(productId);
  const cents = validatePriceCents(Number.isSafeInteger(price) ? price : parsePrice(price));
  db.prepare('UPDATE source_store_products SET price_cents = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(cents, new Date().toISOString(), actorId, productId);
  storeLog(config.discordGuildId, 'product', 'preço alterado', { produto: productId, preco: formatPrice(cents), responsavel: actorId });
  return { ...product, price_cents: cents };
}

export function setStoreProductActive(productId, active, actorId) {
  const product = getProduct(productId);
  if (active && !product.current_file_id) throw new Error('Anexe um ZIP válido antes de ativar o produto.');
  db.prepare('UPDATE source_store_products SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(active ? 'active' : 'inactive', new Date().toISOString(), actorId, productId);
  storeLog(config.discordGuildId, 'product', active ? 'produto ativado' : 'produto desativado', {
    produto: productId,
    responsavel: actorId,
  });
  return getProduct(productId);
}

export async function attachStoreProductZip({ productId, attachment, actorId }) {
  getProduct(productId);
  const originalFilename = safeOriginalFilename(attachment?.name);
  if (path.extname(originalFilename).toLowerCase() !== '.zip') throw new Error('O anexo precisa ter extensão .zip.');
  if (!Number.isSafeInteger(config.productMaxZipBytes) || config.productMaxZipBytes < 22) {
    throw new Error('PRODUCT_MAX_ZIP_BYTES precisa ser um inteiro de pelo menos 22 bytes.');
  }
  if (!Number.isSafeInteger(config.productMaxStorageBytes) || config.productMaxStorageBytes < 22) {
    throw new Error('PRODUCT_MAX_STORAGE_BYTES precisa ser um inteiro de pelo menos 22 bytes.');
  }
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0) {
    throw new Error('O anexo não informa um tamanho válido.');
  }
  if (attachment.size > config.productMaxZipBytes) {
    throw new Error(`O arquivo excede o limite local de ${config.productMaxZipBytes} bytes.`);
  }
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || url.username || url.password
    || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
    throw new Error('A URL do anexo não é um endereço HTTPS confiável do Discord.');
  }
  ensurePrivateStorage();
  const fileId = crypto.randomUUID();
  const internalFilename = `${fileId}.zip`;
  const finalPath = path.join(config.productStoragePath, internalFilename);
  const temporaryPath = `${finalPath}.tmp`;
  reserveStoreStorage(fileId, attachment.size);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ZIP_DOWNLOAD_TIMEOUT_MS);
  let byteSize = 0;
  let databaseCommitted = false;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Não foi possível baixar o anexo Discord (HTTP ${response.status}).`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > config.productMaxZipBytes) {
      throw new Error('O anexo excede o limite local de armazenamento.');
    }
    const countBytes = new Transform({
      transform(chunk, encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > config.productMaxZipBytes) callback(new Error('O ZIP excedeu o limite durante o download.'));
        else callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), countBytes, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    if (byteSize !== attachment.size) throw new Error('O tamanho baixado do anexo não corresponde ao tamanho informado pelo Discord.');
    const buffer = await fs.promises.readFile(temporaryPath);
    validateZipBuffer(buffer);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    await fs.promises.rename(temporaryPath, finalPath);
    await fs.promises.chmod(finalPath, 0o600);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO source_store_files (id, product_id, internal_filename, original_filename, byte_size, sha256, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fileId, productId, internalFilename, originalFilename, byteSize, sha256, now, actorId);
      db.prepare(`
        UPDATE source_store_products SET current_file_id = ?, updated_at = ?, updated_by = ?
        WHERE id = ?
      `).run(fileId, now, actorId, productId);
      db.prepare('DELETE FROM source_store_upload_reservations WHERE id = ?').run(fileId);
      db.exec('COMMIT');
      databaseCommitted = true;
    } catch (databaseError) {
      db.exec('ROLLBACK');
      throw databaseError;
    }
    storeLog(config.discordGuildId, 'product', 'arquivo ZIP anexado', {
      produto: productId,
      bytes: byteSize,
      responsavel: actorId,
    });
    return getProduct(productId);
  } catch (error) {
    if (!databaseCommitted) {
      db.prepare('DELETE FROM source_store_upload_reservations WHERE id = ?').run(fileId);
      await fs.promises.unlink(temporaryPath).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') recordError({ service: 'source-store', step: 'limpeza de arquivo temporário', error: unlinkError });
      });
      await fs.promises.unlink(finalPath).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') recordError({ service: 'source-store', step: 'limpeza de ZIP rejeitado', error: unlinkError });
      });
    }
    if (error.name === 'AbortError') throw new Error('O download do ZIP excedeu o tempo limite.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function listStoreProducts({ activeOnly = false } = {}) {
  return db.prepare(`
    SELECT p.id, p.name, p.description, p.price_cents, p.category, p.status, p.current_file_id,
      p.created_at, p.created_by, p.updated_at, p.updated_by
    FROM source_store_products p
    WHERE (? = 0 OR p.status = 'active')
    ORDER BY p.id DESC LIMIT 100
  `).all(activeOnly ? 1 : 0);
}

export function createStoreOrder({ productId, buyerId }) {
  const product = getProduct(productId);
  if (product.status !== 'active' || !product.current_file_id) throw new Error('Este produto não está disponível para compra.');
  const pending = db.prepare(`
    SELECT id FROM source_store_orders
    WHERE product_id = ? AND buyer_id = ? AND status = 'awaiting_payment'
    ORDER BY created_at DESC LIMIT 1
  `).get(productId, buyerId);
  if (pending) return { id: pending.id, existing: true, product };
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO source_store_orders
      (id, product_id, file_id, buyer_id, product_name, price_cents, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?)
  `).run(orderId, product.id, product.current_file_id, buyerId, product.name, product.price_cents, now, now);
  storeLog(config.discordGuildId, 'payment', 'pedido criado aguardando confirmação manual', {
    pedido: orderId,
    produto: product.id,
    comprador: buyerId,
  });
  return { id: orderId, existing: false, product };
}

export function confirmStorePayment(orderId, actorId) {
  const result = db.prepare(`
    UPDATE source_store_orders
    SET status = 'payment_confirmed', payment_confirmed_by = ?, payment_confirmed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'awaiting_payment'
  `).run(actorId, new Date().toISOString(), new Date().toISOString(), orderId);
  if (!result.changes) throw new Error('Pedido não encontrado ou não está aguardando confirmação de pagamento.');
  const order = getStoreOrder(orderId);
  storeLog(config.discordGuildId, 'payment', 'pagamento confirmado manualmente', {
    pedido: order.id,
    produto: order.product_name,
    confirmado_por: actorId,
  });
  return order;
}

export function cancelStoreOrder(orderId, buyerId) {
  const result = db.prepare(`
    UPDATE source_store_orders SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND buyer_id = ? AND status = 'awaiting_payment'
  `).run(new Date().toISOString(), orderId, buyerId);
  if (!result.changes) throw new Error('Só é possível cancelar seu próprio pedido enquanto aguarda pagamento.');
  storeLog(config.discordGuildId, 'payment', 'pedido cancelado pelo comprador', { pedido: orderId, comprador: buyerId });
  return getStoreOrder(orderId);
}

export function getStoreOrder(orderId) {
  const order = db.prepare(`
    SELECT o.*, f.internal_filename, f.original_filename, f.byte_size, f.sha256
    FROM source_store_orders o
    JOIN source_store_files f ON f.id = o.file_id
    WHERE o.id = ?
  `).get(orderId);
  if (!order) throw new Error('Pedido não encontrado.');
  return order;
}

function beginDelivery(order, actorId, forceResend) {
  const allowedStates = forceResend
    ? ['payment_confirmed', 'delivery_failed', 'delivery_completed', 'delivery_pending']
    : ['payment_confirmed', 'delivery_failed'];
  if (!allowedStates.includes(order.status)) {
    throw new Error(order.status === 'delivery_pending'
      ? 'Há uma tentativa de entrega sem resultado final. Verifique os logs e use reenvio explícito somente após conferir o estado da DM.'
      : 'O pedido precisa ter pagamento confirmado antes da entrega.');
  }
  const attempts = db.prepare('SELECT COUNT(*) AS count FROM source_store_delivery_attempts WHERE order_id = ?').get(order.id).count;
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE source_store_orders SET status = 'delivery_pending', last_delivery_authorized_by = ?, updated_at = ?
    WHERE id = ? AND status = ?
  `).run(actorId, now, order.id, order.status);
  if (!update.changes) throw new Error('O estado do pedido mudou; consulte o pedido antes de tentar novamente.');
  db.prepare(`
    INSERT INTO source_store_delivery_attempts (order_id, attempt_number, authorized_by, started_at, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(order.id, attempts + 1, actorId, now);
  return attempts + 1;
}

export async function deliverStoreOrder({ client, orderId, actorId, forceResend = false }) {
  const order = getStoreOrder(orderId);
  const attempt = beginDelivery(order, actorId, forceResend);
  const filePath = path.join(config.productStoragePath, order.internal_filename);
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== order.byte_size || stats.size > config.productMaxZipBytes) {
      throw new Error('O arquivo privado do pedido não está íntegro ou excede o limite configurado.');
    }
    const zipBytes = await fs.promises.readFile(filePath);
    validateZipBuffer(zipBytes);
    if (crypto.createHash('sha256').update(zipBytes).digest('hex') !== order.sha256) {
      throw new Error('A verificação de integridade do ZIP falhou; o arquivo não foi enviado.');
    }
    const recipient = await client.users.fetch(order.buyer_id);
    await recipient.send({
      content: `Entrega confirmada: **${order.product_name}**. Pedido \`${order.id}\`.`,
      files: [new AttachmentBuilder(filePath, { name: order.original_filename })],
      allowedMentions: { parse: [] },
    });
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE source_store_orders SET status = 'delivery_completed', delivered_at = ?, updated_at = ?
      WHERE id = ? AND status = 'delivery_pending'
    `).run(completedAt, completedAt, order.id);
    db.prepare(`
      UPDATE source_store_delivery_attempts SET status = 'completed', completed_at = ?
      WHERE order_id = ? AND attempt_number = ?
    `).run(completedAt, order.id, attempt);
    storeLog(config.discordGuildId, 'delivery', 'entrega concluída por mensagem privada', {
      pedido: order.id,
      produto: order.product_id,
      comprador: order.buyer_id,
      autorizado_por: actorId,
      tentativa: attempt,
    });
    return { orderId, attempt, status: 'delivery_completed' };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const summary = error.code === 50007
      ? 'O comprador bloqueou mensagens diretas do servidor.'
      : String(error.message || 'Falha no envio da DM.').slice(0, 300);
    db.prepare(`
      UPDATE source_store_orders SET status = 'delivery_failed', updated_at = ?
      WHERE id = ? AND status = 'delivery_pending'
    `).run(failedAt, order.id);
    db.prepare(`
      UPDATE source_store_delivery_attempts SET status = 'failed', completed_at = ?, error_summary = ?
      WHERE order_id = ? AND attempt_number = ?
    `).run(failedAt, summary, order.id, attempt);
    storeLog(config.discordGuildId, 'delivery', 'falha na entrega por mensagem privada', {
      pedido: order.id,
      produto: order.product_id,
      comprador: order.buyer_id,
      autorizado_por: actorId,
      tentativa: attempt,
      motivo: summary,
    });
    recordError({ service: 'source-store', step: 'entrega de produto por DM', error });
    throw new Error(summary);
  }
}

export function getStoreStats() {
  return db.prepare(`
    SELECT status, COUNT(*) AS count FROM source_store_orders GROUP BY status ORDER BY status
  `).all();
}

export function buildStoreCatalogPayload(page = 0) {
  const allProducts = listStoreProducts({ activeOnly: true }).filter((product) => product.current_file_id);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(allProducts.length / pageSize));
  const safePage = Number.isSafeInteger(page) ? Math.min(Math.max(page, 0), pageCount - 1) : 0;
  const products = allProducts.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${config.emojiFallbacks.purchases} Source Codes • Catálogo`)
    .setDescription(products.length
      ? `Página ${safePage + 1}/${pageCount}. Produtos disponíveis. Pedidos aguardam confirmação manual verificada do pagamento.`
      : 'Não há produtos ativos disponíveis no momento.')
    .setFooter({ text: 'zond-source-store-catalog • Nenhum clique ou comprovante confirma pagamento.' });
  const rows = [];
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    embed.addFields({
      name: `#${product.id} • ${product.name} • ${formatPrice(product.price_cents)}`,
      value: `**Categoria:** ${product.category}\n${product.description.slice(0, 250)}`,
    });
    if (index % 5 === 0) rows.push(new ActionRowBuilder());
    rows.at(-1).addComponents(new ButtonBuilder()
      .setCustomId(`store:buy:${product.id}`)
      .setLabel(`Comprar #${product.id}`)
      .setStyle(ButtonStyle.Success));
  }
  if (pageCount > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`store:catalog:page:${Math.max(0, safePage - 1)}`)
        .setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
      new ButtonBuilder().setCustomId(`store:catalog:page:${Math.min(pageCount - 1, safePage + 1)}`)
        .setLabel('Próxima').setStyle(ButtonStyle.Secondary).setDisabled(safePage === pageCount - 1),
    ));
  }
  return { embeds: [embed], components: rows };
}

function buildAdminPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${config.emojiFallbacks.tools} Source Codes • Painel administrativo`)
    .setDescription([
      'Use os botões ou os comandos `/loja` para administrar o catálogo e as entregas.',
      'Pagamentos são confirmados manualmente por equipe autorizada. Cliques e comprovantes não confirmam pagamentos.',
      `Arquivos ZIP são privados em \`${path.basename(config.productStoragePath)}\`; tamanho máximo local: ${config.productMaxZipBytes} bytes.`,
    ].join('\n'))
    .setFooter({ text: 'zond-source-store-admin-panel' });
  const actions = [
    ['create', 'Cadastrar produto', ButtonStyle.Primary],
    ['list', 'Listar produtos', ButtonStyle.Secondary],
    ['edit', 'Editar produto', ButtonStyle.Secondary],
    ['activate', 'Ativar/desativar', ButtonStyle.Secondary],
    ['price', 'Definir preço', ButtonStyle.Secondary],
    ['upload', 'Anexar ZIP', ButtonStyle.Secondary],
    ['buyer', 'Selecionar comprador', ButtonStyle.Secondary],
    ['deliver', 'Entregar produto', ButtonStyle.Success],
    ['stats', 'Vendas e entregas', ButtonStyle.Secondary],
    ['resend', 'Reenviar produto', ButtonStyle.Danger],
  ];
  const rows = [];
  actions.forEach(([action, label, style], index) => {
    if (index % 5 === 0) rows.push(new ActionRowBuilder());
    rows.at(-1).addComponents(new ButtonBuilder().setCustomId(`store:panel:${action}`).setLabel(label).setStyle(style));
  });
  return { embeds: [embed], components: rows };
}

async function persistentMessage(guild, channelId, settingKey, marker, payload) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error(`Canal ${channelId} não existe ou não é texto.`);
  if (!channel.permissionsFor(guild.members.me)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ])) throw new Error(`O bot não possui permissões para atualizar o painel no canal ${channelId}.`);
  const savedId = getSetting(guild.id, settingKey);
  let message = null;
  if (savedId) {
    try {
      message = await channel.messages.fetch(savedId);
    } catch (error) {
      if (error.code !== 10008) throw error;
    }
  }
  if (!message) {
    const recent = await channel.messages.fetch({ limit: 100 });
    message = recent.find((item) => item.embeds.some((embed) => embed.footer?.text === marker));
  }
  if (message) await message.edit(payload);
  else message = await channel.send(payload);
  setSetting(guild.id, settingKey, message.id);
  return message;
}

export async function ensureStorePanels(guild) {
  storeClient = guild.client;
  await persistentMessage(guild, config.channels.sourceStorePanel, 'store_admin_panel_message', 'zond-source-store-admin-panel', buildAdminPanelPayload());
  await persistentMessage(guild, config.channels.sourceStoreCatalog, 'store_catalog_message', 'zond-source-store-catalog', buildStoreCatalogPayload());
  await refreshStoreAnnouncement(guild);
}

async function refreshStoreCatalog(guild) {
  await persistentMessage(guild, config.channels.sourceStoreCatalog, 'store_catalog_message', 'zond-source-store-catalog', buildStoreCatalogPayload());
  await refreshStoreAnnouncement(guild);
}

async function refreshStoreAnnouncement(guild) {
  const activeCount = listStoreProducts({ activeOnly: true }).filter((product) => product.current_file_id).length;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${config.emojiFallbacks.announcements} Catálogo Source Codes atualizado`)
    .setDescription(`**${activeCount}** produto(s) ativo(s) com arquivo disponível.\nConsulte <#${config.channels.sourceStoreCatalog}>.`)
    .setFooter({ text: 'zond-source-store-announcement' });
  await persistentMessage(
    guild,
    config.channels.sourceStoreAnnouncements,
    'store_announcement_message',
    'zond-source-store-announcement',
    { embeds: [embed], allowedMentions: { parse: [] } },
  );
}

function productListEmbed(products, title = 'Produtos Source Codes') {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(title);
  if (!products.length) return embed.setDescription('Nenhum produto cadastrado.');
  return embed.setDescription(products.map((product) => [
    `**#${product.id} — ${product.name}**`,
    `${product.status === 'active' ? 'Ativo' : 'Inativo'} • ${formatPrice(product.price_cents)} • ${product.category}`,
    `ZIP: ${product.current_file_id ? 'anexado' : 'não anexado'}`,
  ].join('\n')).join('\n\n').slice(0, 3900));
}

function orderListEmbed(orders) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Pedidos e entregas Source Codes');
  if (!orders.length) return embed.setDescription('Nenhum pedido foi registrado.');
  return embed.setDescription(orders.map((order) => [
    `**${order.id}** — ${order.product_name}`,
    `${formatPrice(order.price_cents)} • <@${order.buyer_id}> • ${order.status}`,
    `Criado: <t:${Math.floor(Date.parse(order.created_at) / 1000)}:R>`,
  ].join('\n')).join('\n\n').slice(0, 3900));
}

function recentStoreOrders(limit = 20) {
  return db.prepare(`
    SELECT id, product_name, price_cents, buyer_id, status, created_at
    FROM source_store_orders ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function orderReceipt(order) {
  return `Pedido \`${order.id}\` criado para **${order.product.name}** por ${formatPrice(order.product.price_cents)}. Estado: **aguardando pagamento**. A equipe confirmará o pagamento manualmente após validação.`;
}

export function handlesStoreInteraction(interaction) {
  return interaction.isButton() && interaction.customId.startsWith('store:')
    || interaction.isModalSubmit() && interaction.customId === 'store:create:modal';
}

async function handleStorePanelButton(interaction, action) {
  const operation = ({
    create: 'create',
    list: 'list',
    edit: 'edit',
    activate: 'activate',
    price: 'price',
    upload: 'upload',
    buyer: 'buyer_order',
    deliver: 'deliver',
    stats: 'stats',
    resend: 'resend',
  })[action];
  if (!operation) throw new Error('Ação inválida no painel da loja.');
  if (operation === 'create') {
    requireStorePermission(interaction.member, operation);
    const modal = new ModalBuilder().setCustomId('store:create:modal').setTitle('Cadastrar produto')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nome')
          .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Descrição')
          .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('Preço (ex.: 19.90)')
          .setStyle(TextInputStyle.Short).setMaxLength(12).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Categoria')
          .setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
      );
    await interaction.showModal(modal);
    return;
  }
  requireStorePermission(interaction.member, operation);
  if (action === 'list') {
    await interaction.reply({ embeds: [productListEmbed(listStoreProducts())], ephemeral: true });
    return;
  }
  if (action === 'stats') {
    const stats = getStoreStats();
    await interaction.reply({ embeds: [orderListEmbed(recentStoreOrders())], content: `Resumo: ${stats.map((row) => `${row.status}: ${row.count}`).join(' • ') || 'sem pedidos'}`, ephemeral: true });
    return;
  }
  const command = ({
    edit: 'editar',
    activate: 'ativar',
    price: 'preco',
    upload: 'arquivo',
    buyer: 'pedido',
    deliver: 'entregar',
    resend: 'reenviar',
  })[action] || action;
  await interaction.reply({
    content: `Para concluir esta operação com validação persistente, use \`/loja ${command}\`. Os comandos verificam novamente o seu cargo antes de alterar dados.`,
    ephemeral: true,
  });
}

export async function handleStoreInteraction(interaction) {
  if (interaction.isModalSubmit()) {
    requireStorePermission(interaction.member, 'create');
    await interaction.deferReply({ ephemeral: true });
    const product = createStoreProduct({
      name: interaction.fields.getTextInputValue('name'),
      description: interaction.fields.getTextInputValue('description'),
      price: interaction.fields.getTextInputValue('price'),
      category: interaction.fields.getTextInputValue('category'),
      actorId: interaction.user.id,
    });
    await refreshStoreCatalog(interaction.guild);
    await interaction.editReply({
      content: `Produto #${product.id} cadastrado e inativo. Anexe um ZIP com \`/loja arquivo produto:${product.id}\` e depois ative-o com \`/loja ativar\`.`,
    });
    return;
  }
  const [, area, action, value] = interaction.customId.split(':');
  if (area === 'panel') {
    await handleStorePanelButton(interaction, action);
    return;
  }
  if (area === 'catalog' && action === 'page') {
    const page = Number(value);
    if (!Number.isSafeInteger(page) || page < 0) throw new Error('Página de catálogo inválida.');
    await interaction.update(buildStoreCatalogPayload(page));
    return;
  }
  if (area === 'buy' && action) {
    const productId = Number(action);
    const order = createStoreOrder({ productId, buyerId: interaction.user.id });
    await interaction.reply({
      content: order.existing
        ? `Você já tem um pedido aguardando pagamento para este produto. ID: \`${order.id}\`.`
        : orderReceipt(order),
      ephemeral: true,
    });
    return;
  }
  throw new Error('Componente da loja inválido.');
}

function isGuildUser(user) {
  return Boolean(user && !user.bot);
}

export async function handleStoreSlash(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'catalogo') {
    await interaction.reply({ ...buildStoreCatalogPayload(), ephemeral: true });
    return;
  }
  if (subcommand === 'comprar') {
    const productId = interaction.options.getInteger('produto', true);
    const order = createStoreOrder({ productId, buyerId: interaction.user.id });
    await interaction.reply({ content: order.existing ? `Pedido existente aguardando pagamento: \`${order.id}\`.` : orderReceipt(order), ephemeral: true });
    return;
  }
  if (subcommand === 'cancelar') {
    const order = cancelStoreOrder(interaction.options.getString('pedido', true).trim(), interaction.user.id);
    await interaction.reply({ content: `Pedido \`${order.id}\` cancelado antes da confirmação de pagamento.`, ephemeral: true });
    return;
  }
  if (subcommand === 'pedido') {
    requireStorePermission(interaction.member, 'buyer_order');
    const buyer = interaction.options.getUser('comprador', true);
    if (!isGuildUser(buyer)) throw new Error('Selecione um usuário válido que não seja bot.');
    const productId = interaction.options.getInteger('produto', true);
    const order = createStoreOrder({ productId, buyerId: buyer.id });
    await interaction.reply({ content: `Pedido criado para <@${buyer.id}>: \`${order.id}\`, aguardando confirmação manual do pagamento.`, ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }
  if (subcommand === 'painel') {
    requireStorePermission(interaction.member, 'panel');
    await interaction.deferReply({ ephemeral: true });
    await ensureStorePanels(interaction.guild);
    await interaction.editReply({ content: 'Painel e catálogo atualizados nos canais configurados.' });
    return;
  }
  if (subcommand === 'listar') {
    requireStorePermission(interaction.member, 'list');
    await interaction.reply({ embeds: [productListEmbed(listStoreProducts())], ephemeral: true });
    return;
  }
  if (subcommand === 'vendas') {
    requireStorePermission(interaction.member, 'stats');
    const summary = getStoreStats().map((row) => `${row.status}: ${row.count}`).join(' • ') || 'sem pedidos';
    await interaction.reply({
      content: `Resumo de estados: ${summary}`,
      embeds: [orderListEmbed(recentStoreOrders())],
      ephemeral: true,
    });
    return;
  }
  const actorId = interaction.user.id;
  if (subcommand === 'cadastrar') {
    requireStorePermission(interaction.member, 'create');
    await interaction.deferReply({ ephemeral: true });
    const product = createStoreProduct({
      name: interaction.options.getString('nome', true),
      description: interaction.options.getString('descricao', true),
      price: interaction.options.getString('preco', true),
      category: interaction.options.getString('categoria', true),
      actorId,
    });
    const attachment = interaction.options.getAttachment('arquivo');
    if (attachment) await attachStoreProductZip({ productId: product.id, attachment, actorId });
    await refreshStoreCatalog(interaction.guild);
    await interaction.editReply({
      content: `Produto #${product.id} cadastrado como inativo${attachment ? ' com ZIP validado' : ''}. Ative-o após anexar um arquivo com \`/loja ativar\`.`,
    });
    return;
  }
  if (subcommand === 'editar') {
    requireStorePermission(interaction.member, 'edit');
    await interaction.deferReply({ ephemeral: true });
    const productId = interaction.options.getInteger('produto', true);
    const updates = {
      name: interaction.options.getString('nome') ?? undefined,
      description: interaction.options.getString('descricao') ?? undefined,
      category: interaction.options.getString('categoria') ?? undefined,
    };
    if (!Object.values(updates).some((value) => value !== undefined)) throw new Error('Informe ao menos um campo para editar.');
    editStoreProduct({ productId, updates, actorId });
    await refreshStoreCatalog(interaction.guild);
    await interaction.editReply({ content: `Produto #${productId} atualizado.` });
    return;
  }
  if (subcommand === 'preco') {
    requireStorePermission(interaction.member, 'price');
    await interaction.deferReply({ ephemeral: true });
    const productId = interaction.options.getInteger('produto', true);
    const product = setStoreProductPrice(productId, interaction.options.getString('valor', true), actorId);
    await refreshStoreCatalog(interaction.guild);
    await interaction.editReply({ content: `Preço do produto #${productId} atualizado para ${formatPrice(product.price_cents)}.` });
    return;
  }
  if (subcommand === 'arquivo') {
    requireStorePermission(interaction.member, 'upload');
    await interaction.deferReply({ ephemeral: true });
    const productId = interaction.options.getInteger('produto', true);
    const attachment = interaction.options.getAttachment('zip', true);
    const product = await attachStoreProductZip({ productId, attachment, actorId });
    await refreshStoreCatalog(interaction.guild);
    await interaction.editReply({ content: `ZIP validado e salvo privadamente para o produto #${productId}. O produto permanece ${product.status === 'active' ? 'ativo' : 'inativo'}.` });
    return;
  }
  if (subcommand === 'ativar') {
    requireStorePermission(interaction.member, 'activate');
    await interaction.deferReply({ ephemeral: true });
    const productId = interaction.options.getInteger('produto', true);
    const active = interaction.options.getBoolean('ativo', true);
    setStoreProductActive(productId, active, actorId);
    await refreshStoreCatalog(interaction.guild);
    await interaction.editReply({ content: `Produto #${productId} ${active ? 'ativado' : 'desativado'}.` });
    return;
  }
  if (subcommand === 'confirmar') {
    requireStorePermission(interaction.member, 'payment_confirm');
    const order = confirmStorePayment(interaction.options.getString('pedido', true).trim(), actorId);
    await interaction.reply({ content: `Pagamento do pedido \`${order.id}\` confirmado manualmente. Agora use \`/loja entregar\` para enviar o ZIP por DM.`, ephemeral: true });
    return;
  }
  if (subcommand === 'entregar' || subcommand === 'reenviar') {
    const operation = subcommand === 'entregar' ? 'deliver' : 'resend';
    requireStorePermission(interaction.member, operation);
    const orderId = interaction.options.getString('pedido', true).trim();
    const forceResend = subcommand === 'reenviar';
    if (forceResend && !interaction.options.getBoolean('confirmar', true)) {
      throw new Error('Para reenviar, confirme explicitamente que verificou o estado da DM anterior.');
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await deliverStoreOrder({ client: interaction.client, orderId, actorId, forceResend });
    await interaction.editReply(`Pedido \`${result.orderId}\` entregue por DM com sucesso (tentativa ${result.attempt}).`);
    return;
  }
  throw new Error('Subcomando da loja inválido.');
}

export async function handleStorePrefix(message, args) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'catalogo' || subcommand === 'listar') {
    const products = listStoreProducts({ activeOnly: subcommand === 'catalogo' });
    await message.reply({ embeds: [productListEmbed(products)], allowedMentions: { parse: [] } });
    return;
  }
  if (subcommand === 'comprar') {
    const productId = Number(rest[0]);
    const order = createStoreOrder({ productId, buyerId: message.author.id });
    await message.reply({ content: order.existing ? `Pedido existente aguardando pagamento: \`${order.id}\`.` : orderReceipt(order), allowedMentions: { parse: [] } });
    return;
  }
  if (subcommand === 'cancelar') {
    const order = cancelStoreOrder(rest[0], message.author.id);
    await message.reply({ content: `Pedido \`${order.id}\` cancelado antes da confirmação do pagamento.`, allowedMentions: { parse: [] } });
    return;
  }
  await message.reply('Use os comandos `/loja` para operações administrativas. Ex.: `/loja catalogo`, `/loja listar` ou `/loja comprar produto:<id>`.');
}

export async function startStoreService(client, guildId = config.discordGuildId) {
  storeClient = client;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error(`O servidor autorizado ${guildId} não está disponível para inicializar os painéis da loja.`);
  ensurePrivateStorage();
  await ensureStorePanels(guild);
}

export function closeStoreService() {
  storeClient = null;
}
