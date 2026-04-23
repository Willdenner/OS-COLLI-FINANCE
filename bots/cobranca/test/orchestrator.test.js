const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("bot de cobranca expoe endpoints internos para o orquestrador FP&A", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");

  assert.match(server, /async function upsertLovableWalletItemInvoice/);
  assert.match(server, /\/api\/orchestrator\/wallet-items/);
  assert.match(server, /\/api\/orchestrator\/invoices/);
  assert.match(server, /\/api\/orchestrator\/payment-link-audit/);
  assert.match(server, /missingPaymentLinks/);
  assert.match(server, /findInvoiceByIntegration\("lovable", card\.cardId\)/);
});
