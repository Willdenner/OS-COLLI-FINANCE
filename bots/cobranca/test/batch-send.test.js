const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_BATCH_SEND_DELAY_MS,
  MAX_BATCH_SEND_DELAY_MS,
  MIN_BATCH_SEND_DELAY_MS,
  isBatchEligibleInvoice,
  normalizeBatchDelayMs,
  normalizeBatchInvoiceIds,
  sortInvoicesForBatch,
} = require("../src/lib/batch-send");

test("normaliza o delay do envio em massa dentro dos limites permitidos", () => {
  assert.equal(normalizeBatchDelayMs(undefined), DEFAULT_BATCH_SEND_DELAY_MS);
  assert.equal(normalizeBatchDelayMs(500), MIN_BATCH_SEND_DELAY_MS);
  assert.equal(normalizeBatchDelayMs(MAX_BATCH_SEND_DELAY_MS + 5000), MAX_BATCH_SEND_DELAY_MS);
  assert.equal(normalizeBatchDelayMs(8450.4), 8450);
});

test("considera apenas cobranças pendentes ou com falha para envio em massa", () => {
  assert.equal(isBatchEligibleInvoice({ status: "pending" }), true);
  assert.equal(isBatchEligibleInvoice({ status: "failed" }), true);
  assert.equal(isBatchEligibleInvoice({ status: "sent" }), false);
  assert.equal(isBatchEligibleInvoice({ status: "sending" }), false);
});

test("ordena cobranças do lote por vencimento e depois por criação", () => {
  const ordered = sortInvoicesForBatch([
    { id: "inv_3", dueDate: "2026-04-20", createdAt: "2026-04-10T10:00:00.000Z" },
    { id: "inv_2", dueDate: "2026-04-18", createdAt: "2026-04-10T11:00:00.000Z" },
    { id: "inv_1", dueDate: "2026-04-18", createdAt: "2026-04-10T09:00:00.000Z" },
  ]);

  assert.deepEqual(
    ordered.map((invoice) => invoice.id),
    ["inv_1", "inv_2", "inv_3"]
  );
});

test("normaliza ids do lote e preserva filtro vazio explícito", () => {
  assert.deepEqual(normalizeBatchInvoiceIds(undefined), { hasFilter: false, invoiceIds: [] });
  assert.deepEqual(normalizeBatchInvoiceIds([]), { hasFilter: true, invoiceIds: [] });
  assert.deepEqual(normalizeBatchInvoiceIds([" inv_1 ", "inv_1", "", "inv_2"]), {
    hasFilter: true,
    invoiceIds: ["inv_1", "inv_2"],
  });
});
