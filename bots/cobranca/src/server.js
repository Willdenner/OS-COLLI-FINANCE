const path = require("node:path");
const fs = require("node:fs/promises");

const express = require("express");
const multer = require("multer");
const { createBasicAuthMiddleware, getAdminCredentialsFromEnv } = require("./lib/basic-auth");
const {
  TEMPLATE_FILENAME: CLIENT_IMPORT_TEMPLATE_FILENAME,
  createClientImportTemplateBuffer,
  parseClientImportBuffer,
} = require("./lib/client-import");
const {
  computeInvoiceRuleState,
  mapRuleStatusToInvoiceStatus,
  normalizeRuleOffsetDays,
} = require("./lib/billing-rule");

const {
  DEFAULT_BATCH_SEND_DELAY_MS,
  isBatchEligibleInvoice,
  normalizeBatchDelayMs,
  normalizeBatchInvoiceIds,
  sortInvoicesForBatch,
} = require("./lib/batch-send");
const {
  UPLOADS_DIR,
  buildPaymentTemplateContext,
  formatIsoDateToBR,
  formatMoneyBRL,
  isIsoDate,
  isPossiblePhone,
  normalizeName,
  normalizePaymentLink,
  onlyDigits,
  renderTemplate,
  truncateText,
} = require("./lib/domain");
const {
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
} = require("./lib/store");
const { createEmailService, normalizeAppPassword } = require("./lib/email");
const {
  CATEGORY_OPTIONS,
  DRE_TYPE_OPTIONS,
  buildAvailableCategories,
  buildAvailableAccounts,
  buildAvailableMonths,
  buildDreReconciliation,
  buildFpaOverview,
  buildRequestedFpaReport,
  buildSuggestedDreAccounts,
  filterTransactions,
  normalizeMonthFilters,
  parseStatementFile,
} = require("./lib/fpa");
const {
  buildRecurrenceLabel,
  extractLovableCardPayload,
  shouldCreateLovableInvoice,
  validateWebhookSignature,
} = require("./lib/lovable-webhook");
const { createWhatsAppService } = require("./lib/whatsapp");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const STATIC_DIR = path.join(__dirname, "static");
const ROOT_INDEX = path.join(STATIC_DIR, "index.html");
const FPA_INDEX = path.join(STATIC_DIR, "fpa.html");
const APP_MODE = String(process.env.APP_MODE || "").trim().toLowerCase();
const IS_FPA_APP = APP_MODE === "fpa";
const DISABLE_WHATSAPP_INIT =
  IS_FPA_APP || ["1", "true", "yes"].includes(String(process.env.DISABLE_WHATSAPP_INIT || "").trim().toLowerCase());
const LOVABLE_WEBHOOK_SECRET = String(process.env.LOVABLE_WEBHOOK_SECRET || "").trim();

let batchSendState = createIdleBatchSendState();

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function readLimit(raw, fallback = 50) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), 200);
}

function readLargeLimit(raw, fallback = 120) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), 5000);
}

function readFpaMonths(rawValue) {
  if (Array.isArray(rawValue)) {
    return normalizeMonthFilters(
      rawValue.flatMap((value) => String(value || "").split(",").map((item) => item.trim()))
    );
  }
  return normalizeMonthFilters(String(rawValue || "").split(",").map((item) => item.trim()));
}

function readFpaAccountName(rawValue) {
  return truncateText(rawValue, 120) || null;
}

function parseCurrencyToCents(rawValue) {
  const raw = String(rawValue ?? "")
    .trim()
    .replace(/[^\d,.-]+/g, "");

  if (!raw) return null;

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  let normalized = raw;

  if (hasComma) {
    normalized = raw.replace(/\./g, "").replace(",", ".");
  } else if (hasDot) {
    const parts = raw.split(".");
    normalized = parts.at(-1)?.length === 2 ? raw : raw.replace(/\./g, "");
  }

  const valueNumber = Number(normalized);
  if (!Number.isFinite(valueNumber) || valueNumber <= 0) return null;
  return Math.round(valueNumber * 100);
}

function normalizeLookupKey(value) {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function createIdleBatchSendState() {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    lastUpdatedAt: null,
    delayMs: DEFAULT_BATCH_SEND_DELAY_MS,
    total: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    currentInvoiceId: null,
    currentClientId: null,
    currentClientName: null,
    waitingUntil: null,
    errorMessage: null,
    results: [],
  };
}

function getBatchSendState() {
  return batchSendState;
}

function patchBatchSendState(patch) {
  batchSendState = {
    ...batchSendState,
    ...patch,
    lastUpdatedAt: nowIso(),
  };
  return batchSendState;
}

function normalizeTemplatePayload(body) {
  const payload = {};
  if (body && Object.prototype.hasOwnProperty.call(body, "name")) {
    payload.name = truncateText(body?.name, 120);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, "category")) {
    payload.category = truncateText(body?.category, 40) || "Cobrança";
  }
  if (body && Object.prototype.hasOwnProperty.call(body, "body")) {
    payload.body = truncateText(body?.body, 4000);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, "sendAttachment")) {
    payload.sendAttachment = body?.sendAttachment === true;
  }
  if (body && Object.prototype.hasOwnProperty.call(body, "ruleOffsetDays")) {
    payload.ruleOffsetDays = normalizeRuleOffsetDays(body?.ruleOffsetDays);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, "isActive")) {
    payload.isActive = body?.isActive === true;
  }
  return payload;
}

function findTemplateByName(templates, templateName) {
  const lookupKey = normalizeLookupKey(templateName);
  if (!lookupKey) return null;

  return (
    (Array.isArray(templates) ? templates : []).find((template) => normalizeLookupKey(template?.name) === lookupKey) || null
  );
}

function sanitizeSettingsForClient(settings) {
  const safeSettings = settings && typeof settings === "object" ? settings : {};
  const gmail = safeSettings.gmail && typeof safeSettings.gmail === "object" ? safeSettings.gmail : {};

  return {
    ...safeSettings,
    gmail: {
      user: gmail.user || "",
      fromName: gmail.fromName || "V4 Cobranças",
      hasAppPassword: Boolean(gmail.appPassword),
      updatedAt: gmail.updatedAt || null,
    },
  };
}

async function resolveTemplateForInvoice(invoice, client) {
  const settings = await getSettings();
  const template =
    (invoice?.templateId && (await getTemplate(invoice.templateId))) ||
    (client?.defaultTemplateId && (await getTemplate(client.defaultTemplateId))) ||
    (settings.activeTemplateId && (await getTemplate(settings.activeTemplateId))) ||
    (await getActiveTemplate());

  return template;
}

function findTemplateById(templates, templateId) {
  return (Array.isArray(templates) ? templates : []).find((template) => template.id === templateId) || null;
}

function resolveFallbackTemplateForInvoice(invoice, client, templates) {
  return (
    findTemplateById(templates, invoice?.templateId) ||
    findTemplateById(templates, client?.defaultTemplateId) ||
    (Array.isArray(templates) ? templates.find((template) => template.isActive) : null) ||
    (Array.isArray(templates) ? templates[0] : null) ||
    null
  );
}

function getInvoiceAttachments(invoice) {
  if (Array.isArray(invoice?.attachments) && invoice.attachments.length) {
    return invoice.attachments.filter((attachment) => attachment?.filename);
  }
  if (invoice?.attachment?.filename) {
    return [invoice.attachment];
  }
  return [];
}

function normalizeStoredUpload(file, { kind = null, label = null } = {}) {
  if (!file?.filename) return null;
  return {
    filename: file.filename,
    originalName: file.originalname,
    kind,
    label: label || file.originalname,
    mimeType: file.mimetype || null,
    size: Number(file.size ?? 0) || null,
  };
}

function dedupeAttachments(attachments) {
  const deduped = new Map();
  (Array.isArray(attachments) ? attachments : []).forEach((attachment) => {
    if (!attachment?.filename) return;
    if (!deduped.has(attachment.filename)) {
      deduped.set(attachment.filename, attachment);
    }
  });
  return Array.from(deduped.values());
}

function normalizeUploadCollection(files) {
  return Array.isArray(files) ? files : [];
}

function collectInvoiceUploads(files) {
  const safeFiles = files && typeof files === "object" ? files : {};
  const attachments = [
    ...normalizeUploadCollection(safeFiles.attachment).map((file) => normalizeStoredUpload(file)),
    ...normalizeUploadCollection(safeFiles.boleto).map((file) =>
      normalizeStoredUpload(file, { kind: "boleto", label: "Boleto" })
    ),
    ...normalizeUploadCollection(safeFiles.notaFiscal).map((file) =>
      normalizeStoredUpload(file, { kind: "nota_fiscal", label: "Nota Fiscal" })
    ),
    ...normalizeUploadCollection(safeFiles.attachments).map((file) => normalizeStoredUpload(file)),
  ].filter(Boolean);

  return dedupeAttachments(attachments);
}

function collectMessageUploads(files) {
  return dedupeAttachments(
    normalizeUploadCollection(files).map((file) => normalizeStoredUpload(file)).filter(Boolean)
  );
}

function buildLoggedMessageBody(text, attachments) {
  const trimmedText = String(text || "").trim();
  if (trimmedText) return trimmedText;
  const safeAttachments = Array.isArray(attachments) ? attachments.filter((attachment) => attachment?.filename) : [];
  if (!safeAttachments.length) return "";
  return safeAttachments.length === 1 ? "[Anexo enviado]" : "[Anexos enviados]";
}

async function buildInvoiceCommunicationContext(invoice, client, templates = null) {
  const availableTemplates = Array.isArray(templates) && templates.length ? templates : await listTemplates();
  const ruleState = computeInvoiceRuleState({ invoice, templates: availableTemplates });
  const fallbackTemplate = resolveFallbackTemplateForInvoice(invoice, client, availableTemplates);
  const ruleTemplate =
    findTemplateById(availableTemplates, ruleState.currentTemplateId) ||
    findTemplateById(availableTemplates, ruleState.nextTemplateId);
  const template = ruleTemplate || fallbackTemplate || (await resolveTemplateForInvoice(invoice, client));
  const renderedText = buildInvoiceMessage({ invoice, client, template });
  const attachments = template?.sendAttachment === false ? [] : getInvoiceAttachments(invoice);

  return {
    availableTemplates,
    ruleState,
    template,
    renderedText,
    attachments,
  };
}

function buildInvoiceView(invoice, clientsById, templates) {
  const client = clientsById.get(invoice.clientId) || null;
  const ruleState = computeInvoiceRuleState({ invoice, templates });
  const operationalStatus =
    ruleState.sendStatus == null ? invoice.status : mapRuleStatusToInvoiceStatus(ruleState.sendStatus, invoice.status);
  const fallbackTemplate = resolveFallbackTemplateForInvoice(invoice, client, templates);
  const activeTemplate =
    findTemplateById(templates, ruleState.currentTemplateId) ||
    findTemplateById(templates, ruleState.nextTemplateId) ||
    fallbackTemplate;
  const renderedText = activeTemplate && client ? buildInvoiceMessage({ invoice, client, template: activeTemplate }) : "";

  return {
    ...invoice,
    baseStatus: invoice.status,
    status: operationalStatus,
    billingRule: {
      enabled: ruleState.enabled,
      agingDays: ruleState.agingDays,
      agingLabel: ruleState.agingLabel,
      currentTemplateId: ruleState.currentTemplateId,
      currentTemplateName: ruleState.currentTemplateName,
      currentRuleOffsetDays: ruleState.currentRuleOffsetDays,
      currentRuleLabel: ruleState.currentRuleLabel,
      nextTemplateId: ruleState.nextTemplateId,
      nextTemplateName: ruleState.nextTemplateName,
      nextRuleOffsetDays: ruleState.nextRuleOffsetDays,
      nextRuleLabel: ruleState.nextRuleLabel,
      sendStatus: ruleState.sendStatus,
      readyToSend: ruleState.readyToSend,
      renderedFromRule: ruleState.renderedFromRule,
      hasPendingStage: ruleState.hasPendingStage,
      lastDispatch: ruleState.lastDispatch,
      previewText: renderedText,
    },
    resolvedTemplateId: activeTemplate?.id || null,
    resolvedTemplateName: activeTemplate?.name || null,
  };
}

function buildInvoiceViews({ invoices, clients, templates }) {
  const clientsById = new Map((Array.isArray(clients) ? clients : []).map((client) => [client.id, client]));
  return (Array.isArray(invoices) ? invoices : []).map((invoice) => buildInvoiceView(invoice, clientsById, templates));
}

function buildOperationalDashboard(rawStats, invoiceViews) {
  const views = Array.isArray(invoiceViews) ? invoiceViews : [];
  return {
    ...rawStats,
    invoicesCount: views.length,
    invoicesPendingCount: views.filter((invoice) => invoice.status === "pending").length,
    invoicesSendingCount: views.filter((invoice) => invoice.status === "sending").length,
    invoicesSentCount: views.filter((invoice) => invoice.status === "sent").length,
    invoicesFailedCount: views.filter((invoice) => invoice.status === "failed").length,
    invoicesScheduledCount: views.filter((invoice) => invoice.status === "scheduled").length,
    invoicesPaidCount: views.filter((invoice) => invoice.status === "paid").length,
    invoicesRuleEnabledCount: views.filter((invoice) => invoice.billingRule?.enabled).length,
  };
}

function buildInvoiceMessage({ invoice, client, template }) {
  const paymentContext = buildPaymentTemplateContext({
    paymentLink: invoice.paymentLink,
    attachments: getInvoiceAttachments(invoice),
  });

  return renderTemplate(template?.body, {
    valor: formatMoneyBRL(invoice.valueCents),
    nomeDoCliente: client.name,
    dataDePagamento: formatIsoDateToBR(invoice.dueDate),
    linkDoPagamento: paymentContext.linkDoPagamento,
    formaDePagamento: paymentContext.formaDePagamento,
    instrucoesDePagamento: paymentContext.instrucoesDePagamento,
    anexosDaCobranca: paymentContext.anexosDaCobranca,
  });
}

function buildInvoiceEmailSubject({ invoice, client }) {
  const dueDate = formatIsoDateToBR(invoice.dueDate);
  const amount = formatMoneyBRL(invoice.valueCents);
  const accountLabel = client.companyName || client.name;
  return `Cobranca ${accountLabel} - ${amount} - vence em ${dueDate}`;
}

function buildInvoiceEmailHtml({ invoice, client, renderedText }) {
  const escapedCompany = client.companyName ? truncateText(client.companyName, 160) : null;
  const invoiceAttachments = getInvoiceAttachments(invoice);
  const paymentLinkHtml = invoice.paymentLink
    ? `<p style="margin:18px 0"><a href="${invoice.paymentLink}" style="display:inline-block;padding:12px 18px;background:#df2e30;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:700">Abrir link de pagamento</a></p>`
    : "";
  const attachmentsHtml = invoiceAttachments.length
    ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.7">Anexos incluídos: <strong>${invoiceAttachments
        .map((attachment) => attachment.label || attachment.originalName || attachment.filename)
        .join(", ")}</strong></p>`
    : "";

  return `
    <div style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;color:#111111">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e6;padding:28px;border-radius:8px">
        <div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#df2e30;font-weight:700;margin-bottom:10px">Cobranca V4</div>
        <h1 style="margin:0 0 14px;font-size:24px;line-height:1.2">Olá ${client.name},</h1>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.7">
          Segue sua cobranca de <strong>${formatMoneyBRL(invoice.valueCents)}</strong> com vencimento em
          <strong>${formatIsoDateToBR(invoice.dueDate)}</strong>.
        </p>
        ${escapedCompany ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.7">Empresa: <strong>${escapedCompany}</strong></p>` : ""}
        ${attachmentsHtml}
        ${paymentLinkHtml}
        <div style="margin-top:22px;padding:18px;background:#faf7f7;border:1px solid #f0d1d1;border-radius:6px;white-space:pre-wrap;font-size:14px;line-height:1.8">${renderedText}</div>
      </div>
    </div>
  `.trim();
}

async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

async function executeInvoiceSend(invoiceId) {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) throw createHttpError(404, "Cobrança não encontrada.");
  if (invoice.status === "paid") throw createHttpError(400, "Esta cobrança já foi quitada e não pode ser enviada.");

  const client = await getClient(invoice.clientId);
  if (!client) throw createHttpError(400, "Cliente não encontrado.");

  const templates = await listTemplates();
  const { ruleState, template, renderedText, attachments } = await buildInvoiceCommunicationContext(
    invoice,
    client,
    templates
  );
  if (ruleState.enabled && !ruleState.currentTemplateId) {
    throw createHttpError(400, "Esta cobrança ainda não atingiu nenhuma etapa liberada da régua.");
  }

  const attempt = await markInvoiceSendAttempt(invoice.id, {
    templateId: template?.id || null,
    templateName: template?.name || null,
    ruleOffsetDays: ruleState.currentRuleOffsetDays,
    channel: "whatsapp",
    renderedBody: renderedText,
  });

  try {
    const sendResult = await wa.sendMessage({
      phone: client.phone,
      text: renderedText,
      attachments,
    });

    await Promise.all([
      markInvoiceSendResult(invoice.id, {
        ok: true,
        messageId: sendResult?.messageId ?? null,
        dispatchId: attempt?.dispatchId || null,
      }),
      addOutboundMessage({
        clientId: client.id,
        phone: client.phone,
        body: buildLoggedMessageBody(renderedText, attachments),
        invoiceId: invoice.id,
        status: "sent",
        externalId: sendResult?.messageId ?? null,
        timestampMs: Date.now(),
        attachments,
      }),
    ]);

    return {
      ok: true,
      invoiceId: invoice.id,
      clientId: client.id,
      clientName: client.name,
      status: "sent",
      messageId: sendResult?.messageId ?? null,
    };
  } catch (err) {
    const errorMessage = err?.message || "Falha ao enviar cobrança.";

    await Promise.all([
      markInvoiceSendResult(invoice.id, {
        ok: false,
        errorMessage,
        dispatchId: attempt?.dispatchId || null,
      }),
      addOutboundMessage({
        clientId: client.id,
        phone: client.phone,
        body: buildLoggedMessageBody(renderedText, attachments),
        invoiceId: invoice.id,
        status: "failed",
        errorMessage,
        timestampMs: Date.now(),
        attachments,
      }),
    ]);

    err.sendSummary = {
      ok: false,
      invoiceId: invoice.id,
      clientId: client.id,
      clientName: client.name,
      status: "failed",
      errorMessage,
    };
    throw err;
  }
}

async function runInvoiceBatch({ invoices, delayMs }) {
  try {
    for (let index = 0; index < invoices.length; index += 1) {
      const invoice = invoices[index];
      const client = await getClient(invoice.clientId);
      patchBatchSendState({
        currentInvoiceId: invoice.id,
        currentClientId: invoice.clientId,
        currentClientName: client?.name || null,
        waitingUntil: null,
        errorMessage: null,
      });

      try {
        const result = await executeInvoiceSend(invoice.id);
        patchBatchSendState({
          attempted: batchSendState.attempted + 1,
          sent: batchSendState.sent + 1,
          results: batchSendState.results.concat(result).slice(-100),
        });
      } catch (err) {
        const result = err?.sendSummary || {
          ok: false,
          invoiceId: invoice.id,
          clientId: invoice.clientId,
          clientName: client?.name || null,
          status: "failed",
          errorMessage: err?.message || "Falha ao enviar cobrança.",
        };
        patchBatchSendState({
          attempted: batchSendState.attempted + 1,
          failed: batchSendState.failed + 1,
          errorMessage: result.errorMessage,
          results: batchSendState.results.concat(result).slice(-100),
        });
      }

      if (index < invoices.length - 1) {
        patchBatchSendState({
          waitingUntil: new Date(Date.now() + delayMs).toISOString(),
        });
        await sleep(delayMs);
      }
    }

    patchBatchSendState({
      status: batchSendState.failed ? "completed_with_errors" : "completed",
      finishedAt: nowIso(),
      currentInvoiceId: null,
      currentClientId: null,
      currentClientName: null,
      waitingUntil: null,
    });
  } catch (err) {
    patchBatchSendState({
      status: "failed",
      finishedAt: nowIso(),
      currentInvoiceId: null,
      currentClientId: null,
      currentClientName: null,
      waitingUntil: null,
      errorMessage: err?.message || "Falha ao processar envio em massa.",
    });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await ensureUploadsDir();
        cb(null, UPLOADS_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const safeBase = String(file.originalname || "boleto").replace(/[^\w.\-]+/g, "_");
      cb(null, `${Date.now()}_${safeBase}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const acceptedTypes = new Set([
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/xml",
      "text/xml",
      "application/octet-stream",
    ]);
    if (!file.mimetype || acceptedTypes.has(file.mimetype)) return cb(null, true);
    cb(createHttpError(400, "Anexo inválido. Envie PDF, PNG, JPG, DOC, DOCX ou XML."));
  },
});

const invoiceUpload = upload.fields([
  { name: "attachment", maxCount: 1 },
  { name: "boleto", maxCount: 1 },
  { name: "notaFiscal", maxCount: 1 },
  { name: "attachments", maxCount: 8 },
]);
const messageUpload = upload.array("attachments", 8);
const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const lowerName = String(file.originalname || "").toLowerCase();
    const safeMimeType = String(file.mimetype || "").toLowerCase();
    const allowed =
      lowerName.endsWith(".csv") ||
      lowerName.endsWith(".ofx") ||
      lowerName.endsWith(".txt") ||
      safeMimeType.includes("csv") ||
      safeMimeType.includes("plain") ||
      safeMimeType.includes("ofx") ||
      safeMimeType === "application/octet-stream";

    if (allowed) return cb(null, true);
    cb(createHttpError(400, "Extrato inválido. Envie um arquivo CSV ou OFX."));
  },
}).single("statement");
const clientImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const lowerName = String(file.originalname || "").toLowerCase();
    const safeMimeType = String(file.mimetype || "").toLowerCase();
    const allowed =
      lowerName.endsWith(".xlsx") ||
      lowerName.endsWith(".xls") ||
      lowerName.endsWith(".csv") ||
      safeMimeType.includes("sheet") ||
      safeMimeType.includes("excel") ||
      safeMimeType.includes("csv") ||
      safeMimeType === "application/octet-stream";

    if (allowed) return cb(null, true);
    cb(createHttpError(400, "Planilha inválida. Envie um arquivo XLSX, XLS ou CSV."));
  },
}).single("file");

const app = express();
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  })
);
app.use(express.urlencoded({ extended: true }));
const adminAuthMiddleware = createBasicAuthMiddleware({
  ...getAdminCredentialsFromEnv(),
  realm: "V4 Cobrancas",
});

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/static", express.static(STATIC_DIR));

app.get("/healthz", (req, res) => {
  res.json({ ok: true, service: "bot-cobranca" });
});

const wa = createWhatsAppService({
  uploadsDir: UPLOADS_DIR,
  onInboundMessage: async ({ externalId, fromPhone, body, timestampMs, fromId, messageType }) => {
    await addInboundMessage({ externalId, fromPhone, body, timestampMs, fromId, messageType });
  },
});
const email = createEmailService({ uploadsDir: UPLOADS_DIR });

app.post(
  "/api/integrations/lovable/wallet-items",
  asyncHandler(async (req, res) => {
    if (!LOVABLE_WEBHOOK_SECRET) {
      throw createHttpError(503, "LOVABLE_WEBHOOK_SECRET não configurado no bot.");
    }

    const signature =
      req.headers["x-lovable-signature"] ||
      req.headers["x-signature"] ||
      req.headers["x-webhook-signature"] ||
      "";
    const signatureValidation = validateWebhookSignature({
      secret: LOVABLE_WEBHOOK_SECRET,
      rawBody: req.rawBody || Buffer.from(JSON.stringify(req.body || {})),
      signature,
    });

    if (!signatureValidation.ok) {
      throw createHttpError(401, "Assinatura inválida para integração Lovable.");
    }

    const card = extractLovableCardPayload(req.body);
    const eligibility = shouldCreateLovableInvoice(card);
    if (!eligibility.ok) {
      return res.status(202).json({
        ok: true,
        ignored: true,
        reason: eligibility.reason,
        cardId: card.cardId || null,
      });
    }

    const templates = await listTemplates();
    const resolvedTemplate = card.templateName ? findTemplateByName(templates, card.templateName) : null;
    const recurrence = buildRecurrenceLabel({
      isInstallment: card.isInstallment,
      installmentCount: card.installmentCount,
    });
    const paymentLink = normalizePaymentLink(card.paymentLink);

    let client = await findClientByPhone(card.phone);
    if (!client) {
      client = await createClient({
        name: card.clientName,
        phone: card.phone,
        companyName: card.companyName && card.companyName !== card.clientName ? card.companyName : null,
        email: card.email,
        notes: card.notes,
        defaultTemplateId: resolvedTemplate?.id || null,
      });
    } else {
      const clientPatch = {};
      if (!client.companyName && card.companyName && card.companyName !== client.name) clientPatch.companyName = card.companyName;
      if (!client.email && card.email) clientPatch.email = card.email;
      if (!client.notes && card.notes) clientPatch.notes = card.notes;
      if (!client.defaultTemplateId && resolvedTemplate?.id) clientPatch.defaultTemplateId = resolvedTemplate.id;
      if (Object.keys(clientPatch).length) {
        client = await updateClient(client.id, clientPatch);
      }
    }

    const integrationPatch = {
      source: "lovable",
      externalId: card.cardId,
      event: card.event,
      externalStatus: card.status,
      paymentMethod: card.paymentMethod,
      lastSyncedAt: nowIso(),
      metadata: {
        timestamp: card.timestamp,
        assignedTo: card.assignedTo,
        sellerName: card.sellerName,
        isInstallment: card.isInstallment,
        installmentCount: card.installmentCount,
      },
    };

    const existingInvoice = await findInvoiceByIntegration("lovable", card.cardId);
    if (existingInvoice) {
      const updatedInvoice = await updateInvoice(existingInvoice.id, {
        clientId: client.id,
        valueCents: card.valueCents,
        dueDate: card.dueDate,
        paymentLink,
        recurrence,
        templateId: resolvedTemplate?.id || existingInvoice.templateId || null,
        integration: integrationPatch,
      });

      return res.json({
        ok: true,
        created: false,
        updated: true,
        clientId: client.id,
        invoiceId: updatedInvoice.id,
        cardId: card.cardId,
      });
    }

    const createdInvoice = await createInvoice({
      clientId: client.id,
      valueCents: card.valueCents,
      dueDate: card.dueDate,
      paymentLink,
      recurrence,
      templateId: resolvedTemplate?.id || null,
      attachment: null,
      attachments: [],
      integration: integrationPatch,
    });

    res.status(201).json({
      ok: true,
      created: true,
      updated: false,
      clientId: client.id,
      invoiceId: createdInvoice.id,
      cardId: card.cardId,
    });
  })
);

app.use(adminAuthMiddleware);

app.get("/", (req, res) => {
  res.sendFile(IS_FPA_APP ? FPA_INDEX : ROOT_INDEX);
});

app.get("/cobrancas", (req, res) => {
  res.sendFile(ROOT_INDEX);
});

app.get("/fpa", (req, res) => {
  res.sendFile(FPA_INDEX);
});

app.get(
  "/api/bootstrap",
  asyncHandler(async (req, res) => {
    const [dashboard, rawSettings, templates, clients, invoices, messages, whatsapp] = await Promise.all([
      getDashboardStats(),
      getSettings(),
      listTemplates(),
      listClients(),
      listInvoices(),
      listMessages({ limit: 200 }),
      wa.getStatus(),
    ]);
    const emailStatus = email.getStatus(rawSettings.gmail);
    const invoiceViews = buildInvoiceViews({ invoices, clients, templates });

    res.json({
      dashboard: { ...buildOperationalDashboard(dashboard, invoiceViews), whatsapp, email: emailStatus },
      settings: sanitizeSettingsForClient(rawSettings),
      templates,
      clients,
      invoices: invoiceViews,
      messages,
      batchSend: getBatchSendState(),
    });
  })
);

app.get(
  "/api/dashboard",
  asyncHandler(async (req, res) => {
    const [stats, waStatus, settings, clients, templates, invoices] = await Promise.all([
      getDashboardStats(),
      wa.getStatus(),
      getSettings(),
      listClients(),
      listTemplates(),
      listInvoices(),
    ]);
    const emailStatus = email.getStatus(settings.gmail);
    const invoiceViews = buildInvoiceViews({ invoices, clients, templates });
    res.json({
      ...buildOperationalDashboard(stats, invoiceViews),
      whatsapp: waStatus,
      email: emailStatus,
      batchSend: getBatchSendState(),
    });
  })
);

app.get(
  "/api/fpa/bootstrap",
  asyncHandler(async (req, res) => {
    const from = String(req.query?.from || "").trim() || null;
    const to = String(req.query?.to || "").trim() || null;
    const prompt = String(req.query?.prompt || "visão geral de caixa").trim();
    const months = readFpaMonths(req.query?.months);
    const accountName = readFpaAccountName(req.query?.accountName);
    const [imports, allTransactions, dreAccounts] = await Promise.all([
      listFpaImports(),
      listFpaTransactions({ limit: 5000 }),
      listFpaDreAccounts(),
    ]);
    const recentTransactions = filterTransactions(allTransactions, { from, to, months, accountName }).slice(
      0,
      readLargeLimit(req.query?.limit, 120)
    );
    const availableCategories = buildAvailableCategories(allTransactions, dreAccounts);
    const overview = buildFpaOverview(allTransactions, { from, to, months, accountName });
    const report = buildRequestedFpaReport({
      transactions: allTransactions,
      prompt,
      from,
      to,
      months,
      accountName,
      dreAccounts,
    });

    res.json({
      categories: availableCategories.length ? availableCategories : CATEGORY_OPTIONS,
      imports: imports.slice(0, 30),
      availableAccounts: buildAvailableAccounts(allTransactions),
      availableMonths: buildAvailableMonths(allTransactions),
      dreTypeOptions: DRE_TYPE_OPTIONS,
      dreAccounts,
      dreReconciliation: buildDreReconciliation({
        dreAccounts,
        categories: availableCategories,
        transactions: allTransactions,
      }),
      dreSuggestions: buildSuggestedDreAccounts(availableCategories),
      overview,
      report,
      transactions: recentTransactions,
    });
  })
);

app.get(
  "/api/fpa/imports",
  asyncHandler(async (req, res) => {
    res.json(await listFpaImports());
  })
);

app.get(
  "/api/fpa/transactions",
  asyncHandler(async (req, res) => {
    const from = String(req.query?.from || "").trim() || null;
    const to = String(req.query?.to || "").trim() || null;
    const months = readFpaMonths(req.query?.months);
    const accountName = readFpaAccountName(req.query?.accountName);
    const transactions = await listFpaTransactions({ limit: 5000 });
    res.json(filterTransactions(transactions, { from, to, months, accountName }).slice(0, readLargeLimit(req.query?.limit, 200)));
  })
);

app.post(
  "/api/fpa/imports",
  statementUpload,
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer?.length) {
      throw createHttpError(400, "Anexe um arquivo de extrato para importar.");
    }

    const accountName = truncateText(req.body?.accountName, 120) || null;
    const parsedStatement = parseStatementFile({
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      accountName,
    });

    const createdImport = await createFpaImport({
      sourceType: parsedStatement.sourceType,
      originalFilename: parsedStatement.originalFilename,
      accountName: parsedStatement.accountName,
      transactions: parsedStatement.transactions,
    });

    const allTransactions = await listFpaTransactions({ limit: 5000 });
    res.status(201).json({
      ok: true,
      import: createdImport.importRecord,
      importedCount: createdImport.importedTransactions.length,
      duplicateCount: createdImport.duplicateCount,
      overview: buildFpaOverview(allTransactions),
    });
  })
);

app.post(
  "/api/fpa/report",
  asyncHandler(async (req, res) => {
    const prompt = truncateText(req.body?.prompt, 280) || "visão geral de caixa";
    const from = String(req.body?.from || "").trim() || null;
    const to = String(req.body?.to || "").trim() || null;
    const months = readFpaMonths(req.body?.months);
    const accountName = readFpaAccountName(req.body?.accountName);
    const [transactions, dreAccounts] = await Promise.all([
      listFpaTransactions({ limit: 5000 }),
      listFpaDreAccounts(),
    ]);
    res.json(buildRequestedFpaReport({ transactions, prompt, from, to, months, accountName, dreAccounts }));
  })
);

app.get(
  "/api/fpa/dre-accounts",
  asyncHandler(async (req, res) => {
    const [dreAccounts, transactions] = await Promise.all([
      listFpaDreAccounts(),
      listFpaTransactions({ limit: 5000 }),
    ]);
    const availableCategories = buildAvailableCategories(transactions, dreAccounts);
    res.json({
      typeOptions: DRE_TYPE_OPTIONS,
      categories: availableCategories,
      accounts: dreAccounts,
      reconciliation: buildDreReconciliation({
        dreAccounts,
        categories: availableCategories,
        transactions,
      }),
      suggestions: buildSuggestedDreAccounts(availableCategories),
    });
  })
);

app.post(
  "/api/fpa/dre-accounts",
  asyncHandler(async (req, res) => {
    const created = await createFpaDreAccount({
      name: truncateText(req.body?.name, 120),
      type: req.body?.type,
      categories: Array.isArray(req.body?.categories) ? req.body.categories : [],
      orderIndex: req.body?.orderIndex,
      notes: truncateText(req.body?.notes, 2000),
    });
    res.status(201).json(created);
  })
);

app.post(
  "/api/fpa/dre-accounts/seed",
  asyncHandler(async (req, res) => {
    const transactions = await listFpaTransactions({ limit: 5000 });
    const categories = buildAvailableCategories(transactions, []);
    const seeded = await seedFpaDreAccounts(buildSuggestedDreAccounts(categories));
    res.status(201).json({
      ok: true,
      createdCount: seeded.length,
      accounts: seeded,
    });
  })
);

app.put(
  "/api/fpa/dre-accounts/:id",
  asyncHandler(async (req, res) => {
    const updated = await updateFpaDreAccount(req.params.id, {
      name: truncateText(req.body?.name, 120),
      type: req.body?.type,
      categories: Array.isArray(req.body?.categories) ? req.body.categories : [],
      orderIndex: req.body?.orderIndex,
      notes: truncateText(req.body?.notes, 2000),
    });
    if (!updated) throw createHttpError(404, "Conta DRE não encontrada.");
    res.json(updated);
  })
);

app.delete(
  "/api/fpa/dre-accounts/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteFpaDreAccount(req.params.id);
    if (!deleted) throw createHttpError(404, "Conta DRE não encontrada.");
    res.json({ ok: true, deleted });
  })
);

app.delete(
  "/api/fpa/accounts",
  asyncHandler(async (req, res) => {
    const accountName = readFpaAccountName(req.body?.accountName || req.query?.accountName);
    if (!accountName) {
      throw createHttpError(400, "Informe a conta que deve ser excluída.");
    }

    const deleted = await deleteFpaAccount(accountName);
    if (!deleted) {
      throw createHttpError(404, "Conta financeira não encontrada.");
    }

    const allTransactions = await listFpaTransactions({ limit: 5000 });
    res.json({
      ok: true,
      ...deleted,
      overview: buildFpaOverview(allTransactions),
    });
  })
);

app.put(
  "/api/fpa/transactions/batch",
  asyncHandler(async (req, res) => {
    const updates = Array.isArray(req.body?.updates)
      ? req.body.updates.map((entry) => ({
          id: String(entry?.id || "").trim(),
          category: entry?.category,
          subcategory: entry?.subcategory,
          reportSection: entry?.reportSection,
          notes: entry?.notes,
          isInternalTransfer: entry?.isInternalTransfer === true,
        }))
      : [];

    if (!updates.length) {
      throw createHttpError(400, "Informe pelo menos uma alteração para o salvamento em massa.");
    }

    const updated = await updateFpaTransactionsBatch(updates);
    res.json({
      ok: true,
      updatedCount: updated.length,
      updated,
    });
  })
);

app.put(
  "/api/fpa/transactions/:id",
  asyncHandler(async (req, res) => {
    const updated = await updateFpaTransaction(req.params.id, {
      category: req.body?.category,
      subcategory: req.body?.subcategory,
      reportSection: req.body?.reportSection,
      notes: req.body?.notes,
      isInternalTransfer: req.body?.isInternalTransfer === true,
    });

    if (!updated) throw createHttpError(404, "Lançamento financeiro não encontrado.");
    res.json(updated);
  })
);

app.delete(
  "/api/fpa/transactions/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteFpaTransaction(req.params.id);
    if (!deleted) throw createHttpError(404, "Lançamento financeiro não encontrado.");

    const allTransactions = await listFpaTransactions({ limit: 5000 });
    res.json({
      ok: true,
      ...deleted,
      overview: buildFpaOverview(allTransactions),
    });
  })
);

app.get(
  "/api/email/status",
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    res.json(email.getStatus(settings.gmail));
  })
);

app.get(
  "/api/whatsapp/status",
  asyncHandler(async (req, res) => {
    res.json(await wa.getStatus());
  })
);

app.get(
  "/api/whatsapp/qr",
  asyncHandler(async (req, res) => {
    res.json({ dataUrl: await wa.getQrDataUrl() });
  })
);

app.post(
  "/api/whatsapp/logout",
  asyncHandler(async (req, res) => {
    await wa.logout();
    res.json({ ok: true });
  })
);

app.get(
  "/api/settings",
  asyncHandler(async (req, res) => {
    res.json(sanitizeSettingsForClient(await getSettings()));
  })
);

app.post(
  "/api/settings",
  asyncHandler(async (req, res) => {
    const patch = {};
    const currentSettings = await getSettings();
    if ("messageTemplate" in (req.body || {})) {
      patch.messageTemplate = truncateText(req.body?.messageTemplate, 4000);
      if (!patch.messageTemplate) throw createHttpError(400, "messageTemplate inválido.");
    }
    if ("activeTemplateId" in (req.body || {})) {
      patch.activeTemplateId = String(req.body?.activeTemplateId || "").trim();
      if (!patch.activeTemplateId) throw createHttpError(400, "activeTemplateId inválido.");
    }
    if (req.body?.gmail && typeof req.body.gmail === "object") {
      patch.gmail = {
        user: req.body.gmail.user,
        fromName: req.body.gmail.fromName,
      };
      if ("appPassword" in req.body.gmail) {
        patch.gmail.appPassword = req.body.gmail.appPassword;
      }

      const nextGmail = {
        user: String(req.body.gmail.user ?? currentSettings.gmail?.user ?? "").trim(),
        fromName: String(req.body.gmail.fromName ?? currentSettings.gmail?.fromName ?? "V4 Cobranças").trim(),
        appPassword: "",
      };

      if ("appPassword" in req.body.gmail) {
        const nextPassword = normalizeAppPassword(req.body.gmail.appPassword);
        nextGmail.appPassword = nextPassword || String(currentSettings.gmail?.appPassword || "");
      } else {
        nextGmail.appPassword = String(currentSettings.gmail?.appPassword || "");
      }

      const touchedCredentials = "user" in req.body.gmail || "appPassword" in req.body.gmail;
      if (touchedCredentials) {
        if (!nextGmail.user) {
          throw createHttpError(400, "Informe a conta Gmail antes de salvar.");
        }
        if (!nextGmail.appPassword) {
          throw createHttpError(400, "Informe a senha do Gmail para validar a conexão.");
        }
        try {
          const verifiedConnection = await email.verifyConnection(nextGmail);
          patch.gmail.appPassword = verifiedConnection.appPassword;
          patch.gmail.verifiedAt = nowIso();
        } catch (error) {
          throw createHttpError(
            400,
            `Não foi possível autenticar no Gmail. Confira a conta e a senha informada e tente novamente. ${String(
              error?.message || ""
            ).trim()}`
          );
        }
      }
    }
    const settings = await updateSettings(patch);
    res.json(sanitizeSettingsForClient(settings));
  })
);

app.get(
  "/api/templates",
  asyncHandler(async (req, res) => {
    res.json(await listTemplates());
  })
);

app.post(
  "/api/templates",
  asyncHandler(async (req, res) => {
    const payload = {
      category: "Cobrança",
      sendAttachment: false,
      ruleOffsetDays: null,
      ...normalizeTemplatePayload(req.body),
    };
    if (!payload.name) throw createHttpError(400, "Nome do template é obrigatório.");
    if (!payload.body) throw createHttpError(400, "Corpo do template é obrigatório.");
    if (payload.isActive && Number.isInteger(payload.ruleOffsetDays)) {
      throw createHttpError(400, "Templates da régua não podem ser definidos como padrão manual.");
    }
    try {
      const template = await createTemplate(payload);
      if (payload.isActive) {
        await updateSettings({ activeTemplateId: template.id });
      }
      res.status(201).json(template);
    } catch (err) {
      if (String(err?.message || "").includes("Já existe um template configurado")) {
        throw createHttpError(409, err.message);
      }
      throw err;
    }
  })
);

app.put(
  "/api/templates/:id",
  asyncHandler(async (req, res) => {
    const payload = normalizeTemplatePayload(req.body);
    try {
      const currentTemplate = await getTemplate(req.params.id);
      if (!currentTemplate) throw createHttpError(404, "Template não encontrado.");
      const nextRuleOffsetDays =
        "ruleOffsetDays" in payload ? payload.ruleOffsetDays : currentTemplate.ruleOffsetDays ?? null;
      if (payload.isActive && Number.isInteger(nextRuleOffsetDays)) {
        throw createHttpError(400, "Templates da régua não podem ser definidos como padrão manual.");
      }
      const updated = await updateTemplate(req.params.id, payload);
      res.json(updated);
    } catch (err) {
      if (String(err?.message || "").includes("Já existe um template configurado")) {
        throw createHttpError(409, err.message);
      }
      throw err;
    }
  })
);

app.delete(
  "/api/templates/:id",
  asyncHandler(async (req, res) => {
    try {
      const deleted = await deleteTemplate(req.params.id);
      if (!deleted) throw createHttpError(404, "Template não encontrado.");
      res.json({ ok: true });
    } catch (err) {
      if (String(err?.message || "").includes("manter pelo menos um template")) {
        throw createHttpError(400, err.message);
      }
      throw err;
    }
  })
);

app.get(
  "/api/clients",
  asyncHandler(async (req, res) => {
    res.json(await listClients());
  })
);

app.get(
  "/api/clients/import-template",
  asyncHandler(async (req, res) => {
    const buffer = createClientImportTemplateBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${CLIENT_IMPORT_TEMPLATE_FILENAME}"`);
    res.send(buffer);
  })
);

app.post(
  "/api/clients/import",
  clientImportUpload,
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer?.length) {
      throw createHttpError(400, "Selecione uma planilha para importar.");
    }

    const rows = parseClientImportBuffer({
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
    });

    if (!rows.length) {
      throw createHttpError(400, "A planilha está vazia ou não contém linhas válidas para importação.");
    }

    const templates = await listTemplates();
    const summary = {
      totalRows: rows.length,
      processedRows: 0,
      createdClients: 0,
      createdInvoices: 0,
      failedRows: 0,
      errors: [],
    };

    for (const row of rows) {
      let createdClient = null;

      try {
        const name = normalizeName(row.name);
        const phone = onlyDigits(row.phone);
        const rawPaymentLink = String(row.paymentLink || "").trim();
        const paymentLink = normalizePaymentLink(rawPaymentLink);
        const resolvedTemplate = row.templateName ? findTemplateByName(templates, row.templateName) : null;

        if (!name) throw new Error("Nome do cliente é obrigatório.");
        if (!phone) throw new Error("Telefone do cliente é obrigatório.");
        if (!isPossiblePhone(phone)) {
          throw new Error("Telefone inválido. Use DDI + DDD + número.");
        }
        if (rawPaymentLink && !paymentLink) {
          throw new Error("Link de pagamento inválido.");
        }
        if (row.templateName && !resolvedTemplate) {
          throw new Error(`Template "${row.templateName}" não encontrado.`);
        }
        if (row.createInvoice) {
          if (!row.valueCents) throw new Error("Valor da cobrança é obrigatório para criar a cobrança.");
          if (!row.dueDate || !isIsoDate(row.dueDate)) {
            throw new Error("Vencimento inválido. Use AAAA-MM-DD ou uma data válida no Excel.");
          }
        }

        createdClient = await createClient({
          name,
          phone,
          companyName: row.companyName,
          email: row.email,
          notes: row.notes,
          defaultTemplateId: resolvedTemplate?.id || null,
        });
        summary.createdClients += 1;

        if (row.createInvoice) {
          await createInvoice({
            clientId: createdClient.id,
            valueCents: row.valueCents,
            dueDate: row.dueDate,
            paymentLink,
            recurrence: row.recurrence || "Único",
            templateId: resolvedTemplate?.id || null,
            attachment: null,
            attachments: [],
          });
          summary.createdInvoices += 1;
        }

        summary.processedRows += 1;
      } catch (error) {
        if (createdClient && row.createInvoice) {
          await deleteClient(createdClient.id).catch(() => null);
        }
        summary.failedRows += 1;
        summary.errors.push({
          rowNumber: row.rowNumber,
          clientName: row.name || null,
          phone: row.phone || null,
          error: error?.message || "Falha ao importar linha.",
        });
      }
    }

    res.status(summary.failedRows ? 207 : 201).json({
      ok: summary.failedRows === 0,
      ...summary,
    });
  })
);

app.get(
  "/api/clients/:id",
  asyncHandler(async (req, res) => {
    const client = await getClient(req.params.id);
    if (!client) throw createHttpError(404, "Cliente não encontrado.");
    res.json(client);
  })
);

app.post(
  "/api/clients",
  asyncHandler(async (req, res) => {
    const name = normalizeName(req.body?.name);
    const phone = onlyDigits(req.body?.phone);

    if (!name) throw createHttpError(400, "Nome obrigatório.");
    if (!phone) throw createHttpError(400, "Telefone obrigatório.");
    if (!isPossiblePhone(phone)) {
      throw createHttpError(400, "Telefone inválido. Use DDD+Número ou DDI+DDD+Número.");
    }

    try {
      const client = await createClient({
        name,
        phone,
        companyName: req.body?.companyName,
        email: req.body?.email,
        notes: req.body?.notes,
        defaultTemplateId: req.body?.defaultTemplateId || null,
      });
      res.status(201).json(client);
    } catch (err) {
      if (String(err?.message || "").includes("Já existe um cliente")) {
        throw createHttpError(409, err.message);
      }
      if (String(err?.message || "").includes("Template padrão")) {
        throw createHttpError(400, err.message);
      }
      throw err;
    }
  })
);

app.put(
  "/api/clients/:id",
  asyncHandler(async (req, res) => {
    try {
      const updated = await updateClient(req.params.id, {
        name: req.body?.name,
        phone: req.body?.phone,
        companyName: req.body?.companyName,
        email: req.body?.email,
        notes: req.body?.notes,
        defaultTemplateId: req.body?.defaultTemplateId,
      });
      if (!updated) throw createHttpError(404, "Cliente não encontrado.");
      res.json(updated);
    } catch (err) {
      if (String(err?.message || "").includes("Já existe um cliente")) {
        throw createHttpError(409, err.message);
      }
      if (String(err?.message || "").includes("Template padrão")) {
        throw createHttpError(400, err.message);
      }
      throw err;
    }
  })
);

app.delete(
  "/api/clients/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteClient(req.params.id);
    if (!deleted) throw createHttpError(404, "Cliente não encontrado.");
    res.json({ ok: true });
  })
);

app.get(
  "/api/messages",
  asyncHandler(async (req, res) => {
    res.json(await listMessages({ limit: readLimit(req.query?.limit, 50) }));
  })
);

app.post(
  "/api/messages/:id/link",
  asyncHandler(async (req, res) => {
    const clientId = String(req.body?.clientId || "").trim();
    if (!clientId) throw createHttpError(400, "clientId obrigatório.");
    const linked = await linkMessageToClient(req.params.id, clientId);
    if (!linked) throw createHttpError(404, "Mensagem ou cliente não encontrado.");
    res.json({ ok: true });
  })
);

app.delete(
  "/api/messages/conversation/:phone",
  asyncHandler(async (req, res) => {
    const phone = onlyDigits(req.params.phone);
    if (!phone) throw createHttpError(400, "Telefone inválido.");

    const deletedCount = await deleteMessagesByPhone(phone, { onlyUnmatched: true });
    res.json({ ok: true, deletedCount });
  })
);

app.delete(
  "/api/messages/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteMessage(req.params.id, { onlyUnmatched: true });
    if (!deleted) throw createHttpError(404, "Mensagem sem vínculo não encontrada.");
    res.json({ ok: true });
  })
);

app.post(
  "/api/reply",
  messageUpload,
  asyncHandler(async (req, res) => {
    const phone = onlyDigits(req.body?.phone);
    const text = truncateText(req.body?.text, 4000);
    const attachments = collectMessageUploads(req.files);

    if (!phone) throw createHttpError(400, "Telefone obrigatório.");
    if (!text && !attachments.length) throw createHttpError(400, "Informe uma mensagem ou anexe pelo menos um arquivo.");

    try {
      const sendResult = await wa.sendMessage({ phone, text, attachments });
      await addOutboundMessage({
        phone,
        body: buildLoggedMessageBody(text, attachments),
        status: "sent",
        externalId: sendResult?.messageId ?? null,
        timestampMs: Date.now(),
        attachments,
      });

      res.json({ ok: true });
    } catch (error) {
      await addOutboundMessage({
        phone,
        body: buildLoggedMessageBody(text, attachments),
        status: "failed",
        errorMessage: error?.message || "Falha ao enviar mensagem.",
        timestampMs: Date.now(),
        attachments,
      });
      throw error;
    }
  })
);

app.get(
  "/api/clients/:id/messages",
  asyncHandler(async (req, res) => {
    res.json(await listClientMessages(req.params.id, { limit: readLimit(req.query?.limit, 50) }));
  })
);

app.post(
  "/api/clients/:id/reply",
  messageUpload,
  asyncHandler(async (req, res) => {
    const client = await getClient(req.params.id);
    if (!client) throw createHttpError(404, "Cliente não encontrado.");

    const text = truncateText(req.body?.text, 4000);
    const attachments = collectMessageUploads(req.files);
    if (!text && !attachments.length) {
      throw createHttpError(400, "Informe uma mensagem ou anexe pelo menos um arquivo.");
    }

    try {
      const sendResult = await wa.sendMessage({ phone: client.phone, text, attachments });
      await addOutboundMessage({
        clientId: client.id,
        phone: client.phone,
        body: buildLoggedMessageBody(text, attachments),
        status: "sent",
        externalId: sendResult?.messageId ?? null,
        timestampMs: Date.now(),
        attachments,
      });

      res.json({ ok: true });
    } catch (error) {
      await addOutboundMessage({
        clientId: client.id,
        phone: client.phone,
        body: buildLoggedMessageBody(text, attachments),
        status: "failed",
        errorMessage: error?.message || "Falha ao enviar mensagem.",
        timestampMs: Date.now(),
        attachments,
      });
      throw error;
    }
  })
);

app.get(
  "/api/invoices",
  asyncHandler(async (req, res) => {
    const [clients, templates, invoices] = await Promise.all([listClients(), listTemplates(), listInvoices()]);
    res.json(buildInvoiceViews({ invoices, clients, templates }));
  })
);

app.post(
  "/api/invoices",
  invoiceUpload,
  asyncHandler(async (req, res) => {
    const clientId = String(req.body?.clientId ?? "").trim();
    const valueCents = parseCurrencyToCents(req.body?.value);
    const dueDate = String(req.body?.dueDate ?? "").trim();
    const paymentLink = normalizePaymentLink(req.body?.paymentLink);
    const rawPaymentLink = String(req.body?.paymentLink ?? "").trim();
    const templateId = String(req.body?.templateId ?? "").trim() || null;
    const recurrence = String(req.body?.recurrence ?? "").trim() || "Único";

    const attachments = collectInvoiceUploads(req.files);

    if (!clientId) throw createHttpError(400, "clientId obrigatório.");

    const client = await getClient(clientId);
    if (!client) throw createHttpError(400, "Cliente não encontrado.");

    if (!valueCents) throw createHttpError(400, "Valor inválido.");
    if (!isIsoDate(dueDate)) throw createHttpError(400, "Data inválida (use AAAA-MM-DD).");
    if (rawPaymentLink && !paymentLink) throw createHttpError(400, "Link do pagamento inválido.");
    if (templateId && !(await getTemplate(templateId))) throw createHttpError(400, "Template não encontrado.");

    const invoice = await createInvoice({
      clientId,
      valueCents,
      dueDate,
      paymentLink,
      recurrence,
      templateId,
      attachment: attachments[0] ?? null,
      attachments,
    });

    res.status(201).json(invoice);
  })
);

app.get(
  "/api/invoices/:id/preview",
  asyncHandler(async (req, res) => {
    const invoice = await getInvoice(req.params.id);
    if (!invoice) throw createHttpError(404, "Cobrança não encontrada.");

    const client = await getClient(invoice.clientId);
    if (!client) throw createHttpError(400, "Cliente não encontrado.");

    const { ruleState, template, renderedText, attachments } = await buildInvoiceCommunicationContext(invoice, client);

    res.json({
      invoiceId: invoice.id,
      phone: client.phone,
      attachment: invoice.attachment,
      attachments,
      renderedText,
      status: mapRuleStatusToInvoiceStatus(ruleState.sendStatus, invoice.status),
      lastError: invoice.lastError,
      template,
      billingRule: {
        currentRuleOffsetDays: ruleState.currentRuleOffsetDays,
        currentRuleLabel: ruleState.currentRuleLabel,
        sendStatus: ruleState.sendStatus,
      },
    });
  })
);

app.post(
  "/api/invoices/send-batch",
  asyncHandler(async (req, res) => {
    if (batchSendState.status === "running") {
      throw createHttpError(409, "Já existe um envio em massa em andamento.");
    }

    const delayMs = normalizeBatchDelayMs(req.body?.delayMs);
    const { hasFilter, invoiceIds } = normalizeBatchInvoiceIds(req.body?.invoiceIds);
    const requestedIds = new Set(invoiceIds);
    const [clients, templates, invoices] = await Promise.all([listClients(), listTemplates(), listInvoices()]);
    const invoiceViews = buildInvoiceViews({ invoices, clients, templates });
    const eligibleInvoices = sortInvoicesForBatch(invoiceViews.filter(isBatchEligibleInvoice));
    const targetInvoices = hasFilter
      ? eligibleInvoices.filter((invoice) => requestedIds.has(invoice.id))
      : eligibleInvoices;
    const skipped = hasFilter ? invoiceIds.length - targetInvoices.length : 0;

    if (!targetInvoices.length) {
      patchBatchSendState({
        ...createIdleBatchSendState(),
        delayMs,
        skipped,
      });
      return res.status(200).json({
        ok: true,
        started: false,
        message: "Nenhuma cobrança pendente ou com falha encontrada para envio em massa.",
        batchSend: getBatchSendState(),
      });
    }

    patchBatchSendState({
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      delayMs,
      total: targetInvoices.length,
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped,
      currentInvoiceId: null,
      currentClientId: null,
      currentClientName: null,
      waitingUntil: null,
      errorMessage: null,
      results: [],
    });

    runInvoiceBatch({ invoices: targetInvoices, delayMs }).catch((err) => {
      patchBatchSendState({
        status: "failed",
        finishedAt: nowIso(),
        waitingUntil: null,
        currentInvoiceId: null,
        currentClientId: null,
        currentClientName: null,
        errorMessage: err?.message || "Falha ao processar envio em massa.",
      });
    });

    res.status(202).json({
      ok: true,
      started: true,
      message: `Envio em massa iniciado para ${targetInvoices.length} cobrança(s).`,
      batchSend: getBatchSendState(),
    });
  })
);

app.get(
  "/api/invoices/send-batch/status",
  asyncHandler(async (req, res) => {
    res.json(getBatchSendState());
  })
);

app.post(
  "/api/invoices/:id/send",
  asyncHandler(async (req, res) => {
    const result = await executeInvoiceSend(req.params.id);
    res.json({ ok: true, result });
  })
);

app.post(
  "/api/invoices/:id/mark-paid",
  asyncHandler(async (req, res) => {
    const invoice = await getInvoice(req.params.id);
    if (!invoice) throw createHttpError(404, "Cobrança não encontrada.");
    if (invoice.status === "paid") throw createHttpError(400, "Cobrança já está quitada.");
    const updated = await markInvoicePaid(invoice.id);
    res.json({ ok: true, invoice: updated });
  })
);

app.post(
  "/api/invoices/:id/send-email",
  asyncHandler(async (req, res) => {
    const invoice = await getInvoice(req.params.id);
    if (!invoice) throw createHttpError(404, "Cobrança não encontrada.");

    const client = await getClient(invoice.clientId);
    if (!client) throw createHttpError(400, "Cliente não encontrado.");
    if (!client.email) throw createHttpError(400, "Cliente sem e-mail cadastrado.");
    const settings = await getSettings();

    const templates = await listTemplates();
    const { ruleState, template, renderedText, attachments } = await buildInvoiceCommunicationContext(
      invoice,
      client,
      templates
    );
    if (ruleState.enabled && !ruleState.currentTemplateId) {
      throw createHttpError(400, "Esta cobrança ainda não atingiu nenhuma etapa liberada da régua.");
    }
    const subject = buildInvoiceEmailSubject({ invoice, client });
    const html = buildInvoiceEmailHtml({ invoice, client, renderedText });
    const attempt = await markInvoiceSendAttempt(invoice.id, {
      templateId: template?.id || null,
      templateName: template?.name || null,
      ruleOffsetDays: ruleState.currentRuleOffsetDays,
      channel: "email",
      renderedBody: renderedText,
    });

    try {
      const result = await email.sendMessage({
        to: client.email,
        subject,
        text: renderedText,
        html,
        attachments,
      }, settings.gmail);

      await Promise.all([
        markInvoiceSendResult(invoice.id, {
          ok: true,
          messageId: result?.messageId ?? null,
          dispatchId: attempt?.dispatchId || null,
        }),
        addOutboundMessage({
          clientId: client.id,
          phone: client.phone,
          body: `[E-mail para ${client.email}] ${subject}\n\n${buildLoggedMessageBody(renderedText, attachments)}`,
          invoiceId: invoice.id,
          status: "sent",
          externalId: result?.messageId ?? null,
          timestampMs: Date.now(),
          messageType: "email",
          attachments,
        }),
      ]);

      res.json({
        ok: true,
        result: {
          to: client.email,
          subject,
          messageId: result?.messageId ?? null,
        },
      });
    } catch (err) {
      await Promise.all([
        markInvoiceSendResult(invoice.id, {
          ok: false,
          errorMessage: err?.message || "Falha ao enviar cobrança por e-mail.",
          dispatchId: attempt?.dispatchId || null,
        }),
        addOutboundMessage({
          clientId: client.id,
          phone: client.phone,
          body: `[Falha no e-mail para ${client.email}] ${subject}\n\n${buildLoggedMessageBody(renderedText, attachments)}`,
          invoiceId: invoice.id,
          status: "failed",
          errorMessage: err?.message || "Falha ao enviar cobrança por e-mail.",
          timestampMs: Date.now(),
          messageType: "email",
          attachments,
        }),
      ]);

      throw createHttpError(400, err?.message || "Falha ao enviar cobrança por e-mail.");
    }
  })
);

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err?.message || "Falha interna do servidor." });
});

async function main() {
  await ensureUploadsDir();

  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Painel: http://localhost:${PORT}`);
  });

  if (DISABLE_WHATSAPP_INIT) {
    // eslint-disable-next-line no-console
    console.log("[wa] init skipped by DISABLE_WHATSAPP_INIT");
  } else {
    wa.init().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[wa] init failed:", err?.message || err);
    });
  }

  const shutdown = async () => {
    await wa.shutdown();
    await new Promise((resolve) => server.close(resolve));
  };

  process.once("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
