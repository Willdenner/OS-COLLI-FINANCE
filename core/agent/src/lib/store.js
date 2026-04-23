const fs = require("node:fs/promises");
const path = require("node:path");

const { buildTransactionFingerprint } = require("./fpa");
const { DATA_DIR, truncateText } = require("./domain");
const {
  createDefaultContaAzulSettings,
  mergeContaAzulSettings,
  normalizeContaAzulSettings,
  prependContaAzulSyncHistory,
} = require("./conta-azul");

const DB_PATH = path.join(DATA_DIR, "db.json");
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

function getStorageStatus() {
  const databaseEnabled = isDatabaseEnabled();
  const customDataDir = Boolean(String(process.env.BOT_DATA_DIR || "").trim());
  return {
    mode: databaseEnabled ? "postgres" : "file",
    durable: databaseEnabled,
    needsPersistentStorage: !databaseEnabled,
    dataPath: databaseEnabled ? null : DB_PATH,
    message: databaseEnabled
      ? "Persistência ativa em PostgreSQL."
      : customDataDir
        ? "Persistência em arquivo local configurado por BOT_DATA_DIR. Garanta que o diretório esteja em disco persistente no deploy."
        : "Persistência em arquivo local padrão. Em deploy sem disco persistente, os dados podem sumir quando o serviço reiniciar.",
  };
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
  const sslMode = String(process.env.DATABASE_SSL || "").trim().toLowerCase();

  pgPool = new Pool({
    connectionString: String(process.env.DATABASE_URL || "").trim(),
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

function normalizeFpaPatternText(value) {
  return normalizeFpaLookupKey(value)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token))
    .slice(0, 10)
    .join(" ");
}

function buildFpaCategoryRuleSignature(transaction = {}) {
  const accountKey = normalizeFpaAccountKey(transaction.accountName);
  const descriptionPattern = normalizeFpaPatternText(transaction.counterparty || transaction.description);
  if (!descriptionPattern) return null;
  return `${accountKey || "all"}::${descriptionPattern}`;
}

function normalizeContaAzulState(contaAzulSettings) {
  return normalizeContaAzulSettings(contaAzulSettings || createDefaultContaAzulSettings());
}

function createDefaultLovableSettings() {
  return {
    enabled: false,
    webhookSecret: "",
    contractsWebhookPath: "/api/integrations/lovable/contracts",
    receiptsWebhookPath: "/api/integrations/lovable/receipts",
    updatedAt: null,
  };
}

function normalizeLovableSettings(lovableSettings) {
  const defaults = createDefaultLovableSettings();
  const safeSettings = lovableSettings && typeof lovableSettings === "object" ? lovableSettings : {};
  return {
    ...defaults,
    enabled: safeSettings.enabled === true,
    webhookSecret: normalizeOptionalText(safeSettings.webhookSecret, 500) || "",
    contractsWebhookPath: normalizeOptionalText(safeSettings.contractsWebhookPath, 260) || defaults.contractsWebhookPath,
    receiptsWebhookPath: normalizeOptionalText(safeSettings.receiptsWebhookPath, 260) || defaults.receiptsWebhookPath,
    updatedAt: safeSettings.updatedAt || null,
  };
}

function readBooleanPatch(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "sim", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "nao", "não", "no", "off"].includes(normalized)) return false;
  return null;
}

function mergeLovableSettings(currentSettings, patch = {}) {
  const current = normalizeLovableSettings(currentSettings);
  const safePatch = patch && typeof patch === "object" ? patch : {};
  const next = { ...current };
  const enabledPatch = readBooleanPatch(safePatch.enabled);

  if (enabledPatch != null) next.enabled = enabledPatch;
  if (safePatch.clearWebhookSecret === true) {
    next.webhookSecret = "";
  } else {
    const webhookSecret = normalizeOptionalText(safePatch.webhookSecret, 500);
    if (webhookSecret) next.webhookSecret = webhookSecret;
  }

  const contractsWebhookPath = normalizeOptionalText(safePatch.contractsWebhookPath, 260);
  const receiptsWebhookPath = normalizeOptionalText(safePatch.receiptsWebhookPath, 260);
  if (contractsWebhookPath) next.contractsWebhookPath = contractsWebhookPath;
  if (receiptsWebhookPath) next.receiptsWebhookPath = receiptsWebhookPath;

  next.updatedAt = nowIso();
  return normalizeLovableSettings(next);
}

function sanitizeLovableSettings(lovableSettings) {
  const safeSettings = normalizeLovableSettings(lovableSettings);
  const environmentSecret = String(process.env.LOVABLE_WEBHOOK_SECRET || "").trim();
  const hasStoredWebhookSecret = Boolean(safeSettings.webhookSecret);
  const usesEnvironmentSecret = Boolean(environmentSecret);

  return {
    enabled: safeSettings.enabled,
    contractsWebhookPath: safeSettings.contractsWebhookPath,
    receiptsWebhookPath: safeSettings.receiptsWebhookPath,
    hasWebhookSecret: hasStoredWebhookSecret || usesEnvironmentSecret,
    hasStoredWebhookSecret,
    usesEnvironmentSecret,
    integrationEnabled: usesEnvironmentSecret || (safeSettings.enabled && hasStoredWebhookSecret),
    updatedAt: safeSettings.updatedAt,
  };
}

function createEmptyFpaState() {
  return {
    imports: [],
    transactions: [],
    dreAccounts: [],
    categoryRules: [],
    lovableContracts: [],
    lovableReceipts: [],
    receivablesOrchestratorRuns: [],
  };
}

function createEmptyDb() {
  return {
    settings: {
      contaAzul: normalizeContaAzulState(null),
      lovable: normalizeLovableSettings(null),
      updatedAt: nowIso(),
    },
    fpa: createEmptyFpaState(),
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

function sortFpaCategoryRules(rules) {
  return (Array.isArray(rules) ? rules : []).slice().sort((a, b) => {
    const dateCompare = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    if (dateCompare !== 0) return dateCompare;
    return String(a.descriptionPattern || "").localeCompare(String(b.descriptionPattern || ""), "pt-BR", { sensitivity: "base" });
  });
}

function sortIntegrationSyncRecords(items) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => {
    const dateCompare = String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
    if (dateCompare !== 0) return dateCompare;
    return String(a.externalId || "").localeCompare(String(b.externalId || ""), "pt-BR", { sensitivity: "base" });
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
    integration:
      transaction.integration && typeof transaction.integration === "object"
        ? {
            contaAzul:
              transaction.integration.contaAzul && typeof transaction.integration.contaAzul === "object"
                ? {
                    status: normalizeOptionalText(transaction.integration.contaAzul.status, 40),
                    eventId: normalizeOptionalText(transaction.integration.contaAzul.eventId, 160),
                    endpoint: normalizeOptionalText(transaction.integration.contaAzul.endpoint, 260),
                    responseCode: Number.isFinite(Number(transaction.integration.contaAzul.responseCode))
                      ? Math.trunc(Number(transaction.integration.contaAzul.responseCode))
                      : null,
                    exportedAt: transaction.integration.contaAzul.exportedAt || null,
                    errorMessage: normalizeOptionalText(transaction.integration.contaAzul.errorMessage, 400),
                  }
                : null,
          }
        : null,
    sourceRowNumber: Math.max(1, Math.trunc(Number(transaction.sourceRowNumber ?? 1) || 1)),
    createdAt: transaction.createdAt || nowIso(),
    updatedAt: transaction.updatedAt || transaction.createdAt || nowIso(),
  };
}

function normalizeFpaCategoryRuleRecord(rule) {
  if (!rule || typeof rule !== "object") return null;

  const category = normalizeOptionalText(rule.category, 80);
  const descriptionPattern = normalizeFpaPatternText(rule.descriptionPattern || rule.description || rule.counterparty);
  if (!category || !descriptionPattern) return null;

  const accountName = normalizeOptionalText(rule.accountName, 120);
  const accountKey = normalizeFpaAccountKey(rule.accountKey || accountName);
  const signature = normalizeOptionalText(rule.signature, 260) || `${accountKey || "all"}::${descriptionPattern}`;

  return {
    id: rule.id || nextId("fparule"),
    signature,
    accountName,
    accountKey,
    descriptionPattern,
    category,
    subcategory: normalizeOptionalText(rule.subcategory, 120),
    reportSection: normalizeOptionalText(rule.reportSection, 40) || "uncategorized",
    isInternalTransfer: rule.isInternalTransfer === true,
    sourceTransactionId: normalizeOptionalText(rule.sourceTransactionId, 80),
    matchCount: Math.max(0, Math.trunc(Number(rule.matchCount ?? 0) || 0)),
    lastMatchedAt: rule.lastMatchedAt || null,
    createdAt: rule.createdAt || nowIso(),
    updatedAt: rule.updatedAt || rule.createdAt || nowIso(),
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

function normalizeLovableContractSyncRecord(record) {
  if (!record || typeof record !== "object") return null;
  const externalId = normalizeOptionalText(record.externalId || record.contractId || record.id, 160);
  if (!externalId) return null;
  const amountCents = Number(record.amountCents);

  return {
    id: record.id || nextId("lvcontract"),
    source: normalizeOptionalText(record.source, 40) || "lovable",
    externalId,
    customerName: normalizeOptionalText(record.customerName, 180),
    customerDocument: normalizeOptionalText(record.customerDocument, 40),
    contractNumber: Number.isFinite(Number(record.contractNumber)) ? Math.trunc(Number(record.contractNumber)) : null,
    amountCents: Number.isFinite(amountCents) ? Math.trunc(amountCents) : 0,
    status: normalizeOptionalText(record.status, 40) || "pending",
    contaAzulContractId: normalizeOptionalText(record.contaAzulContractId, 160),
    contaAzulSaleId: normalizeOptionalText(record.contaAzulSaleId, 160),
    contaAzulLegacyId: Number.isFinite(Number(record.contaAzulLegacyId)) ? Math.trunc(Number(record.contaAzulLegacyId)) : null,
    endpoint: normalizeOptionalText(record.endpoint, 260),
    responseCode: Number.isFinite(Number(record.responseCode)) ? Math.trunc(Number(record.responseCode)) : null,
    responsePreview: normalizeOptionalText(record.responsePreview, 1200),
    errorMessage: normalizeOptionalText(record.errorMessage, 400),
    requestPayload: record.requestPayload && typeof record.requestPayload === "object" ? record.requestPayload : null,
    responsePayload: record.responsePayload && typeof record.responsePayload === "object" ? record.responsePayload : null,
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || record.createdAt || nowIso(),
    syncedAt: record.syncedAt || null,
  };
}

function normalizeLovableReceiptSyncRecord(record) {
  if (!record || typeof record !== "object") return null;
  const externalId = normalizeOptionalText(record.externalId || record.receiptId || record.paymentId || record.id, 160);
  if (!externalId) return null;
  const amountCents = Number(record.amountCents);

  return {
    id: record.id || nextId("lvreceipt"),
    source: normalizeOptionalText(record.source, 40) || "lovable",
    externalId,
    externalContractId: normalizeOptionalText(record.externalContractId, 160),
    paymentDate: normalizeOptionalText(record.paymentDate, 10),
    amountCents: Number.isFinite(amountCents) ? Math.trunc(amountCents) : 0,
    status: normalizeOptionalText(record.status, 40) || "pending",
    contaAzulInstallmentId: normalizeOptionalText(record.contaAzulInstallmentId, 160),
    contaAzulAcquittanceId: normalizeOptionalText(record.contaAzulAcquittanceId, 160),
    endpoint: normalizeOptionalText(record.endpoint, 260),
    responseCode: Number.isFinite(Number(record.responseCode)) ? Math.trunc(Number(record.responseCode)) : null,
    responsePreview: normalizeOptionalText(record.responsePreview, 1200),
    errorMessage: normalizeOptionalText(record.errorMessage, 400),
    requestPayload: record.requestPayload && typeof record.requestPayload === "object" ? record.requestPayload : null,
    responsePayload: record.responsePayload && typeof record.responsePayload === "object" ? record.responsePayload : null,
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || record.createdAt || nowIso(),
    syncedAt: record.syncedAt || null,
  };
}

function normalizeReceivablesOrchestratorRunRecord(record) {
  if (!record || typeof record !== "object") return null;
  const id = normalizeOptionalText(record.id, 120) || nextId("receivables");
  const businessDate = normalizeOptionalText(record.businessDate, 10) || nowIso().slice(0, 10);
  const status = normalizeOptionalText(record.status, 60) || "idle";

  return {
    id,
    businessDate,
    status,
    phase: normalizeOptionalText(record.phase, 80) || status,
    title: normalizeOptionalText(record.title, 160) || "Ciclo diário de contas a receber",
    summary: record.summary && typeof record.summary === "object" ? record.summary : {},
    steps: Array.isArray(record.steps) ? record.steps.slice(-80) : [],
    missingPaymentLinks: Array.isArray(record.missingPaymentLinks) ? record.missingPaymentLinks.slice(0, 500) : [],
    invoicesToSend: Array.isArray(record.invoicesToSend) ? record.invoicesToSend.slice(0, 1000) : [],
    financePayload: record.financePayload && typeof record.financePayload === "object" ? record.financePayload : {},
    batchSend: record.batchSend && typeof record.batchSend === "object" ? record.batchSend : null,
    lastError: normalizeOptionalText(record.lastError, 1200),
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || record.createdAt || nowIso(),
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
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
    categoryRules: Array.isArray(safeState.categoryRules)
      ? sortFpaCategoryRules(safeState.categoryRules.map(normalizeFpaCategoryRuleRecord).filter(Boolean))
      : [],
    lovableContracts: Array.isArray(safeState.lovableContracts)
      ? sortIntegrationSyncRecords(safeState.lovableContracts.map(normalizeLovableContractSyncRecord).filter(Boolean))
      : [],
    lovableReceipts: Array.isArray(safeState.lovableReceipts)
      ? sortIntegrationSyncRecords(safeState.lovableReceipts.map(normalizeLovableReceiptSyncRecord).filter(Boolean))
      : [],
    receivablesOrchestratorRuns: Array.isArray(safeState.receivablesOrchestratorRuns)
      ? safeState.receivablesOrchestratorRuns
          .map(normalizeReceivablesOrchestratorRunRecord)
          .filter(Boolean)
          .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
          .slice(0, 100)
      : [],
  };
}

function normalizeDbShape(db) {
  const safeDb = !db || typeof db !== "object" ? createEmptyDb() : db;
  const safeSettings = safeDb.settings && typeof safeDb.settings === "object" ? safeDb.settings : {};

  return {
    settings: {
      contaAzul: normalizeContaAzulState(safeSettings.contaAzul),
      lovable: normalizeLovableSettings(safeSettings.lovable),
      updatedAt: safeSettings.updatedAt || nowIso(),
    },
    fpa: normalizeFpaState(safeDb.fpa),
  };
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
      if (result.rows.length) {
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

  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    dbCache = normalizeDbShape(JSON.parse(raw));
    return dbCache;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    dbCache = createEmptyDb();
    await persistDb();
    return dbCache;
  }
}

async function persistDb() {
  const payload = JSON.stringify(dbCache, null, 2);
  writeChain = writeChain.then(async () => {
    if (isDatabaseEnabled()) {
      try {
        await ensurePgStateTable();
        const pool = getPgPool();
        await pool.query(
          `
            insert into app_state (key, value, updated_at)
            values ($1, $2::jsonb, now())
            on conflict (key)
            do update set value = excluded.value, updated_at = now()
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
    await fs.writeFile(DB_PATH, payload);
  });

  return writeChain;
}

async function getSettings() {
  const db = await loadDb();
  return db.settings;
}

async function updateSettings(patch = {}) {
  const db = await loadDb();

  if (patch.contaAzul && typeof patch.contaAzul === "object") {
    db.settings.contaAzul = mergeContaAzulSettings(db.settings.contaAzul, patch.contaAzul);
  }
  if (patch.lovable && typeof patch.lovable === "object") {
    db.settings.lovable = mergeLovableSettings(db.settings.lovable, patch.lovable);
  }

  const { contaAzul, lovable, ...restPatch } = patch || {};
  db.settings = { ...db.settings, ...restPatch, updatedAt: nowIso() };
  await persistDb();
  return db.settings;
}

async function recordContaAzulSync(entry, statusPatch = {}) {
  const db = await loadDb();
  const currentContaAzul = normalizeContaAzulState(db.settings.contaAzul);
  db.settings.contaAzul = mergeContaAzulSettings(currentContaAzul, {
    status: {
      ...currentContaAzul.status,
      ...statusPatch,
      lastError: "lastError" in statusPatch ? statusPatch.lastError : currentContaAzul.status.lastError,
    },
    syncHistory: prependContaAzulSyncHistory(currentContaAzul.syncHistory, entry),
  });
  db.settings.updatedAt = nowIso();
  await persistDb();
  return db.settings.contaAzul;
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

async function listFpaCategoryRules({ limit = 100 } = {}) {
  const db = await loadDb();
  const rules = sortFpaCategoryRules(db.fpa.categoryRules);
  if (Number.isFinite(limit) && limit > 0) {
    return rules.slice(0, Math.trunc(limit));
  }
  return rules;
}

function findFpaCategoryRuleForTransaction(rules, transaction = {}) {
  const signature = buildFpaCategoryRuleSignature(transaction);
  if (!signature) return null;
  return (Array.isArray(rules) ? rules : []).find((rule) => rule.signature === signature) || null;
}

function applyFpaCategoryRuleToTransaction(transaction, rule) {
  if (!rule) return transaction;
  return {
    ...transaction,
    category: rule.category,
    subcategory: rule.subcategory || transaction.subcategory,
    reportSection: rule.isInternalTransfer ? "internal_transfer" : rule.reportSection || transaction.reportSection,
    isInternalTransfer: rule.isInternalTransfer === true,
    categoryConfidence: Math.max(Number(transaction.categoryConfidence || 0), 0.98),
  };
}

function upsertFpaCategoryRuleFromTransaction(db, transaction) {
  const normalizedRule = normalizeFpaCategoryRuleRecord({
    accountName: transaction.accountName,
    descriptionPattern: transaction.counterparty || transaction.description,
    category: transaction.category,
    subcategory: transaction.subcategory,
    reportSection: transaction.reportSection,
    isInternalTransfer: transaction.isInternalTransfer === true,
    sourceTransactionId: transaction.id,
  });

  if (!normalizedRule) return null;

  const existing = db.fpa.categoryRules.find((rule) => rule.signature === normalizedRule.signature);
  if (existing) {
    Object.assign(existing, {
      accountName: normalizedRule.accountName,
      accountKey: normalizedRule.accountKey,
      descriptionPattern: normalizedRule.descriptionPattern,
      category: normalizedRule.category,
      subcategory: normalizedRule.subcategory,
      reportSection: normalizedRule.reportSection,
      isInternalTransfer: normalizedRule.isInternalTransfer,
      sourceTransactionId: normalizedRule.sourceTransactionId,
      updatedAt: nowIso(),
    });
    db.fpa.categoryRules = sortFpaCategoryRules(db.fpa.categoryRules);
    return existing;
  }

  db.fpa.categoryRules.unshift(normalizedRule);
  db.fpa.categoryRules = sortFpaCategoryRules(db.fpa.categoryRules).slice(0, 500);
  return normalizedRule;
}

async function createFpaImport({ sourceType, originalFilename, accountName, transactions }) {
  const db = await loadDb();
  const importId = nextId("stmt");
  const existingFingerprints = new Set(db.fpa.transactions.map((transaction) => transaction.fingerprint).filter(Boolean));
  const insertedTransactions = [];
  let duplicateCount = 0;

  for (const rawTransaction of Array.isArray(transactions) ? transactions : []) {
    const matchedRule = findFpaCategoryRuleForTransaction(db.fpa.categoryRules, {
      ...rawTransaction,
      accountName: rawTransaction?.accountName || accountName,
    });
    const learnedTransaction = applyFpaCategoryRuleToTransaction(rawTransaction, matchedRule);
    const normalizedTransaction = normalizeFpaTransactionRecord({
      ...learnedTransaction,
      id: nextId("txn"),
      importId,
      sourceType,
      originalFilename,
      accountName: learnedTransaction?.accountName || accountName,
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
    if (matchedRule) {
      matchedRule.matchCount = Math.max(0, Number(matchedRule.matchCount || 0)) + 1;
      matchedRule.lastMatchedAt = nowIso();
      matchedRule.updatedAt = nowIso();
    }
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
  if ("integration" in patch && patch.integration && typeof patch.integration === "object") {
    const currentIntegration = transaction.integration && typeof transaction.integration === "object" ? transaction.integration : {};
    transaction.integration = {
      ...currentIntegration,
      contaAzul:
        patch.integration.contaAzul && typeof patch.integration.contaAzul === "object"
          ? {
              ...((currentIntegration.contaAzul && typeof currentIntegration.contaAzul === "object" ? currentIntegration.contaAzul : {})),
              status: normalizeOptionalText(patch.integration.contaAzul.status, 40),
              eventId: normalizeOptionalText(patch.integration.contaAzul.eventId, 160),
              endpoint: normalizeOptionalText(patch.integration.contaAzul.endpoint, 260),
              responseCode: Number.isFinite(Number(patch.integration.contaAzul.responseCode))
                ? Math.trunc(Number(patch.integration.contaAzul.responseCode))
                : null,
              exportedAt: patch.integration.contaAzul.exportedAt || nowIso(),
              errorMessage: normalizeOptionalText(patch.integration.contaAzul.errorMessage, 400),
            }
          : currentIntegration.contaAzul || null,
    };
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
  if ("category" in patch || "isInternalTransfer" in patch) {
    upsertFpaCategoryRuleFromTransaction(db, transaction);
  }
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
    if ("category" in update || "isInternalTransfer" in update) {
      upsertFpaCategoryRuleFromTransaction(db, transaction);
    }
    updatedTransactions.push(transaction);
  });

  if (!updatedTransactions.length) {
    return [];
  }

  await persistDb();
  return updatedTransactions;
}

async function listLovableContractSyncs({ limit = 100 } = {}) {
  const db = await loadDb();
  const contracts = sortIntegrationSyncRecords(db.fpa.lovableContracts);
  if (Number.isFinite(limit) && limit > 0) return contracts.slice(0, Math.trunc(limit));
  return contracts;
}

async function listLovableReceiptSyncs({ limit = 100 } = {}) {
  const db = await loadDb();
  const receipts = sortIntegrationSyncRecords(db.fpa.lovableReceipts);
  if (Number.isFinite(limit) && limit > 0) return receipts.slice(0, Math.trunc(limit));
  return receipts;
}

async function findLovableContractSync(externalId) {
  const db = await loadDb();
  const safeExternalId = normalizeOptionalText(externalId, 160);
  if (!safeExternalId) return null;
  return db.fpa.lovableContracts.find((entry) => entry.externalId === safeExternalId) || null;
}

async function findLovableReceiptSync(externalId) {
  const db = await loadDb();
  const safeExternalId = normalizeOptionalText(externalId, 160);
  if (!safeExternalId) return null;
  return db.fpa.lovableReceipts.find((entry) => entry.externalId === safeExternalId) || null;
}

async function upsertLovableContractSync(record = {}) {
  const db = await loadDb();
  const normalized = normalizeLovableContractSyncRecord({ ...record, updatedAt: nowIso() });
  if (!normalized) throw new Error("Informe um identificador externo válido para o contrato Lovable.");

  const existing = db.fpa.lovableContracts.find((entry) => entry.externalId === normalized.externalId);
  if (existing) {
    Object.assign(existing, {
      ...existing,
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
  } else {
    db.fpa.lovableContracts.unshift(normalized);
  }

  db.fpa.lovableContracts = sortIntegrationSyncRecords(db.fpa.lovableContracts).slice(0, 1000);
  await persistDb();
  return db.fpa.lovableContracts.find((entry) => entry.externalId === normalized.externalId);
}

async function upsertLovableReceiptSync(record = {}) {
  const db = await loadDb();
  const normalized = normalizeLovableReceiptSyncRecord({ ...record, updatedAt: nowIso() });
  if (!normalized) throw new Error("Informe um identificador externo válido para o recebimento Lovable.");

  const existing = db.fpa.lovableReceipts.find((entry) => entry.externalId === normalized.externalId);
  if (existing) {
    Object.assign(existing, {
      ...existing,
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
  } else {
    db.fpa.lovableReceipts.unshift(normalized);
  }

  db.fpa.lovableReceipts = sortIntegrationSyncRecords(db.fpa.lovableReceipts).slice(0, 1000);
  await persistDb();
  return db.fpa.lovableReceipts.find((entry) => entry.externalId === normalized.externalId);
}

async function listReceivablesOrchestratorRuns({ limit = 20 } = {}) {
  const db = await loadDb();
  const runs = (db.fpa.receivablesOrchestratorRuns || [])
    .slice()
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  if (Number.isFinite(limit) && limit > 0) return runs.slice(0, Math.trunc(limit));
  return runs;
}

async function getLatestReceivablesOrchestratorRun() {
  const runs = await listReceivablesOrchestratorRuns({ limit: 1 });
  return runs[0] || null;
}

async function upsertReceivablesOrchestratorRun(run = {}) {
  const db = await loadDb();
  const normalized = normalizeReceivablesOrchestratorRunRecord({ ...run, updatedAt: nowIso() });
  if (!normalized) throw new Error("Execução de contas a receber inválida.");

  const existing = db.fpa.receivablesOrchestratorRuns.find((entry) => entry.id === normalized.id);
  if (existing) {
    Object.assign(existing, {
      ...existing,
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
  } else {
    db.fpa.receivablesOrchestratorRuns.unshift(normalized);
  }

  db.fpa.receivablesOrchestratorRuns = db.fpa.receivablesOrchestratorRuns
    .map(normalizeReceivablesOrchestratorRunRecord)
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, 100);
  await persistDb();
  return db.fpa.receivablesOrchestratorRuns.find((entry) => entry.id === normalized.id);
}

module.exports = {
  createFpaImport,
  createFpaDreAccount,
  deleteFpaAccount,
  deleteFpaDreAccount,
  deleteFpaTransaction,
  getSettings,
  getStorageStatus,
  findLovableContractSync,
  findLovableReceiptSync,
  getLatestReceivablesOrchestratorRun,
  listFpaCategoryRules,
  listFpaDreAccounts,
  listFpaImports,
  listFpaTransactions,
  listLovableContractSyncs,
  listLovableReceiptSyncs,
  listReceivablesOrchestratorRuns,
  recordContaAzulSync,
  sanitizeLovableSettings,
  seedFpaDreAccounts,
  upsertReceivablesOrchestratorRun,
  upsertLovableContractSync,
  upsertLovableReceiptSync,
  updateFpaDreAccount,
  updateFpaTransaction,
  updateFpaTransactionsBatch,
  updateSettings,
};
