const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(ROOT_DIR, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const AUTH_DIR = path.join(DATA_DIR, ".wwebjs_auth");

const DEFAULT_MESSAGE_TEMPLATE =
  "Olá [nome do cliente], tudo bem?\n\nSua cobrança de [valor] vence em [data de pagamento].\n[Link do pagamento]";

function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function truncateText(text, maxLength = 4000) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizePhoneToDigits(phoneRaw, { defaultCountryCode } = {}) {
  const digits = onlyDigits(phoneRaw);
  if (!digits) return null;

  if (defaultCountryCode && (digits.length === 10 || digits.length === 11)) {
    return `${defaultCountryCode}${digits}`;
  }

  return digits;
}

function isPossiblePhone(rawPhone) {
  const digits = onlyDigits(rawPhone);
  return digits.length >= 10 && digits.length <= 15;
}

function buildPhoneMatchKeys(rawPhone) {
  const digits = onlyDigits(rawPhone);
  const keys = new Set();
  if (!digits) return [];

  const add = (candidate) => {
    const normalized = onlyDigits(candidate);
    if (normalized) keys.add(normalized);
  };

  add(digits);

  const with55 = digits.startsWith("55") ? digits : digits.length === 10 || digits.length === 11 ? `55${digits}` : "";
  if (with55) add(with55);

  for (const base of [digits, with55].filter(Boolean)) {
    if (!base.startsWith("55")) continue;
    const rest = base.slice(2);
    if (rest.length === 11) {
      const ddd = rest.slice(0, 2);
      const local = rest.slice(2);
      if (local.startsWith("9")) add(`55${ddd}${local.slice(1)}`);
    } else if (rest.length === 10) {
      const ddd = rest.slice(0, 2);
      const local = rest.slice(2);
      add(`55${ddd}9${local}`);
    }
  }

  for (const key of Array.from(keys)) {
    if (key.startsWith("55")) add(key.slice(2));
  }

  return Array.from(keys);
}

function formatMoneyBRL(valueCents) {
  const value = (valueCents ?? 0) / 100;
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatIsoDateToBR(value) {
  if (!isIsoDate(value)) return String(value ?? "");
  return value.split("-").reverse().join("/");
}

function normalizePaymentLink(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getAttachmentDisplayName(attachment) {
  return String(attachment?.label || attachment?.originalName || attachment?.filename || "")
    .trim()
    .replace(/\s+/g, " ");
}

function buildPaymentTemplateContext({ paymentLink, attachments } = {}) {
  const safePaymentLink = normalizePaymentLink(paymentLink) || "";
  const safeAttachments = Array.isArray(attachments) ? attachments.filter((attachment) => attachment?.filename) : [];
  const hasBoleto = safeAttachments.some((attachment) => String(attachment?.kind || "").trim() === "boleto");
  const hasAttachments = safeAttachments.length > 0;
  const attachmentList = safeAttachments.map(getAttachmentDisplayName).filter(Boolean).join(", ");

  if (hasBoleto && safePaymentLink) {
    return {
      linkDoPagamento: safePaymentLink,
      formaDePagamento: "o boleto em anexo ou o link de pagamento abaixo",
      instrucoesDePagamento: `O boleto segue em anexo. Se preferir, você também pode pagar por este link:\n${safePaymentLink}`,
      anexosDaCobranca: attachmentList,
    };
  }

  if (hasBoleto) {
    return {
      linkDoPagamento: "Boleto enviado em anexo.",
      formaDePagamento: "o boleto em anexo",
      instrucoesDePagamento: "O boleto segue em anexo para pagamento.",
      anexosDaCobranca: attachmentList,
    };
  }

  if (safePaymentLink) {
    return {
      linkDoPagamento: safePaymentLink,
      formaDePagamento: "o link de pagamento abaixo",
      instrucoesDePagamento: `Para sua comodidade, segue o link de pagamento:\n${safePaymentLink}`,
      anexosDaCobranca: attachmentList,
    };
  }

  if (hasAttachments) {
    return {
      linkDoPagamento: "Documentos enviados em anexo.",
      formaDePagamento: "os documentos anexos desta cobrança",
      instrucoesDePagamento: "Os documentos desta cobrança seguem em anexo.",
      anexosDaCobranca: attachmentList,
    };
  }

  return {
    linkDoPagamento: "",
    formaDePagamento: "os dados de pagamento",
    instrucoesDePagamento: "",
    anexosDaCobranca: "",
  };
}

function postProcessRenderedTemplate(text) {
  return String(text ?? "")
    .replace(
      /(Para sua comodidade,\s*)?segue o link de pagamento:\s*Boleto enviado em anexo\.?/gi,
      (match, prefix) => (prefix ? `${prefix}o boleto segue em anexo para pagamento.` : "O boleto segue em anexo para pagamento.")
    )
    .replace(
      /(Para sua comodidade,\s*)?segue o link de pagamento:\s*Documentos enviados em anexo\.?/gi,
      (match, prefix) =>
        prefix ? `${prefix}os documentos desta cobrança seguem em anexo.` : "Os documentos desta cobrança seguem em anexo."
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderTemplate(template, ctx) {
  const safe = (value) => (value == null ? "" : String(value));

  return postProcessRenderedTemplate(
    String(template ?? "")
    .replaceAll("[valor]", safe(ctx.valor))
    .replaceAll("[nome do cliente]", safe(ctx.nomeDoCliente))
    .replaceAll("[data de pagamento]", safe(ctx.dataDePagamento))
    .replaceAll("[Link do pagamento]", safe(ctx.linkDoPagamento))
    .replaceAll("[forma de pagamento]", safe(ctx.formaDePagamento))
    .replaceAll("[instruções de pagamento]", safe(ctx.instrucoesDePagamento))
    .replaceAll("[anexos da cobrança]", safe(ctx.anexosDaCobranca))
  );
}

function isGroupChatId(chatId) {
  return String(chatId ?? "").endsWith("@g.us");
}

function isBroadcastChatId(chatId) {
  const id = String(chatId ?? "");
  return id.endsWith("@broadcast") || id === "status@broadcast";
}

function isDirectChatId(chatId) {
  const id = String(chatId ?? "");
  if (!id) return false;
  if (isGroupChatId(id) || isBroadcastChatId(id)) return false;
  return id.endsWith("@c.us") || id.endsWith("@lid") || !id.includes("@");
}

function buildMessageFingerprint({ externalId, direction, fromId, fromPhone, body, timestampMs }) {
  if (externalId) return `external:${externalId}`;
  return [
    direction || "in",
    onlyDigits(fromPhone),
    String(fromId ?? ""),
    truncateText(body, 240),
    Number(timestampMs ?? 0),
  ].join("|");
}

module.exports = {
  AUTH_DIR,
  DATA_DIR,
  DEFAULT_MESSAGE_TEMPLATE,
  ROOT_DIR,
  UPLOADS_DIR,
  buildMessageFingerprint,
  buildPhoneMatchKeys,
  buildPaymentTemplateContext,
  formatIsoDateToBR,
  formatMoneyBRL,
  isBroadcastChatId,
  isDirectChatId,
  isGroupChatId,
  isIsoDate,
  isPossiblePhone,
  normalizeName,
  normalizePaymentLink,
  normalizePhoneToDigits,
  onlyDigits,
  renderTemplate,
  truncateText,
};
