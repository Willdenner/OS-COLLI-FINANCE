const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeRuleOffsetDays } = require("./billing-rule");
const { buildTransactionFingerprint } = require("./fpa");

const {
  DATA_DIR,
  DEFAULT_MESSAGE_TEMPLATE,
  buildMessageFingerprint,
  buildPhoneMatchKeys,
  isDirectChatId,
  isPossiblePhone,
  normalizeName,
  onlyDigits,
  truncateText,
} = require("./domain");

const DB_PATH = path.join(DATA_DIR, "db.json");
const MAX_STORED_MESSAGES = Number(process.env.MAX_STORED_MESSAGES || 2000);
const DATABASE_STATE_KEY = "main";
const PG_CONNECTION_TIMEOUT_MS = Math.min(
  60000,
  Math.max(1000, Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000))
);
const PG_QUERY_TIMEOUT_MS = Math.min(60000, Math.max(1000, Number(process.env.PG_QUERY_TIMEOUT_MS || 15000)));

let dbCache = null;
let writeChain = Promise.resolve();
let pgPool = null;
let pgInitPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function nextId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isDatabaseEnabled() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

function loadPg() {
  try {
    return require("pg");
  } catch {
    throw new Error("Dependência 'pg' não encontrada. Instale 'pg' para usar DATABASE_URL.");
  }
}

function getPgPool() {
  if (!isDatabaseEnabled()) return null;
  if (pgPool) return pgPool;

  const { Pool } = loadPg();
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  const sslMode = String(process.env.DATABASE_SSL || "").trim().toLowerCase();

  pgPool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    allowExitOnIdle: true,
    keepAlive: true,
    query_timeout: PG_QUERY_TIMEOUT_MS,
    statement_timeout: PG_QUERY_TIMEOUT_MS,
    ssl: sslMode === "require" || sslMode === "true" ? { rejectUnauthorized: false } : undefined,
  });

  return pgPool;
}

async function ensurePgStateTable() {
  if (!isDatabaseEnabled()) return;
  if (pgInitPromise) return pgInitPromise;

  pgInitPromise = (async () => {
    const pool = getPgPool();
    await pool.query(`
      create table if not exists app_state (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
  })().catch((error) => {
    pgInitPromise = null;
    throw error;
  });

  return pgInitPromise;
}

function sortByTimestampDesc(items) {
  return items.slice().sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
}

function sortByDateDesc(items, getValue) {
  return items.slice().sort((a, b) => {
    const aValue = new Date(getValue(a) || 0).getTime();
    const bValue = new Date(getValue(b) || 0).getTime();
    return bValue - aValue;
  });
}

function pruneMessages(messages) {
  if (messages.length <= MAX_STORED_MESSAGES) return messages;
  return sortByTimestampDesc(messages).slice(0, MAX_STORED_MESSAGES).reverse();
}

function normalizeOptionalText(value, maxLength = 255) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeFpaLookupKey(value) {
  return String(normalizeOptionalText(value, 120) || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function normalizeFpaAccountKey(value) {
  return normalizeFpaLookupKey(value);
}

function normalizeEmail(value) {
  const email = normalizeOptionalText(value, 320);
  return email ? email.toLowerCase() : null;
}

function normalizeGmailAppPassword(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized.slice(0, 255);
}

function normalizeGmailSettings(gmailSettings) {
  if (!gmailSettings || typeof gmailSettings !== "object") {
    return {
      user: null,
      appPassword: null,
      fromName: "V4 Cobranças",
      verifiedAt: null,
      updatedAt: null,
    };
  }

  return {
    user: normalizeEmail(gmailSettings.user),
    appPassword: normalizeGmailAppPassword(gmailSettings.appPassword),
    fromName: normalizeOptionalText(gmailSettings.fromName, 120) || "V4 Cobranças",
    verifiedAt: gmailSettings.verifiedAt ?? null,
    updatedAt: gmailSettings.updatedAt ?? null,
  };
}

function normalizeStoredAttachment(attachment, fallbackKind = null) {
  if (!attachment || typeof attachment !== "object") return null;

  const filename = normalizeOptionalText(attachment.filename, 255);
  if (!filename) return null;

  const originalName = normalizeOptionalText(attachment.originalName, 255) || path.basename(filename);
  const kind = normalizeOptionalText(attachment.kind, 40) || fallbackKind || null;
  const label =
    normalizeOptionalText(attachment.label, 120) ||
    (kind === "boleto" ? "Boleto" : kind === "nota_fiscal" ? "Nota Fiscal" : originalName);
  const mimeType = normalizeOptionalText(attachment.mimeType, 120);
  const size = Number(attachment.size ?? 0);

  return {
    filename,
    originalName,
    kind,
    label,
    mimeType: mimeType || null,
    size: Number.isFinite(size) && size > 0 ? size : null,
  };
}

function normalizeAttachmentsList(attachments, legacyAttachment = null) {
  const source = [];
  if (Array.isArray(attachments)) source.push(...attachments);
  if (legacyAttachment) source.push(legacyAttachment);

  const deduped = new Map();
  source.forEach((attachment) => {
    const normalized = normalizeStoredAttachment(attachment);
    if (!normalized) return;
    if (!deduped.has(normalized.filename)) {
      deduped.set(normalized.filename, normalized);
    }
  });

  return Array.from(deduped.values()).slice(0, 12);
}

function normalizeInvoiceRuleDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== "object") return null;

  const status = ["sending", "sent", "failed"].includes(dispatch.status) ? dispatch.status : "sending";

  return {
    id: dispatch.id || nextId("rule"),
    templateId: dispatch.templateId || null,
    templateName: normalizeOptionalText(dispatch.templateName, 120),
    ruleOffsetDays: normalizeRuleOffsetDays(dispatch.ruleOffsetDays),
    channel: dispatch.channel === "email" ? "email" : "whatsapp",
    attemptedAt: dispatch.attemptedAt || nowIso(),
    sentAt: dispatch.sentAt ?? null,
    status,
    errorMessage: dispatch.errorMessage ?? null,
    messageId: dispatch.messageId ?? null,
    renderedBody: truncateText(dispatch.renderedBody, 4000) || null,
  };
}

function createTemplateRecord(body = DEFAULT_MESSAGE_TEMPLATE) {
  const timestamp = nowIso();
  return {
    id: "tpl_default",
    name: "Cobrança Padrão",
    category: "Cobrança",
    body,
    sendAttachment: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createEmptyFpaState() {
  return {
    imports: [],
    transactions: [],
    dreAccounts: [],
  };
}

function createEmptyDb() {
  const defaultTemplate = createTemplateRecord();
  return {
    settings: {
      messageTemplate: defaultTemplate.body,
      activeTemplateId: defaultTemplate.id,
      gmail: normalizeGmailSettings(null),
      updatedAt: defaultTemplate.updatedAt,
    },
    clients: [],
    invoices: [],
    messages: [],
    templates: [defaultTemplate],
    fpa: createEmptyFpaState(),
  };
}

function normalizeTemplateRecord(template, { fallbackBody = DEFAULT_MESSAGE_TEMPLATE } = {}) {
  if (!template || typeof template !== "object") return null;

  const body = truncateText(template.body || fallbackBody, 4000) || fallbackBody;
  return {
    id: template.id || nextId("tpl"),
    name: normalizeOptionalText(template.name, 120) || "Template sem nome",
    category: normalizeOptionalText(template.category, 40) || "Cobrança",
    body,
    sendAttachment: template.sendAttachment === true,
    ruleOffsetDays: normalizeRuleOffsetDays(template.ruleOffsetDays),
    createdAt: template.createdAt || nowIso(),
    updatedAt: template.updatedAt || template.createdAt || nowIso(),
  };
}

function normalizeClientRecord(client) {
  if (!client || typeof client !== "object") return null;

  return {
    id: client.id || nextId("cli"),
    name: normalizeName(client.name),
    phone: onlyDigits(client.phone),
    phoneMatchKeys: Array.isArray(client.phoneMatchKeys) && client.phoneMatchKeys.length
      ? client.phoneMatchKeys.map(onlyDigits).filter(Boolean)
      : buildPhoneMatchKeys(client.phone),
    companyName: normalizeOptionalText(client.companyName, 160),
    email: normalizeEmail(client.email),
    notes: normalizeOptionalText(client.notes, 2000),
    defaultTemplateId: client.defaultTemplateId || null,
    createdAt: client.createdAt || nowIso(),
    lastInboundAt: client.lastInboundAt ?? null,
    lastOutboundAt: client.lastOutboundAt ?? null,
  };
}

function normalizeInvoiceRecord(invoice) {
  if (!invoice || typeof invoice !== "object") return null;

  const recoveredFromInterruptedSend =
    invoice.status === "sending" && !invoice.lastSentAt && (invoice.lastAttemptAt || invoice.sendAttempts);
  const attachments = normalizeAttachmentsList(invoice.attachments, invoice.attachment);

  return {
    id: invoice.id || nextId("inv"),
    clientId: invoice.clientId || null,
    valueCents: Number(invoice.valueCents ?? 0),
    dueDate: String(invoice.dueDate ?? ""),
    paymentLink: invoice.paymentLink ?? null,
    attachment: attachments[0] ?? null,
    attachments,
    recurrence: normalizeOptionalText(invoice.recurrence, 40) || "Único",
    templateId: invoice.templateId || null,
    createdAt: invoice.createdAt || nowIso(),
    lastSentAt: invoice.lastSentAt ?? null,
    lastAttemptAt: invoice.lastAttemptAt ?? invoice.lastSentAt ?? null,
    lastError:
      invoice.lastError ??
      (recoveredFromInterruptedSend ? "Envio interrompido antes da confirmação. Tente novamente." : null),
    lastMessageId: invoice.lastMessageId ?? null,
    sendAttempts: Number(invoice.sendAttempts ?? (invoice.lastSentAt ? 1 : 0)),
    status: recoveredFromInterruptedSend ? "failed" : invoice.status || (invoice.lastSentAt ? "sent" : "pending"),
    paidAt: invoice.paidAt ?? null,
    integration:
      invoice.integration && typeof invoice.integration === "object"
        ? {
            source: normalizeOptionalText(invoice.integration.source, 40),
            externalId: normalizeOptionalText(invoice.integration.externalId, 160),
            event: normalizeOptionalText(invoice.integration.event, 80),
            externalStatus: normalizeOptionalText(invoice.integration.externalStatus, 80),
            paymentMethod: normalizeOptionalText(invoice.integration.paymentMethod, 80),
            lastSyncedAt: invoice.integration.lastSyncedAt ?? null,
            metadata: invoice.integration.metadata && typeof invoice.integration.metadata === "object" ? invoice.integration.metadata : {},
          }
        : null,
    ruleDispatches: sortByDateDesc(
      Array.isArray(invoice.ruleDispatches) ? invoice.ruleDispatches.map(normalizeInvoiceRuleDispatch).filter(Boolean) : [],
      (dispatch) => dispatch.sentAt || dispatch.attemptedAt
    ).slice(0, 100),
  };
}

function shouldIgnoreMessage(message) {
  if (!message || typeof message !== "object") return true;
  if (message.ignored === true) return true;
  if (message.fromId && !isDirectChatId(message.fromId) && message.direction === "in") return true;
  if (message.direction === "in" && !message.clientId && !isPossiblePhone(message.fromPhone)) return true;
  return false;
}

function normalizeMessageRecord(message) {
  if (!message || typeof message !== "object") return null;

  const body = truncateText(message.body, 4000);
  const attachments = normalizeAttachmentsList(message.attachments);
  const fingerprint = buildMessageFingerprint({
    externalId: message.externalId,
    direction: message.direction,
    fromId: message.fromId,
    fromPhone: message.fromPhone,
    body,
    timestampMs: message.timestampMs,
  });

  const record = {
    id: message.id || nextId("msg"),
    direction: message.direction === "out" ? "out" : "in",
    status: message.status || (message.direction === "out" ? "sent" : "received"),
    externalId: message.externalId ?? null,
    fingerprint,
    fromId: message.fromId ?? null,
    fromPhone: onlyDigits(message.fromPhone),
    fromMatchKeys: Array.isArray(message.fromMatchKeys) && message.fromMatchKeys.length
      ? message.fromMatchKeys.map(onlyDigits).filter(Boolean)
      : buildPhoneMatchKeys(message.fromPhone),
    clientId: message.clientId ?? null,
    invoiceId: message.invoiceId ?? null,
    body,
    attachments,
    timestampMs: Number(message.timestampMs ?? Date.now()),
    createdAt: message.createdAt || nowIso(),
    errorMessage: message.errorMessage ?? null,
    messageType: message.messageType ?? "text",
    ignored: message.ignored === true,
  };

  record.ignored = record.ignored || shouldIgnoreMessage(record);
  return record;
}

function getTemplateByIdFromDb(db, id) {
  return db.templates.find((template) => template.id === id) ?? null;
}

function assertUniqueRuleOffset(db, ruleOffsetDays, { excludingId = null } = {}) {
  if (!Number.isInteger(ruleOffsetDays)) return;
  const duplicated = db.templates.find(
    (template) => template.id !== excludingId && Number.isInteger(template.ruleOffsetDays) && template.ruleOffsetDays === ruleOffsetDays
  );
  if (duplicated) {
    throw new Error(`Já existe um template configurado para ${ruleOffsetDays} dia(s) em relação ao vencimento.`);
  }
}

function getActiveTemplateFromDb(db) {
  const template =
    getTemplateByIdFromDb(db, db.settings.activeTemplateId) ??
    db.templates[0] ??
    null;
  return template;
}

function ensureTemplateState(rawDb) {
  const fallbackBody =
    typeof rawDb.settings?.messageTemplate === "string" && rawDb.settings.messageTemplate.trim()
      ? rawDb.settings.messageTemplate
      : DEFAULT_MESSAGE_TEMPLATE;

  const templates = Array.isArray(rawDb.templates)
    ? rawDb.templates.map((template) => normalizeTemplateRecord(template, { fallbackBody })).filter(Boolean)
    : [];

  if (!templates.length) {
    templates.push(createTemplateRecord(fallbackBody));
  }

  const activeTemplate =
    templates.find((template) => template.id === rawDb.settings?.activeTemplateId) ??
    templates[0];

  return {
    templates,
    activeTemplateId: activeTemplate.id,
    activeBody: activeTemplate.body,
  };
}

function sortFpaTransactions(items) {
  return items.slice().sort((a, b) => {
    if ((a.transactionDate || "") !== (b.transactionDate || "")) {
      return a.transactionDate < b.transactionDate ? 1 : -1;
    }
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

function sortFpaDreAccounts(items) {
  return items.slice().sort((a, b) => {
    const orderDiff = (Number(a.orderIndex) || 0) - (Number(b.orderIndex) || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", { sensitivity: "base" });
  });
}

function normalizeFpaImportRecord(record) {
  if (!record || typeof record !== "object") return null;

  return {
    id: record.id || nextId("stmt"),
    sourceType: record.sourceType === "ofx" ? "ofx" : "csv",
    originalFilename: normalizeOptionalText(record.originalFilename, 255) || "extrato",
    accountName: normalizeOptionalText(record.accountName, 120) || "Conta principal",
    importedAt: record.importedAt || nowIso(),
    totalRows: Math.max(0, Math.trunc(Number(record.totalRows ?? 0) || 0)),
    importedCount: Math.max(0, Math.trunc(Number(record.importedCount ?? 0) || 0)),
    duplicateCount: Math.max(0, Math.trunc(Number(record.duplicateCount ?? 0) || 0)),
    dateFrom: normalizeOptionalText(record.dateFrom, 10),
    dateTo: normalizeOptionalText(record.dateTo, 10),
  };
}

function normalizeFpaTransactionRecord(transaction) {
  if (!transaction || typeof transaction !== "object") return null;

  const amountCents = Math.trunc(Number(transaction.amountCents ?? 0));
  if (!Number.isFinite(amountCents) || !transaction.transactionDate) return null;

  const accountName = normalizeOptionalText(transaction.accountName, 120) || "Conta principal";
  const description = truncateText(transaction.description, 240);
  if (!description) return null;

  const balanceValue = Number(transaction.balanceCents);
  const balanceCents = Number.isFinite(balanceValue) ? Math.trunc(balanceValue) : null;
  const confidenceValue = Number(transaction.categoryConfidence);

  return {
    id: transaction.id || nextId("txn"),
    importId: transaction.importId || null,
    sourceType: transaction.sourceType === "ofx" ? "ofx" : "csv",
    originalFilename: normalizeOptionalText(transaction.originalFilename, 255) || null,
    accountName,
    transactionDate: normalizeOptionalText(transaction.transactionDate, 10),
    description,
    amountCents,
    balanceCents,
    direction: amountCents >= 0 ? "in" : "out",
    category:
      normalizeOptionalText(transaction.category, 80) || (amountCents >= 0 ? "Outras Entradas" : "Não Classificado"),
    subcategory: normalizeOptionalText(transaction.subcategory, 120),
    reportSection: normalizeOptionalText(transaction.reportSection, 40) || "uncategorized",
    categoryConfidence:
      Number.isFinite(confidenceValue) && confidenceValue >= 0 ? Math.min(confidenceValue, 1) : 0,
    isInternalTransfer: transaction.isInternalTransfer === true,
    counterparty: normalizeOptionalText(transaction.counterparty, 120),
    fitId: normalizeOptionalText(transaction.fitId, 120),
    reference: normalizeOptionalText(transaction.reference, 120),
    fingerprint:
      normalizeOptionalText(transaction.fingerprint, 320) ||
      buildTransactionFingerprint({
        accountName,
        transactionDate: transaction.transactionDate,
        description,
        amountCents,
        fitId: transaction.fitId,
      }),
    notes: normalizeOptionalText(transaction.notes, 2000),
    sourceRowNumber: Math.max(1, Math.trunc(Number(transaction.sourceRowNumber ?? 1) || 1)),
    createdAt: transaction.createdAt || nowIso(),
    updatedAt: transaction.updatedAt || transaction.createdAt || nowIso(),
  };
}

function normalizeFpaDreAccountRecord(account) {
  if (!account || typeof account !== "object") return null;

  const name = normalizeOptionalText(account.name, 120);
  if (!name) return null;

  return {
    id: account.id || nextId("dre"),
    name,
    type: ["income", "expense", "other"].includes(account.type) ? account.type : "expense",
    orderIndex: Number.isFinite(Number(account.orderIndex)) ? Math.max(0, Math.trunc(Number(account.orderIndex))) : 999,
    categories: Array.from(
      new Set((Array.isArray(account.categories) ? account.categories : []).map((value) => normalizeOptionalText(value, 80)).filter(Boolean))
    ),
    notes: normalizeOptionalText(account.notes, 2000),
    createdAt: account.createdAt || nowIso(),
    updatedAt: account.updatedAt || account.createdAt || nowIso(),
  };
}

function normalizeFpaState(rawFpaState) {
  const safeState = !rawFpaState || typeof rawFpaState !== "object" ? createEmptyFpaState() : rawFpaState;

  return {
    imports: Array.isArray(safeState.imports)
      ? safeState.imports
          .map(normalizeFpaImportRecord)
          .filter(Boolean)
          .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))
      : [],
    transactions: Array.isArray(safeState.transactions)
      ? sortFpaTransactions(safeState.transactions.map(normalizeFpaTransactionRecord).filter(Boolean))
      : [],
    dreAccounts: Array.isArray(safeState.dreAccounts)
      ? sortFpaDreAccounts(safeState.dreAccounts.map(normalizeFpaDreAccountRecord).filter(Boolean))
      : [],
  };
}

function normalizeDbShape(db) {
  const safeDb = !db || typeof db !== "object" ? createEmptyDb() : db;
  const templateState = ensureTemplateState(safeDb);

  const normalized = {
    settings: {
      ...safeDb.settings,
      messageTemplate: templateState.activeBody,
      activeTemplateId: templateState.activeTemplateId,
      gmail: normalizeGmailSettings(safeDb.settings?.gmail),
      updatedAt: safeDb.settings?.updatedAt ?? null,
    },
    clients: Array.isArray(safeDb.clients) ? safeDb.clients.map(normalizeClientRecord).filter(Boolean) : [],
    invoices: Array.isArray(safeDb.invoices) ? safeDb.invoices.map(normalizeInvoiceRecord).filter(Boolean) : [],
    messages: Array.isArray(safeDb.messages) ? safeDb.messages.map(normalizeMessageRecord).filter(Boolean) : [],
    templates: templateState.templates,
    fpa: normalizeFpaState(safeDb.fpa),
  };

  normalized.messages = pruneMessages(normalized.messages);
  return normalized;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadDb() {
  if (dbCache) return dbCache;

  if (isDatabaseEnabled()) {
    try {
      await ensurePgStateTable();
      const pool = getPgPool();
      const result = await pool.query("select value from app_state where key = $1 limit 1", [DATABASE_STATE_KEY]);
      if (result.rowCount) {
        dbCache = normalizeDbShape(result.rows[0].value);
        return dbCache;
      }

      dbCache = createEmptyDb();
      await persistDb();
      return dbCache;
    } catch (error) {
      throw new Error(
        `Falha ao carregar estado do Postgres. Verifique DATABASE_URL, DATABASE_SSL e a saúde do banco. ${error?.message || error}`
      );
    }
  }

  await ensureDataDir();
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    dbCache = normalizeDbShape(JSON.parse(raw));
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
    dbCache = createEmptyDb();
  }

  return dbCache;
}

async function persistDb() {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
    if (isDatabaseEnabled()) {
        try {
          await ensurePgStateTable();
          const pool = getPgPool();
          const payload = JSON.stringify(dbCache);
          await pool.query(
            `
              insert into app_state (key, value, updated_at)
              values ($1, $2::jsonb, now())
              on conflict (key) do update
              set value = excluded.value,
                  updated_at = excluded.updated_at
            `,
            [DATABASE_STATE_KEY, payload]
          );
          return;
        } catch (error) {
          throw new Error(
            `Falha ao persistir estado no Postgres. Verifique DATABASE_URL, DATABASE_SSL e locks na tabela app_state. ${
              error?.message || error
            }`
          );
        }
    }

      await ensureDataDir();
      const payload = JSON.stringify(dbCache, null, 2);
      const tmpPath = `${DB_PATH}.tmp`;
      await fs.writeFile(tmpPath, payload, "utf8");
      try {
        await fs.rename(tmpPath, DB_PATH);
      } catch (err) {
        if (err && err.code === "ENOENT") {
          await fs.writeFile(DB_PATH, payload, "utf8");
          return;
        }
        throw err;
      }
    });

  return writeChain;
}

function getClientByIdFromDb(db, id) {
  return db.clients.find((client) => client.id === id) ?? null;
}

function findClientByPhoneInDb(db, rawPhone) {
  const matchKeys = new Set(buildPhoneMatchKeys(rawPhone));
  return (
    db.clients.find(
      (client) => Array.isArray(client.phoneMatchKeys) && client.phoneMatchKeys.some((key) => matchKeys.has(key))
    ) ?? null
  );
}

function getConversationForClient(db, client) {
  const keySet = new Set(Array.isArray(client.phoneMatchKeys) ? client.phoneMatchKeys : buildPhoneMatchKeys(client.phone));

  return db.messages.filter((message) => {
    if (message.ignored) return false;
    if (message.clientId) return message.clientId === client.id;
    const messageKeys = Array.isArray(message.fromMatchKeys)
      ? message.fromMatchKeys
      : buildPhoneMatchKeys(message.fromPhone);
    return messageKeys.some((key) => keySet.has(key));
  });
}

function isUnmatchedInboundMessage(message) {
  return message?.direction === "in" && message?.ignored !== true && !message?.clientId;
}

function syncActiveTemplateState(db) {
  const activeTemplate = getActiveTemplateFromDb(db);
  if (!activeTemplate) return;
  db.settings.activeTemplateId = activeTemplate.id;
  db.settings.messageTemplate = activeTemplate.body;
}

async function getSettings() {
  const db = await loadDb();
  return db.settings;
}

async function updateSettings(patch) {
  const db = await loadDb();

  if (typeof patch.activeTemplateId === "string") {
    const template = getTemplateByIdFromDb(db, patch.activeTemplateId);
    if (!template) throw new Error("Template ativo não encontrado.");
    db.settings.activeTemplateId = template.id;
  }

  if (typeof patch.messageTemplate === "string") {
    const activeTemplate = getActiveTemplateFromDb(db);
    if (activeTemplate) {
      activeTemplate.body = truncateText(patch.messageTemplate, 4000) || DEFAULT_MESSAGE_TEMPLATE;
      activeTemplate.updatedAt = nowIso();
    }
  }

  if (patch.gmail && typeof patch.gmail === "object") {
    const currentGmail = normalizeGmailSettings(db.settings.gmail);
    const nextGmail = {
      ...currentGmail,
      updatedAt: nowIso(),
    };

    if ("user" in patch.gmail) {
      const nextUser = normalizeEmail(patch.gmail.user);
      if (nextUser !== currentGmail.user && !("verifiedAt" in patch.gmail)) {
        nextGmail.verifiedAt = null;
      }
      nextGmail.user = nextUser;
    }
    if ("fromName" in patch.gmail) {
      nextGmail.fromName = normalizeOptionalText(patch.gmail.fromName, 120) || "V4 Cobranças";
    }
    if ("appPassword" in patch.gmail) {
      const normalizedPassword = normalizeGmailAppPassword(patch.gmail.appPassword);
      if (normalizedPassword) {
        if (normalizedPassword !== currentGmail.appPassword && !("verifiedAt" in patch.gmail)) {
          nextGmail.verifiedAt = null;
        }
        nextGmail.appPassword = normalizedPassword;
      }
    }
    if ("verifiedAt" in patch.gmail) {
      nextGmail.verifiedAt = patch.gmail.verifiedAt ?? null;
    }

    db.settings.gmail = nextGmail;
  }

  const { gmail, ...restPatch } = patch || {};
  db.settings = { ...db.settings, ...restPatch, updatedAt: nowIso() };
  syncActiveTemplateState(db);
  await persistDb();
  return db.settings;
}

async function listTemplates() {
  const db = await loadDb();
  return db.templates
    .map((template) => ({
      ...template,
      isActive: template.id === db.settings.activeTemplateId,
    }))
    .sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
}

async function getTemplate(id) {
  const db = await loadDb();
  return getTemplateByIdFromDb(db, id);
}

async function getActiveTemplate() {
  const db = await loadDb();
  return getActiveTemplateFromDb(db);
}

async function createTemplate({ name, category, body, sendAttachment, ruleOffsetDays }) {
  const db = await loadDb();
  const normalizedRuleOffsetDays = normalizeRuleOffsetDays(ruleOffsetDays);
  assertUniqueRuleOffset(db, normalizedRuleOffsetDays);
  const template = normalizeTemplateRecord({
    id: nextId("tpl"),
    name,
    category,
    body,
    sendAttachment,
    ruleOffsetDays: normalizedRuleOffsetDays,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  db.templates.push(template);
  if (!db.settings.activeTemplateId) {
    db.settings.activeTemplateId = template.id;
  }
  syncActiveTemplateState(db);
  db.settings.updatedAt = nowIso();
  await persistDb();
  return { ...template, isActive: template.id === db.settings.activeTemplateId };
}

async function updateTemplate(id, patch) {
  const db = await loadDb();
  const template = getTemplateByIdFromDb(db, id);
  if (!template) return null;

  if (typeof patch.name === "string") template.name = normalizeOptionalText(patch.name, 120) || template.name;
  if (typeof patch.category === "string") template.category = normalizeOptionalText(patch.category, 40) || template.category;
  if (typeof patch.body === "string") template.body = truncateText(patch.body, 4000) || template.body;
  if (typeof patch.sendAttachment === "boolean") template.sendAttachment = patch.sendAttachment;
  if ("ruleOffsetDays" in patch) {
    const normalizedRuleOffsetDays = normalizeRuleOffsetDays(patch.ruleOffsetDays);
    assertUniqueRuleOffset(db, normalizedRuleOffsetDays, { excludingId: template.id });
    template.ruleOffsetDays = normalizedRuleOffsetDays;
  }
  template.updatedAt = nowIso();

  if (patch.isActive === true) {
    db.settings.activeTemplateId = template.id;
  }

  syncActiveTemplateState(db);
  db.settings.updatedAt = nowIso();
  await persistDb();
  return { ...template, isActive: template.id === db.settings.activeTemplateId };
}

async function deleteTemplate(id) {
  const db = await loadDb();
  if (db.templates.length <= 1) {
    throw new Error("É preciso manter pelo menos um template.");
  }

  const index = db.templates.findIndex((template) => template.id === id);
  if (index < 0) return false;

  db.templates.splice(index, 1);
  if (db.settings.activeTemplateId === id) {
    db.settings.activeTemplateId = db.templates[0].id;
  }

  for (const client of db.clients) {
    if (client.defaultTemplateId === id) client.defaultTemplateId = null;
  }
  for (const invoice of db.invoices) {
    if (invoice.templateId === id) invoice.templateId = null;
  }

  syncActiveTemplateState(db);
  db.settings.updatedAt = nowIso();
  await persistDb();
  return true;
}

async function listClients() {
  const db = await loadDb();
  return db.clients
    .slice()
    .sort((a, b) => {
      const aLast = a.lastInboundAt || a.lastOutboundAt || a.createdAt || "";
      const bLast = b.lastInboundAt || b.lastOutboundAt || b.createdAt || "";
      return aLast < bLast ? 1 : -1;
    });
}

async function findClientByPhone(phone) {
  const db = await loadDb();
  return findClientByPhoneInDb(db, phone);
}

async function createClient({ name, phone, companyName, email, notes, defaultTemplateId }) {
  const db = await loadDb();
  const normalizedName = normalizeName(name);
  const normalizedPhone = onlyDigits(phone);

  const existing = findClientByPhoneInDb(db, normalizedPhone);
  if (existing) {
    throw new Error("Já existe um cliente cadastrado com este telefone.");
  }

  if (defaultTemplateId && !getTemplateByIdFromDb(db, defaultTemplateId)) {
    throw new Error("Template padrão do cliente não encontrado.");
  }

  const client = {
    id: nextId("cli"),
    name: normalizedName,
    phone: normalizedPhone,
    phoneMatchKeys: buildPhoneMatchKeys(normalizedPhone),
    companyName: normalizeOptionalText(companyName, 160),
    email: normalizeEmail(email),
    notes: normalizeOptionalText(notes, 2000),
    defaultTemplateId: defaultTemplateId || null,
    createdAt: nowIso(),
    lastInboundAt: null,
    lastOutboundAt: null,
  };

  db.clients.push(client);
  await persistDb();
  return client;
}

async function updateClient(id, patch) {
  const db = await loadDb();
  const client = getClientByIdFromDb(db, id);
  if (!client) return null;

  if (typeof patch.phone === "string") {
    const normalizedPhone = onlyDigits(patch.phone);
    const existing = findClientByPhoneInDb(db, normalizedPhone);
    if (existing && existing.id !== client.id) {
      throw new Error("Já existe um cliente cadastrado com este telefone.");
    }
    client.phone = normalizedPhone;
    client.phoneMatchKeys = Array.from(new Set([...client.phoneMatchKeys, ...buildPhoneMatchKeys(normalizedPhone)]));
  }

  if (typeof patch.name === "string") client.name = normalizeName(patch.name);
  if ("companyName" in patch) client.companyName = normalizeOptionalText(patch.companyName, 160);
  if ("email" in patch) client.email = normalizeEmail(patch.email);
  if ("notes" in patch) client.notes = normalizeOptionalText(patch.notes, 2000);
  if ("defaultTemplateId" in patch) {
    if (patch.defaultTemplateId && !getTemplateByIdFromDb(db, patch.defaultTemplateId)) {
      throw new Error("Template padrão do cliente não encontrado.");
    }
    client.defaultTemplateId = patch.defaultTemplateId || null;
  }

  await persistDb();
  return client;
}

async function deleteClient(id) {
  const db = await loadDb();
  const index = db.clients.findIndex((client) => client.id === id);
  if (index < 0) return false;

  db.clients.splice(index, 1);
  const invoiceIds = new Set(db.invoices.filter((invoice) => invoice.clientId === id).map((invoice) => invoice.id));
  db.invoices = db.invoices.filter((invoice) => invoice.clientId !== id);

  for (const message of db.messages) {
    if (message.clientId === id) message.clientId = null;
    if (invoiceIds.has(message.invoiceId)) message.invoiceId = null;
  }

  await persistDb();
  return true;
}

async function listInvoices() {
  const db = await loadDb();
  return db.invoices
    .slice()
    .sort((a, b) => {
      const aStamp = a.lastAttemptAt || a.createdAt || "";
      const bStamp = b.lastAttemptAt || b.createdAt || "";
      return aStamp < bStamp ? 1 : -1;
    });
}

async function createInvoice({
  clientId,
  valueCents,
  dueDate,
  paymentLink,
  attachment,
  attachments,
  recurrence,
  templateId,
  integration,
}) {
  const db = await loadDb();
  const normalizedAttachments = normalizeAttachmentsList(attachments, attachment);
  const invoice = {
    id: nextId("inv"),
    clientId,
    valueCents,
    dueDate,
    paymentLink,
    attachment: normalizedAttachments[0] ?? null,
    attachments: normalizedAttachments,
    recurrence: normalizeOptionalText(recurrence, 40) || "Único",
    templateId: templateId || null,
    createdAt: nowIso(),
    lastSentAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastMessageId: null,
    sendAttempts: 0,
    status: "pending",
    integration:
      integration && typeof integration === "object"
        ? {
            source: normalizeOptionalText(integration.source, 40),
            externalId: normalizeOptionalText(integration.externalId, 160),
            event: normalizeOptionalText(integration.event, 80),
            externalStatus: normalizeOptionalText(integration.externalStatus, 80),
            paymentMethod: normalizeOptionalText(integration.paymentMethod, 80),
            lastSyncedAt: integration.lastSyncedAt ?? nowIso(),
            metadata: integration.metadata && typeof integration.metadata === "object" ? integration.metadata : {},
          }
        : null,
    ruleDispatches: [],
  };

  db.invoices.push(invoice);
  await persistDb();
  return invoice;
}

async function getInvoice(id) {
  const db = await loadDb();
  return db.invoices.find((invoice) => invoice.id === id) ?? null;
}

async function findInvoiceByIntegration(source, externalId) {
  const db = await loadDb();
  const safeSource = normalizeOptionalText(source, 40);
  const safeExternalId = normalizeOptionalText(externalId, 160);
  if (!safeSource || !safeExternalId) return null;

  return (
    db.invoices.find(
      (invoice) =>
        invoice.integration?.source === safeSource &&
        invoice.integration?.externalId === safeExternalId
    ) ?? null
  );
}

async function updateInvoice(id, patch = {}) {
  const db = await loadDb();
  const invoice = db.invoices.find((entry) => entry.id === id);
  if (!invoice) return null;

  if ("clientId" in patch && patch.clientId) invoice.clientId = patch.clientId;
  if ("valueCents" in patch && Number.isFinite(Number(patch.valueCents))) {
    invoice.valueCents = Math.max(0, Math.trunc(Number(patch.valueCents)));
  }
  if ("dueDate" in patch && patch.dueDate) invoice.dueDate = String(patch.dueDate);
  if ("paymentLink" in patch) invoice.paymentLink = patch.paymentLink ?? null;
  if ("recurrence" in patch) invoice.recurrence = normalizeOptionalText(patch.recurrence, 40) || invoice.recurrence;
  if ("templateId" in patch) invoice.templateId = patch.templateId || null;
  if ("status" in patch && typeof patch.status === "string") invoice.status = patch.status;
  if ("lastError" in patch) invoice.lastError = patch.lastError ?? null;

  if ("attachments" in patch || "attachment" in patch) {
    const normalizedAttachments = normalizeAttachmentsList(patch.attachments, patch.attachment);
    invoice.attachments = normalizedAttachments;
    invoice.attachment = normalizedAttachments[0] ?? null;
  }

  if ("integration" in patch && patch.integration && typeof patch.integration === "object") {
    const currentIntegration = invoice.integration && typeof invoice.integration === "object" ? invoice.integration : {};
    invoice.integration = {
      ...currentIntegration,
      source: normalizeOptionalText(patch.integration.source ?? currentIntegration.source, 40),
      externalId: normalizeOptionalText(patch.integration.externalId ?? currentIntegration.externalId, 160),
      event: normalizeOptionalText(patch.integration.event ?? currentIntegration.event, 80),
      externalStatus: normalizeOptionalText(
        patch.integration.externalStatus ?? currentIntegration.externalStatus,
        80
      ),
      paymentMethod: normalizeOptionalText(
        patch.integration.paymentMethod ?? currentIntegration.paymentMethod,
        80
      ),
      lastSyncedAt: patch.integration.lastSyncedAt ?? nowIso(),
      metadata:
        patch.integration.metadata && typeof patch.integration.metadata === "object"
          ? patch.integration.metadata
          : currentIntegration.metadata && typeof currentIntegration.metadata === "object"
            ? currentIntegration.metadata
            : {},
    };
  }

  await persistDb();
  return invoice;
}

async function markInvoiceSendAttempt(id, dispatchMeta = {}) {
  const db = await loadDb();
  const invoice = db.invoices.find((entry) => entry.id === id);
  if (!invoice) return null;

  const dispatch = normalizeInvoiceRuleDispatch({
    id: nextId("dispatch"),
    templateId: dispatchMeta.templateId || null,
    templateName: dispatchMeta.templateName || null,
    ruleOffsetDays: dispatchMeta.ruleOffsetDays,
    channel: dispatchMeta.channel || "whatsapp",
    attemptedAt: nowIso(),
    status: "sending",
    renderedBody: dispatchMeta.renderedBody || null,
  });

  invoice.sendAttempts = Number(invoice.sendAttempts ?? 0) + 1;
  invoice.lastAttemptAt = nowIso();
  invoice.lastError = null;
  invoice.status = "sending";
  invoice.ruleDispatches = sortByDateDesc([dispatch, ...(invoice.ruleDispatches || [])], (entry) => entry.sentAt || entry.attemptedAt).slice(0, 100);
  await persistDb();
  return {
    invoice,
    dispatchId: dispatch.id,
  };
}

async function markInvoiceSendResult(id, { ok, errorMessage, messageId, dispatchId } = {}) {
  const db = await loadDb();
  const invoice = db.invoices.find((entry) => entry.id === id);
  if (!invoice) return null;

  invoice.lastAttemptAt = nowIso();
  if (ok) {
    invoice.lastSentAt = nowIso();
    invoice.lastError = null;
    invoice.lastMessageId = messageId ?? invoice.lastMessageId ?? null;
    invoice.status = "sent";
  } else {
    invoice.lastError = errorMessage || "Falha desconhecida no envio.";
    invoice.status = "failed";
  }

  const dispatch = (invoice.ruleDispatches || []).find((entry) => entry.id === dispatchId);
  if (dispatch) {
    dispatch.status = ok ? "sent" : "failed";
    dispatch.errorMessage = ok ? null : invoice.lastError;
    dispatch.messageId = ok ? messageId ?? null : null;
    dispatch.sentAt = ok ? nowIso() : null;
  }

  await persistDb();
  return invoice;
}

async function markInvoicePaid(id) {
  const db = await loadDb();
  const invoice = db.invoices.find((entry) => entry.id === id);
  if (!invoice) return null;
  invoice.status = "paid";
  invoice.paidAt = nowIso();
  invoice.lastError = null;
  await persistDb();
  return invoice;
}

async function getClient(id) {
  const db = await loadDb();
  return getClientByIdFromDb(db, id);
}

async function addInboundMessage({ externalId, fromPhone, body, timestampMs, fromId, messageType }) {
  const db = await loadDb();

  const fromMatchKeys = buildPhoneMatchKeys(fromPhone);
  const matchedClient =
    db.clients.find(
      (client) => Array.isArray(client.phoneMatchKeys) && client.phoneMatchKeys.some((key) => fromMatchKeys.includes(key))
    ) ?? null;

  const normalizedBody = truncateText(body, 4000);
  const fingerprint = buildMessageFingerprint({
    externalId,
    direction: "in",
    fromId,
    fromPhone,
    body: normalizedBody,
    timestampMs,
  });

  const existing =
    db.messages.find(
      (message) =>
        (externalId && message.externalId === externalId) ||
        (!externalId && message.direction === "in" && message.fingerprint === fingerprint)
    ) ?? null;

  if (existing) return existing;

  const message = normalizeMessageRecord({
    id: nextId("msg"),
    direction: "in",
    status: "received",
    externalId: externalId ?? null,
    fromId: fromId ?? null,
    fromPhone: onlyDigits(fromPhone),
    fromMatchKeys,
    clientId: matchedClient?.id ?? null,
    body: normalizedBody,
    timestampMs: timestampMs ?? Date.now(),
    createdAt: nowIso(),
    messageType: messageType ?? "text",
  });

  db.messages.push(message);
  db.messages = pruneMessages(db.messages);

  if (matchedClient) matchedClient.lastInboundAt = nowIso();

  await persistDb();
  return message;
}

async function addOutboundMessage({
  clientId,
  phone,
  body,
  timestampMs,
  invoiceId,
  externalId,
  status,
  errorMessage,
  messageType,
  attachments,
}) {
  const db = await loadDb();
  const client = clientId ? getClientByIdFromDb(db, clientId) : findClientByPhoneInDb(db, phone);

  const message = normalizeMessageRecord({
    id: nextId("msg"),
    direction: "out",
    status: status || "sent",
    externalId: externalId ?? null,
    fromPhone: client?.phone ?? phone,
    fromMatchKeys: buildPhoneMatchKeys(client?.phone ?? phone),
    clientId: client?.id ?? clientId ?? null,
    invoiceId: invoiceId ?? null,
    body: truncateText(body, 4000),
    attachments: normalizeAttachmentsList(attachments),
    timestampMs: timestampMs ?? Date.now(),
    createdAt: nowIso(),
    errorMessage: errorMessage ?? null,
    messageType: messageType || "text",
    ignored: false,
  });

  db.messages.push(message);
  db.messages = pruneMessages(db.messages);

  if (client) client.lastOutboundAt = nowIso();

  await persistDb();
  return message;
}

async function linkMessageToClient(messageId, clientId) {
  const db = await loadDb();
  const client = getClientByIdFromDb(db, clientId);
  const message = db.messages.find((entry) => entry.id === messageId);
  if (!client || !message) return null;

  const matchKeys = Array.isArray(message.fromMatchKeys) ? message.fromMatchKeys : buildPhoneMatchKeys(message.fromPhone);
  client.phoneMatchKeys = Array.from(new Set([...(client.phoneMatchKeys || []), ...matchKeys]));
  if (!client.phone && message.fromPhone) client.phone = onlyDigits(message.fromPhone);

  for (const entry of db.messages) {
    const entryKeys = Array.isArray(entry.fromMatchKeys) ? entry.fromMatchKeys : buildPhoneMatchKeys(entry.fromPhone);
    if (entry.direction === "in" && entryKeys.some((key) => matchKeys.includes(key))) {
      entry.clientId = client.id;
      entry.ignored = false;
    }
  }

  client.lastInboundAt = client.lastInboundAt || nowIso();
  await persistDb();
  return message;
}

async function deleteMessage(messageId, { onlyUnmatched = false } = {}) {
  const db = await loadDb();
  const index = db.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return false;
  if (onlyUnmatched && !isUnmatchedInboundMessage(db.messages[index])) return false;

  db.messages.splice(index, 1);
  await persistDb();
  return true;
}

async function deleteMessagesByPhone(rawPhone, { onlyUnmatched = false } = {}) {
  const db = await loadDb();
  const matchKeys = new Set(buildPhoneMatchKeys(rawPhone));
  let deletedCount = 0;

  db.messages = db.messages.filter((message) => {
    const messageKeys = Array.isArray(message.fromMatchKeys)
      ? message.fromMatchKeys
      : buildPhoneMatchKeys(message.fromPhone);
    const matchesPhone = messageKeys.some((key) => matchKeys.has(key));
    const eligible = onlyUnmatched ? isUnmatchedInboundMessage(message) : true;

    if (matchesPhone && eligible) {
      deletedCount += 1;
      return false;
    }

    return true;
  });

  if (deletedCount > 0) {
    await persistDb();
  }

  return deletedCount;
}

async function listMessages({ limit = 50 } = {}) {
  const db = await loadDb();
  return sortByTimestampDesc(
    db.messages.filter((message) => message.direction === "in" && message.ignored !== true)
  ).slice(0, limit);
}

async function listClientMessages(clientId, { limit = 50 } = {}) {
  const db = await loadDb();
  const client = getClientByIdFromDb(db, clientId);
  if (!client) return [];
  return sortByTimestampDesc(getConversationForClient(db, client)).slice(0, limit);
}

async function getDashboardStats() {
  const db = await loadDb();
  const inboxMessages = db.messages.filter((message) => message.direction === "in" && message.ignored !== true);
  const clientsNeedingAttention = db.clients.filter((client) => {
    if (!client.lastInboundAt) return false;
    if (!client.lastOutboundAt) return true;
    return client.lastInboundAt > client.lastOutboundAt;
  }).length;

  return {
    clientsCount: db.clients.length,
    invoicesCount: db.invoices.length,
    invoicesPendingCount: db.invoices.filter((invoice) => invoice.status === "pending").length,
    invoicesSendingCount: db.invoices.filter((invoice) => invoice.status === "sending").length,
    invoicesSentCount: db.invoices.filter((invoice) => invoice.status === "sent").length,
    invoicesFailedCount: db.invoices.filter((invoice) => invoice.status === "failed").length,
    inboxCount: inboxMessages.length,
    matchedInboxCount: inboxMessages.filter((message) => message.clientId).length,
    unmatchedInboxCount: inboxMessages.filter((message) => !message.clientId).length,
    clientsNeedingAttention,
  };
}

async function listFpaImports() {
  const db = await loadDb();
  return db.fpa.imports
    .slice()
    .sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

function assertUniqueFpaDreCategories(db, categories, { excludingId = null } = {}) {
  const requestedCategories = Array.from(
    new Set((Array.isArray(categories) ? categories : []).map((value) => normalizeOptionalText(value, 80)).filter(Boolean))
  );

  requestedCategories.forEach((category) => {
    const categoryKey = normalizeFpaLookupKey(category);
    const duplicated = db.fpa.dreAccounts.find(
      (entry) =>
        entry.id !== excludingId &&
        Array.isArray(entry.categories) &&
        entry.categories.some((assignedCategory) => normalizeFpaLookupKey(assignedCategory) === categoryKey)
    );

    if (duplicated) {
      throw new Error(`A categoria "${category}" já está vinculada à conta DRE "${duplicated.name}".`);
    }
  });
}

async function listFpaDreAccounts() {
  const db = await loadDb();
  return sortFpaDreAccounts(db.fpa.dreAccounts);
}

async function createFpaDreAccount(payload = {}) {
  const db = await loadDb();
  const normalized = normalizeFpaDreAccountRecord({
    ...payload,
    id: nextId("dre"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  if (!normalized) {
    throw new Error("Informe um nome válido para a conta DRE.");
  }

  assertUniqueFpaDreCategories(db, normalized.categories);
  db.fpa.dreAccounts.push(normalized);
  db.fpa.dreAccounts = sortFpaDreAccounts(db.fpa.dreAccounts);
  await persistDb();
  return normalized;
}

async function seedFpaDreAccounts(accounts = []) {
  const db = await loadDb();
  if (db.fpa.dreAccounts.length) {
    throw new Error("O plano DRE já possui contas cadastradas.");
  }

  const normalizedAccounts = (Array.isArray(accounts) ? accounts : [])
    .map((entry, index) =>
      normalizeFpaDreAccountRecord({
        ...entry,
        id: nextId("dre"),
        orderIndex: Number.isFinite(Number(entry?.orderIndex)) ? entry.orderIndex : (index + 1) * 10,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
    )
    .filter(Boolean);

  normalizedAccounts.forEach((entry) => assertUniqueFpaDreCategories(db, entry.categories));
  const stagedAccounts = [];
  normalizedAccounts.forEach((entry) => {
    assertUniqueFpaDreCategories({ fpa: { dreAccounts: stagedAccounts } }, entry.categories);
    stagedAccounts.push(entry);
  });

  db.fpa.dreAccounts = sortFpaDreAccounts(stagedAccounts);
  await persistDb();
  return db.fpa.dreAccounts;
}

async function listFpaTransactions({ from = null, to = null, limit = 200 } = {}) {
  const db = await loadDb();
  let transactions = sortFpaTransactions(db.fpa.transactions);

  if (from) {
    transactions = transactions.filter((transaction) => transaction.transactionDate >= from);
  }
  if (to) {
    transactions = transactions.filter((transaction) => transaction.transactionDate <= to);
  }

  if (Number.isFinite(limit) && limit > 0) {
    transactions = transactions.slice(0, Math.trunc(limit));
  }

  return transactions;
}

async function createFpaImport({ sourceType, originalFilename, accountName, transactions }) {
  const db = await loadDb();
  const importId = nextId("stmt");
  const existingFingerprints = new Set(db.fpa.transactions.map((transaction) => transaction.fingerprint).filter(Boolean));
  const insertedTransactions = [];
  let duplicateCount = 0;

  for (const rawTransaction of Array.isArray(transactions) ? transactions : []) {
    const normalizedTransaction = normalizeFpaTransactionRecord({
      ...rawTransaction,
      id: nextId("txn"),
      importId,
      sourceType,
      originalFilename,
      accountName: rawTransaction?.accountName || accountName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    if (!normalizedTransaction) continue;

    if (normalizedTransaction.fingerprint && existingFingerprints.has(normalizedTransaction.fingerprint)) {
      duplicateCount += 1;
      continue;
    }

    if (normalizedTransaction.fingerprint) {
      existingFingerprints.add(normalizedTransaction.fingerprint);
    }

    insertedTransactions.push(normalizedTransaction);
  }

  const sortedInsertedTransactions = insertedTransactions
    .slice()
    .sort((a, b) => (a.transactionDate < b.transactionDate ? -1 : 1));

  const importRecord = normalizeFpaImportRecord({
    id: importId,
    sourceType,
    originalFilename,
    accountName,
    importedAt: nowIso(),
    totalRows: Array.isArray(transactions) ? transactions.length : 0,
    importedCount: insertedTransactions.length,
    duplicateCount,
    dateFrom: sortedInsertedTransactions[0]?.transactionDate || null,
    dateTo: sortedInsertedTransactions.at(-1)?.transactionDate || null,
  });

  db.fpa.imports.unshift(importRecord);
  db.fpa.transactions.push(...insertedTransactions);
  db.fpa.transactions = sortFpaTransactions(db.fpa.transactions);

  await persistDb();
  return {
    importRecord,
    importedTransactions: insertedTransactions,
    duplicateCount,
  };
}

async function deleteFpaAccount(accountName) {
  const db = await loadDb();
  const accountKey = normalizeFpaAccountKey(accountName);
  if (!accountKey) return null;

  const originalImportsCount = db.fpa.imports.length;
  const originalTransactionsCount = db.fpa.transactions.length;

  db.fpa.imports = db.fpa.imports.filter((entry) => normalizeFpaAccountKey(entry.accountName) !== accountKey);
  db.fpa.transactions = db.fpa.transactions.filter((entry) => normalizeFpaAccountKey(entry.accountName) !== accountKey);

  const deletedImports = originalImportsCount - db.fpa.imports.length;
  const deletedTransactions = originalTransactionsCount - db.fpa.transactions.length;

  if (deletedImports <= 0 && deletedTransactions <= 0) {
    return null;
  }

  await persistDb();
  return {
    accountName: normalizeOptionalText(accountName, 120),
    deletedImports,
    deletedTransactions,
  };
}

async function deleteFpaTransaction(id) {
  const db = await loadDb();
  const index = db.fpa.transactions.findIndex((entry) => entry.id === id);
  if (index < 0) return null;

  const [deletedTransaction] = db.fpa.transactions.splice(index, 1);
  const importId = deletedTransaction.importId || null;
  let deletedImportId = null;

  if (importId && !db.fpa.transactions.some((entry) => entry.importId === importId)) {
    const importIndex = db.fpa.imports.findIndex((entry) => entry.id === importId);
    if (importIndex >= 0) {
      deletedImportId = db.fpa.imports[importIndex].id;
      db.fpa.imports.splice(importIndex, 1);
    }
  }

  await persistDb();
  return {
    transactionId: deletedTransaction.id,
    accountName: deletedTransaction.accountName,
    importId,
    deletedImportId,
  };
}

async function updateFpaDreAccount(id, patch = {}) {
  const db = await loadDb();
  const current = db.fpa.dreAccounts.find((entry) => entry.id === id);
  if (!current) return null;

  const normalized = normalizeFpaDreAccountRecord({
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  });

  if (!normalized) {
    throw new Error("Informe um nome válido para a conta DRE.");
  }

  assertUniqueFpaDreCategories(db, normalized.categories, { excludingId: id });
  Object.assign(current, normalized);
  db.fpa.dreAccounts = sortFpaDreAccounts(db.fpa.dreAccounts);
  await persistDb();
  return current;
}

async function deleteFpaDreAccount(id) {
  const db = await loadDb();
  const index = db.fpa.dreAccounts.findIndex((entry) => entry.id === id);
  if (index < 0) return null;

  const [deleted] = db.fpa.dreAccounts.splice(index, 1);
  await persistDb();
  return deleted;
}

function applyFpaTransactionPatch(transaction, patch = {}) {
  if ("category" in patch) {
    transaction.category = normalizeOptionalText(patch.category, 80) || transaction.category;
  }
  if ("subcategory" in patch) {
    transaction.subcategory = normalizeOptionalText(patch.subcategory, 120);
  }
  if ("reportSection" in patch) {
    transaction.reportSection = normalizeOptionalText(patch.reportSection, 40) || transaction.reportSection;
  }
  if ("notes" in patch) {
    transaction.notes = normalizeOptionalText(patch.notes, 2000);
  }
  if ("isInternalTransfer" in patch) {
    transaction.isInternalTransfer = patch.isInternalTransfer === true;
    if (transaction.isInternalTransfer) {
      transaction.category = "Transferências Internas";
      transaction.reportSection = "internal_transfer";
    }
  }

  transaction.updatedAt = nowIso();
  return transaction;
}

async function updateFpaTransaction(id, patch = {}) {
  const db = await loadDb();
  const transaction = db.fpa.transactions.find((entry) => entry.id === id);
  if (!transaction) return null;

  applyFpaTransactionPatch(transaction, patch);
  await persistDb();
  return transaction;
}

async function updateFpaTransactionsBatch(updates = []) {
  const db = await loadDb();
  const normalizedUpdates = Array.isArray(updates) ? updates : [];
  const updatedTransactions = [];

  normalizedUpdates.forEach((update) => {
    const id = normalizeOptionalText(update?.id, 80);
    if (!id) {
      throw new Error("Cada alteração em lote precisa informar o id do lançamento.");
    }

    const transaction = db.fpa.transactions.find((entry) => entry.id === id);
    if (!transaction) {
      throw new Error(`Lançamento financeiro não encontrado: ${id}.`);
    }

    applyFpaTransactionPatch(transaction, update);
    updatedTransactions.push(transaction);
  });

  if (!updatedTransactions.length) {
    return [];
  }

  await persistDb();
  return updatedTransactions;
}

module.exports = {
  addInboundMessage,
  addOutboundMessage,
  createFpaImport,
  createFpaDreAccount,
  createClient,
  createInvoice,
  createTemplate,
  deleteClient,
  deleteFpaAccount,
  deleteFpaDreAccount,
  deleteFpaTransaction,
  deleteMessage,
  deleteMessagesByPhone,
  deleteTemplate,
  getActiveTemplate,
  getClient,
  getDashboardStats,
  getInvoice,
  getSettings,
  getTemplate,
  findClientByPhone,
  findInvoiceByIntegration,
  linkMessageToClient,
  listFpaDreAccounts,
  listFpaImports,
  listFpaTransactions,
  listClientMessages,
  listClients,
  listInvoices,
  listMessages,
  listTemplates,
  markInvoicePaid,
  markInvoiceSendAttempt,
  markInvoiceSendResult,
  seedFpaDreAccounts,
  updateFpaDreAccount,
  updateFpaTransaction,
  updateFpaTransactionsBatch,
  updateClient,
  updateInvoice,
  updateSettings,
  updateTemplate,
};
