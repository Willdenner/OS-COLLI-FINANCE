const DEFAULT_BATCH_SEND_DELAY_MS = Number(process.env.MASS_SEND_DELAY_MS || 15000);
const MIN_BATCH_SEND_DELAY_MS = 3000;
const MAX_BATCH_SEND_DELAY_MS = 120000;

const BATCH_ELIGIBLE_STATUSES = new Set(["pending", "failed"]);

function isBatchEligibleInvoice(invoice) {
  return BATCH_ELIGIBLE_STATUSES.has(String(invoice?.status || "pending"));
}

function normalizeBatchDelayMs(rawValue) {
  const numericValue = Number(rawValue);
  const baseValue = Number.isFinite(numericValue) ? numericValue : DEFAULT_BATCH_SEND_DELAY_MS;
  const roundedValue = Math.round(baseValue);
  return Math.min(MAX_BATCH_SEND_DELAY_MS, Math.max(MIN_BATCH_SEND_DELAY_MS, roundedValue));
}

function compareInvoicesForBatch(a, b) {
  const dueDateCompare = String(a?.dueDate || "").localeCompare(String(b?.dueDate || ""));
  if (dueDateCompare !== 0) return dueDateCompare;

  const createdAtCompare = new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime();
  if (createdAtCompare !== 0) return createdAtCompare;

  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function sortInvoicesForBatch(invoices) {
  return (Array.isArray(invoices) ? invoices : []).slice().sort(compareInvoicesForBatch);
}

function normalizeBatchInvoiceIds(rawValue) {
  if (!Array.isArray(rawValue)) {
    return { hasFilter: false, invoiceIds: [] };
  }

  const seenIds = new Set();
  const invoiceIds = [];

  rawValue.forEach((value) => {
    const normalizedId = String(value || "").trim();
    if (!normalizedId || seenIds.has(normalizedId)) return;
    seenIds.add(normalizedId);
    invoiceIds.push(normalizedId);
  });

  return { hasFilter: true, invoiceIds };
}

module.exports = {
  DEFAULT_BATCH_SEND_DELAY_MS,
  MIN_BATCH_SEND_DELAY_MS,
  MAX_BATCH_SEND_DELAY_MS,
  compareInvoicesForBatch,
  isBatchEligibleInvoice,
  normalizeBatchDelayMs,
  normalizeBatchInvoiceIds,
  sortInvoicesForBatch,
};
