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

function extractLovableCardPayload(body = {}) {
  const source = body && typeof body === "object" ? body : {};
  const data = source.data && typeof source.data === "object" ? source.data : source;

  const payload = {
    event: normalizeOptionalText(source.event, 80) || "card.created",
    timestamp: normalizeOptionalText(source.timestamp, 80) || null,
    cardId:
      normalizeOptionalText(data.card_id, 160) ||
      normalizeOptionalText(data.id, 160) ||
      normalizeOptionalText(data.cardId, 160),
    clientName:
      normalizeOptionalText(data.client_name, 160) ||
      normalizeOptionalText(data.customer_name, 160) ||
      normalizeOptionalText(data.clientName, 160) ||
      normalizeOptionalText(data.company_name, 160),
    companyName:
      normalizeOptionalText(data.company_name, 160) ||
      normalizeOptionalText(data.client_company, 160) ||
      normalizeOptionalText(data.companyName, 160),
    phone: normalizePhone(data.client_phone || data.phone || data.customer_phone),
    email: normalizeOptionalText(data.client_email || data.email, 320),
    valueCents: parseAmountToCents(data.target_amount ?? data.amount ?? data.value),
    dueDate: parseDueDateToIso(data.due_date || data.dueDate),
    status: normalizeCardStatus(data.status),
    paymentMethod: normalizeOptionalText(data.payment_method, 80),
    paymentLink: normalizeOptionalText(data.payment_link || data.paymentLink, 2000),
    notes: normalizeOptionalText(data.notes, 2000),
    templateName: normalizeOptionalText(data.template_name || data.templateName, 120),
    isInstallment: data.is_installment === true,
    installmentCount: Math.max(1, Math.trunc(Number(data.installment_count) || 1)),
    isLocked: data.is_locked === true,
    cobrancaEnviada: data.cobranca_enviada === true,
    assignedTo: normalizeOptionalText(data.assigned_to, 120),
    sellerName: normalizeOptionalText(data.seller_name, 120),
    rawData: data,
  };

  return payload;
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
