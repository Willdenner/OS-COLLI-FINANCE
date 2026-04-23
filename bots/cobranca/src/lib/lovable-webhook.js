const crypto = require("node:crypto");

function normalizeOptionalText(value, maxLength = 255) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function computeWebhookSignature(secret, rawBody) {
  return crypto.createHmac("sha256", String(secret || "")).update(Buffer.from(rawBody || "")).digest("hex");
}

function normalizeSignatureHeader(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.startsWith("sha256=") ? raw.slice(7) : raw;
}

function safeEqualHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  if (!leftBuffer.length || !rightBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateWebhookSignature({ secret, rawBody, signature }) {
  if (!secret) return { ok: false, reason: "missing_secret" };
  const normalizedSignature = normalizeSignatureHeader(signature);
  if (!normalizedSignature) return { ok: false, reason: "missing_signature" };
  const expected = computeWebhookSignature(secret, rawBody);
  return {
    ok: safeEqualHex(expected, normalizedSignature),
    reason: safeEqualHex(expected, normalizedSignature) ? "valid" : "invalid_signature",
  };
}

function normalizePhone(value, defaultCountryCode = "55") {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return `${defaultCountryCode}${digits}`;
  return digits;
}

function parseAmountToCents(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * 100);
  }

  const raw = String(value)
    .trim()
    .replace(/[^\d,.-]+/g, "");
  if (!raw) return null;

  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}

function parseDueDateToIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(
    2,
    "0"
  )}`;
}

function buildRecurrenceLabel({ isInstallment, installmentCount }) {
  const totalInstallments = Math.max(1, Math.trunc(Number(installmentCount) || 1));
  if (isInstallment && totalInstallments > 1) return `Parcelado ${totalInstallments}x`;
  return "Único";
}

function normalizeCardStatus(value) {
  return normalizeOptionalText(value, 80)?.toLowerCase() || null;
}

/** Traverse dot paths; unwraps one level of array (Finance often sends billing_clients: [{ nome }]). */
function readNestedValue(source, path) {
  const parts = String(path || "")
    .split(".")
    .filter(Boolean);
  let current = source;
  for (const part of parts) {
    while (Array.isArray(current) && current.length) {
      current = current[0];
    }
    if (current == null || typeof current !== "object") return undefined;
    if (!(part in current)) return undefined;
    current = current[part];
  }
  while (Array.isArray(current) && current.length) {
    current = current[0];
  }
  return current;
}

function readFirstValueFromObject(obj, paths = []) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const p of paths) {
    const value = readNestedValue(obj, p);
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function readFirstValueFromRoots(roots, paths = []) {
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const value = readFirstValueFromObject(root, paths);
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function readFirstOptionalTextFromRoots(roots, paths, maxLength = 160) {
  for (const root of roots) {
    const text = readFirstValueFromObject(root, paths);
    const normalized = normalizeOptionalText(text, maxLength);
    if (normalized) return normalized;
  }
  return null;
}

const CLIENT_NAME_PATHS = [
  "client_name",
  "clientName",
  "customer_name",
  "customerName",
  "nome",
  "name",
  "razao_social",
  "nome_fantasia",
  "company_name",
  "companyName",
  "billing_clients.nome",
  "billing_clients.name",
  "billing_clients.razao_social",
  "billing_client.nome",
  "billing_client.name",
  "billing_client.razao_social",
  "client.nome",
  "client.name",
  "client.razao_social",
  "customer.nome",
  "customer.name",
  "payer_name",
  "payerName",
  "debtor_name",
  "favorecido",
  "empresa_razao_social",
];

const CARD_ID_PATHS = [
  "card_id",
  "cardId",
  "id",
  "wallet_item_id",
  "walletItemId",
  "external_id",
  "externalId",
  "contract_number",
  "contractNumber",
];

const PHONE_LEAF_PATHS = [
  "client_phone",
  "phone",
  "customer_phone",
  "whatsapp",
  "telefone",
  "celular",
  "billing_clients.telefone",
  "billing_clients.phone",
  "billing_client.telefone",
  "billing_client.phone",
  "client.telefone",
  "client.phone",
  "customer.telefone",
  "customer.phone",
];

const AMOUNT_LEAF_PATHS = [
  "target_amount",
  "amount",
  "value",
  "valor",
  "invoice_value",
  "invoiceValue",
  "value_cents",
  "valueCents",
  "target_amount_cents",
];

const DUE_LEAF_PATHS = ["due_date", "dueDate", "vencimento", "data_vencimento", "date"];

const COMPANY_NAME_PATHS = [
  "client_company",
  "clientCompany",
  "companyName",
  "company_name",
  "empresa_razao_social",
  "billing_clients.razao_social",
  "billing_client.razao_social",
  "client.razao_social",
];

function extractLovableCardPayload(body = {}) {
  const source = body && typeof body === "object" ? body : {};
  const data = source.data && typeof source.data === "object" ? source.data : source;
  const roots = [data, source].filter((r) => r && typeof r === "object" && !Array.isArray(r));

  const firstText = (paths, max = 160) => readFirstOptionalTextFromRoots(roots, paths, max);
  const firstText320 = (paths) => readFirstOptionalTextFromRoots(roots, paths, 320);

  const nameFromClientPaths = firstText(CLIENT_NAME_PATHS);
  const nameFromCompanyPaths = firstText(COMPANY_NAME_PATHS);
  const clientName = nameFromClientPaths || nameFromCompanyPaths;
  const companyNameOnly =
    nameFromClientPaths && nameFromCompanyPaths && nameFromCompanyPaths !== nameFromClientPaths
      ? nameFromCompanyPaths
      : null;
  const cardId = firstText(CARD_ID_PATHS);
  const phone = normalizePhone(readFirstValueFromRoots(roots, PHONE_LEAF_PATHS));
  const email = firstText320(["client_email", "email", "billing_clients.email", "client.email", "customer.email"]);
  const valueCents = parseAmountToCents(readFirstValueFromRoots(roots, AMOUNT_LEAF_PATHS));
  const dueDate = parseDueDateToIso(readFirstValueFromRoots(roots, DUE_LEAF_PATHS));
  const statusRaw = readFirstValueFromRoots(roots, ["status"]);
  const paymentMethodRaw = readFirstValueFromRoots(roots, ["payment_method", "paymentMethod"]);
  const paymentLinkRaw = readFirstValueFromRoots(roots, ["payment_link", "paymentLink", "link_pagamento"]);
  const notesRaw = readFirstValueFromRoots(roots, ["notes", "observacoes", "observations"]);
  const templateName = firstText(["template_name", "templateName", "template_nome", "template"], 120);
  const assignedTo = firstText(["assigned_to", "assignedTo"], 120);
  const sellerName = firstText(["seller_name", "sellerName", "vendedor"], 120);
  const isInstallment =
    (roots[0] && roots[0].is_installment === true) ||
    (source && source.is_installment === true) ||
    (data && data.is_installment === true);
  const installmentCount = Math.max(
    1,
    Math.trunc(
      Number(readFirstValueFromRoots(roots, ["installment_count", "installmentCount"])) || 1
    )
  );
  const isLocked = (roots[0] && roots[0].is_locked === true) || (source && source.is_locked === true) || (data && data.is_locked === true);
  const cobrancaEnviada =
    (roots[0] && roots[0].cobranca_enviada === true) ||
    (source && source.cobranca_enviada === true) ||
    (data && data.cobranca_enviada === true);

  return {
    event: normalizeOptionalText(source.event, 80) || "card.created",
    timestamp: normalizeOptionalText(source.timestamp, 80) || null,
    cardId,
    clientName,
    companyName: companyNameOnly,
    phone,
    email,
    valueCents,
    dueDate,
    status: normalizeCardStatus(statusRaw),
    paymentMethod: normalizeOptionalText(paymentMethodRaw, 80),
    paymentLink: normalizeOptionalText(paymentLinkRaw, 2000),
    notes: normalizeOptionalText(notesRaw, 2000),
    templateName: normalizeOptionalText(templateName, 120),
    isInstallment,
    installmentCount,
    isLocked,
    cobrancaEnviada,
    assignedTo: normalizeOptionalText(assignedTo, 120),
    sellerName: normalizeOptionalText(sellerName, 120),
    rawData: data,
  };
}

function shouldCreateLovableInvoice(card) {
  if (!card?.cardId) return { ok: false, reason: "card_id_ausente" };
  if (!card?.clientName) return { ok: false, reason: "client_name_ausente" };
  if (!card?.phone) return { ok: false, reason: "telefone_ausente" };
  if (!card?.valueCents) return { ok: false, reason: "valor_ausente" };
  if (!card?.dueDate) return { ok: false, reason: "vencimento_ausente" };
  if (card.isLocked) return { ok: false, reason: "card_travado" };
  if (card.cobrancaEnviada) return { ok: false, reason: "cobranca_ja_enviada_no_origem" };
  if (card.status && card.status !== "pendente") return { ok: false, reason: `status_${card.status}` };
  return { ok: true, reason: "ready" };
}

module.exports = {
  buildRecurrenceLabel,
  computeWebhookSignature,
  extractLovableCardPayload,
  parseAmountToCents,
  parseDueDateToIso,
  shouldCreateLovableInvoice,
  validateWebhookSignature,
};
