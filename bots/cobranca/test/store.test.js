const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function createTempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wa-cobranca-test-"));
}

function loadFreshStore(dataDir) {
  process.env.BOT_DATA_DIR = dataDir;
  delete require.cache[require.resolve("../src/lib/store")];
  delete require.cache[require.resolve("../src/lib/domain")];
  return require("../src/lib/store");
}

test("impede cliente duplicado mesmo com variação de DDI", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.createClient({ name: "Carolina", phone: "66999000341" });

  await assert.rejects(
    () => store.createClient({ name: "Carolina 2", phone: "5566999000341" }),
    /Já existe um cliente/
  );
});

test("deduplica mensagens inbound e atualiza clientes aguardando retorno", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);
  const client = await store.createClient({ name: "Will", phone: "5566999524871" });

  await store.addInboundMessage({
    externalId: "msg-1",
    fromPhone: "66999524871",
    fromId: "5566999524871@c.us",
    body: "Oi, preciso de ajuda",
    timestampMs: 1710000000000,
    messageType: "chat",
  });

  await store.addInboundMessage({
    externalId: "msg-1",
    fromPhone: "66999524871",
    fromId: "5566999524871@c.us",
    body: "Oi, preciso de ajuda",
    timestampMs: 1710000000000,
    messageType: "chat",
  });

  const inbox = await store.listMessages({ limit: 10 });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].clientId, client.id);

  const statsBeforeReply = await store.getDashboardStats();
  assert.equal(statsBeforeReply.clientsNeedingAttention, 1);
  assert.equal(statsBeforeReply.matchedInboxCount, 1);

  await store.addOutboundMessage({
    clientId: client.id,
    phone: client.phone,
    body: "Estamos verificando.",
    status: "sent",
    timestampMs: 1710000005000,
  });

  const statsAfterReply = await store.getDashboardStats();
  assert.equal(statsAfterReply.clientsNeedingAttention, 0);
});

test("ignora mensagens de grupo no inbox operacional", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.addInboundMessage({
    externalId: "group-1",
    fromPhone: "5511999999999",
    fromId: "120363030366796264@g.us",
    body: "Mensagem de grupo",
    timestampMs: 1710000100000,
    messageType: "chat",
  });

  const inbox = await store.listMessages({ limit: 10 });
  const stats = await store.getDashboardStats();

  assert.equal(inbox.length, 0);
  assert.equal(stats.inboxCount, 0);
});

test("recupera cobrança presa em sending como falha após reinício", async () => {
  const dataDir = await createTempDataDir();
  const dbPath = path.join(dataDir, "db.json");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    dbPath,
    JSON.stringify(
      {
        settings: { messageTemplate: "teste" },
        clients: [],
        invoices: [
          {
            id: "inv_1",
            clientId: "cli_1",
            valueCents: 1000,
            dueDate: "2026-04-13",
            createdAt: "2026-04-13T00:00:00.000Z",
            lastAttemptAt: "2026-04-13T00:10:00.000Z",
            sendAttempts: 1,
            status: "sending",
          },
        ],
        messages: [],
      },
      null,
      2
    )
  );

  const store = loadFreshStore(dataDir);
  const invoices = await store.listInvoices();

  assert.equal(invoices[0].status, "failed");
  assert.match(invoices[0].lastError, /Envio interrompido/);
});

test("gerencia templates e troca o template ativo", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  const initialTemplates = await store.listTemplates();
  assert.equal(initialTemplates.length, 1);
  assert.equal(initialTemplates[0].isActive, true);

  const followup = await store.createTemplate({
    name: "Lembrete Amigável",
    category: "Lembrete",
    body: "Oi [nome do cliente], lembrando do vencimento em [data de pagamento].",
    sendAttachment: false,
  });

  assert.equal(followup.isActive, false);

  const activated = await store.updateTemplate(followup.id, { isActive: true });
  assert.equal(activated.isActive, true);

  const active = await store.getActiveTemplate();
  assert.equal(active.id, followup.id);

  const settings = await store.getSettings();
  assert.equal(settings.activeTemplateId, followup.id);
});

test("impede dois templates na mesma etapa da régua", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.createTemplate({
    name: "D-3",
    category: "Cobrança",
    body: "Lembrete 3 dias antes",
    sendAttachment: false,
    ruleOffsetDays: -3,
  });

  await assert.rejects(
    () =>
      store.createTemplate({
        name: "Outro D-3",
        category: "Cobrança",
        body: "Outro lembrete",
        sendAttachment: false,
        ruleOffsetDays: -3,
      }),
    /Já existe um template configurado/
  );
});

test("permite vincular mensagem sem cadastro a um cliente existente", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  const client = await store.createClient({ name: "Cliente Base", phone: "5511999999999" });

  const message = await store.addInboundMessage({
    externalId: "msg-link",
    fromPhone: "5511888888888",
    fromId: "5511888888888@c.us",
    body: "Quero negociar",
    timestampMs: 1710000200000,
    messageType: "chat",
  });

  const beforeLink = await store.getDashboardStats();
  assert.equal(beforeLink.unmatchedInboxCount, 1);

  await store.linkMessageToClient(message.id, client.id);

  const inbox = await store.listMessages({ limit: 10 });
  assert.equal(inbox[0].clientId, client.id);

  const conversation = await store.listClientMessages(client.id, { limit: 10 });
  assert.equal(conversation.length, 1);
  assert.equal(conversation[0].body, "Quero negociar");

  const afterLink = await store.getDashboardStats();
  assert.equal(afterLink.unmatchedInboxCount, 0);
  assert.equal(afterLink.matchedInboxCount, 1);
});

test("remove uma mensagem sem vínculo do arquivo", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  const message = await store.addInboundMessage({
    externalId: "msg-delete-one",
    fromPhone: "5511888888888",
    fromId: "5511888888888@c.us",
    body: "Mensagem para apagar",
    timestampMs: 1710000300000,
    messageType: "chat",
  });

  const deleted = await store.deleteMessage(message.id, { onlyUnmatched: true });
  assert.equal(deleted, true);

  const inbox = await store.listMessages({ limit: 10 });
  assert.equal(inbox.length, 0);
});

test("remove todas as mensagens sem vínculo de um número", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.addInboundMessage({
    externalId: "msg-delete-phone-1",
    fromPhone: "5511888888888",
    fromId: "5511888888888@c.us",
    body: "Mensagem 1",
    timestampMs: 1710000400000,
    messageType: "chat",
  });
  await store.addInboundMessage({
    externalId: "msg-delete-phone-2",
    fromPhone: "5511888888888",
    fromId: "5511888888888@c.us",
    body: "Mensagem 2",
    timestampMs: 1710000405000,
    messageType: "chat",
  });
  await store.addInboundMessage({
    externalId: "msg-keep",
    fromPhone: "5511777777777",
    fromId: "5511777777777@c.us",
    body: "Outra conversa",
    timestampMs: 1710000410000,
    messageType: "chat",
  });

  const deletedCount = await store.deleteMessagesByPhone("5511888888888", { onlyUnmatched: true });
  assert.equal(deletedCount, 2);

  const inbox = await store.listMessages({ limit: 10 });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].fromPhone, "5511777777777");
});

test("registra e-mail enviado no histórico do cliente", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);
  const client = await store.createClient({ name: "Cliente Email", phone: "5511999999999" });

  await store.addOutboundMessage({
    clientId: client.id,
    phone: client.phone,
    body: "[E-mail] Assunto de cobranca",
    status: "sent",
    timestampMs: 1710000500000,
    messageType: "email",
  });

  const conversation = await store.listClientMessages(client.id, { limit: 10 });
  assert.equal(conversation.length, 1);
  assert.equal(conversation[0].messageType, "email");
});

test("persiste múltiplos anexos na cobrança mantendo compatibilidade com attachment principal", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);
  const client = await store.createClient({ name: "Cliente Docs", phone: "5511999999999" });

  const invoice = await store.createInvoice({
    clientId: client.id,
    valueCents: 250000,
    dueDate: "2026-04-20",
    paymentLink: "https://example.com/pay",
    attachments: [
      { filename: "boleto_123.pdf", originalName: "Boleto Abril.pdf", kind: "boleto", label: "Boleto" },
      { filename: "nf_123.xml", originalName: "NF Abril.xml", kind: "nota_fiscal", label: "Nota Fiscal" },
    ],
    recurrence: "Único",
  });

  assert.equal(invoice.attachment.filename, "boleto_123.pdf");
  assert.equal(invoice.attachments.length, 2);
  assert.equal(invoice.attachments[1].kind, "nota_fiscal");

  const invoices = await store.listInvoices();
  assert.equal(invoices[0].attachments.length, 2);
  assert.equal(invoices[0].attachment.originalName, "Boleto Abril.pdf");
});

test("persiste anexos em mensagens enviadas para exibição no histórico", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);
  const client = await store.createClient({ name: "Cliente WhatsApp", phone: "5511999999999" });

  await store.addOutboundMessage({
    clientId: client.id,
    phone: client.phone,
    body: "[Anexos enviados]",
    status: "sent",
    timestampMs: 1710000600000,
    attachments: [
      { filename: "contrato.pdf", originalName: "Contrato.pdf", label: "Contrato" },
      { filename: "boleto.pdf", originalName: "Boleto.pdf", label: "Boleto" },
    ],
  });

  const conversation = await store.listClientMessages(client.id, { limit: 10 });
  assert.equal(conversation.length, 1);
  assert.equal(conversation[0].attachments.length, 2);
  assert.equal(conversation[0].attachments[0].label, "Contrato");
});

test("persiste integração externa na cobrança e permite upsert por id do card", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);
  const client = await store.createClient({ name: "Cliente Lovable", phone: "5511988887777" });

  const invoice = await store.createInvoice({
    clientId: client.id,
    valueCents: 10000,
    dueDate: "2026-05-01",
    recurrence: "Único",
    integration: {
      source: "lovable",
      externalId: "card_123",
      event: "card.created",
      externalStatus: "pendente",
      paymentMethod: "boleto",
      metadata: { assignedTo: "user_1" },
    },
  });

  const found = await store.findInvoiceByIntegration("lovable", "card_123");
  assert.equal(found.id, invoice.id);
  assert.equal(found.integration.source, "lovable");
  assert.equal(found.integration.externalStatus, "pendente");

  const updated = await store.updateInvoice(invoice.id, {
    valueCents: 25000,
    dueDate: "2026-05-10",
    integration: {
      source: "lovable",
      externalId: "card_123",
      event: "card.updated",
      externalStatus: "parcial",
      paymentMethod: "pix",
      metadata: { assignedTo: "user_2" },
    },
  });

  assert.equal(updated.valueCents, 25000);
  assert.equal(updated.dueDate, "2026-05-10");
  assert.equal(updated.integration.event, "card.updated");
  assert.equal(updated.integration.externalStatus, "parcial");
  assert.equal(updated.integration.paymentMethod, "pix");
});

test("persiste configuracao do gmail preservando a senha atual em atualizações parciais", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.updateSettings({
    gmail: {
      user: "financeiro@empresa.com",
      fromName: "Financeiro V4",
      appPassword: "abcd efgh ijkl mnop",
    },
  });

  await store.updateSettings({
    gmail: {
      fromName: "Financeiro V4 Atualizado",
      appPassword: "",
    },
  });

  const settings = await store.getSettings();
  assert.equal(settings.gmail.user, "financeiro@empresa.com");
  assert.equal(settings.gmail.fromName, "Financeiro V4 Atualizado");
  assert.equal(settings.gmail.appPassword, "abcd efgh ijkl mnop");
});
