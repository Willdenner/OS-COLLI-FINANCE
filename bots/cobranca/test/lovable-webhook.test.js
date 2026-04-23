const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRecurrenceLabel,
  computeWebhookSignature,
  extractLovableCardPayload,
  shouldCreateLovableInvoice,
  validateWebhookSignature,
} = require("../src/lib/lovable-webhook");

test("valida assinatura HMAC do webhook do Lovable", () => {
  const rawBody = Buffer.from(JSON.stringify({ event: "card.created", data: { card_id: "abc" } }));
  const secret = "segredo-compartilhado";
  const signature = `sha256=${computeWebhookSignature(secret, rawBody)}`;

  assert.deepEqual(validateWebhookSignature({ secret, rawBody, signature }), {
    ok: true,
    reason: "valid",
  });
});

test("normaliza o payload de card criado do Lovable", () => {
  const payload = extractLovableCardPayload({
    event: "card.created",
    timestamp: "2026-04-15T14:30:00Z",
    data: {
      card_id: "card_123",
      client_name: "Empresa XPTO Ltda",
      client_phone: "11999998888",
      client_email: "financeiro@xpto.com.br",
      target_amount: 5000,
      due_date: "2026-04-20T00:00:00Z",
      status: "pendente",
      payment_method: "boleto",
      is_installment: true,
      installment_count: 3,
      notes: "Contrato mensal",
    },
  });

  assert.equal(payload.cardId, "card_123");
  assert.equal(payload.phone, "5511999998888");
  assert.equal(payload.valueCents, 500000);
  assert.equal(payload.dueDate, "2026-04-20");
  assert.equal(payload.status, "pendente");
  assert.equal(buildRecurrenceLabel(payload), "Parcelado 3x");
});

test("resolve nome a partir de estrutura Finance (billing_clients) e aprova criação", () => {
  const payload = extractLovableCardPayload({
    data: {
      id: "card_999",
      billing_clients: [
        { nome: "Loja Boa Vida", telefone: "11987654321", cnpj_cpf: "123" },
      ],
      target_amount: 1000,
      due_date: "2026-04-20",
      status: "pendente",
      client_phone: "11999998888",
    },
  });
  assert.equal(payload.clientName, "Loja Boa Vida");
  assert.equal(payload.cardId, "card_999");
  assert.deepEqual(shouldCreateLovableInvoice(payload), { ok: true, reason: "ready" });
});

test("ignora cards que não podem gerar cobrança no bot", () => {
  assert.deepEqual(
    shouldCreateLovableInvoice({
      cardId: "card_123",
      clientName: "Empresa XPTO",
      phone: "5511999998888",
      valueCents: 500000,
      dueDate: "2026-04-20",
      status: "quitado",
      isLocked: false,
      cobrancaEnviada: false,
    }),
    { ok: false, reason: "status_quitado" }
  );
});
