const test = require("node:test");
const assert = require("node:assert/strict");

const { computeInvoiceRuleState, describeRuleOffsetDays } = require("../src/lib/billing-rule");

test("seleciona a etapa atual da régua com base no aging da cobrança", () => {
  const templates = [
    { id: "tpl_before", name: "D-3", ruleOffsetDays: -3 },
    { id: "tpl_due", name: "D0", ruleOffsetDays: 0 },
    { id: "tpl_after", name: "D+5", ruleOffsetDays: 5 },
  ];

  const invoice = {
    id: "inv_1",
    dueDate: "2026-04-13",
    ruleDispatches: [],
  };

  const beforeDue = computeInvoiceRuleState({
    invoice,
    templates,
    now: new Date("2026-04-11T12:00:00-03:00"),
  });
  assert.equal(beforeDue.currentTemplateId, "tpl_before");
  assert.equal(beforeDue.sendStatus, "ready");

  const dueDate = computeInvoiceRuleState({
    invoice,
    templates,
    now: new Date("2026-04-13T08:00:00-03:00"),
  });
  assert.equal(dueDate.currentTemplateId, "tpl_due");
  assert.equal(dueDate.currentRuleLabel, "No vencimento");

  const overdue = computeInvoiceRuleState({
    invoice,
    templates,
    now: new Date("2026-04-19T09:00:00-03:00"),
  });
  assert.equal(overdue.currentTemplateId, "tpl_after");
  assert.equal(overdue.currentRuleLabel, "5 dia(s) após");
});

test("marca etapa atual como enviada ou falha usando o histórico de dispatch da fatura", () => {
  const templates = [
    { id: "tpl_due", name: "D0", ruleOffsetDays: 0 },
    { id: "tpl_after", name: "D+3", ruleOffsetDays: 3 },
  ];

  const sentInvoice = {
    id: "inv_sent",
    dueDate: "2026-04-13",
    ruleDispatches: [
      {
        id: "dispatch_1",
        templateId: "tpl_due",
        status: "sent",
        attemptedAt: "2026-04-13T09:00:00.000Z",
        sentAt: "2026-04-13T09:00:01.000Z",
      },
    ],
  };

  const sentState = computeInvoiceRuleState({
    invoice: sentInvoice,
    templates,
    now: new Date("2026-04-13T11:00:00-03:00"),
  });
  assert.equal(sentState.sendStatus, "sent");

  const failedInvoice = {
    id: "inv_failed",
    dueDate: "2026-04-18",
    ruleDispatches: [
      {
        id: "dispatch_2",
        templateId: "tpl_after",
        status: "failed",
        attemptedAt: "2026-04-21T12:00:00.000Z",
        errorMessage: "Falha ao enviar",
      },
    ],
  };

  const failedState = computeInvoiceRuleState({
    invoice: failedInvoice,
    templates,
    now: new Date("2026-04-21T15:00:00-03:00"),
  });
  assert.equal(failedState.currentTemplateId, "tpl_after");
  assert.equal(failedState.sendStatus, "failed");
});

test("expõe a próxima etapa quando a cobrança ainda não atingiu o primeiro ponto da régua", () => {
  const templates = [{ id: "tpl_before", name: "D-1", ruleOffsetDays: -1 }];
  const invoice = { id: "inv_soon", dueDate: "2026-04-20", ruleDispatches: [] };

  const state = computeInvoiceRuleState({
    invoice,
    templates,
    now: new Date("2026-04-15T10:00:00-03:00"),
  });

  assert.equal(state.currentTemplateId, null);
  assert.equal(state.nextTemplateId, "tpl_before");
  assert.equal(state.sendStatus, "scheduled");
  assert.equal(describeRuleOffsetDays(-1), "1 dia(s) antes");
});
