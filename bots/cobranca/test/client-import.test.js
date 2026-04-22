const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");

const {
  CLIENT_SHEET_NAME,
  INSTRUCTIONS_SHEET_NAME,
  createClientImportTemplateBuffer,
  parseClientImportBuffer,
  parseCurrencyToCents,
  parseDateToIso,
} = require("../src/lib/client-import");

test("gera um modelo Excel com abas de clientes e instruções", () => {
  const buffer = createClientImportTemplateBuffer();
  const workbook = XLSX.read(buffer, { type: "buffer" });

  assert.deepEqual(workbook.SheetNames, [CLIENT_SHEET_NAME, INSTRUCTIONS_SHEET_NAME]);

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[CLIENT_SHEET_NAME], { header: 1, defval: "" });
  assert.deepEqual(rows[0], [
    "nome_cliente",
    "empresa_razao_social",
    "telefone",
    "email",
    "observacoes",
    "criar_cobranca",
    "valor_cobranca",
    "vencimento",
    "recorrencia",
    "template_mensagem",
    "link_pagamento",
  ]);
});

test("converte valores monetários e datas para o formato interno", () => {
  assert.equal(parseCurrencyToCents("R$ 1.500,75"), 150075);
  assert.equal(parseCurrencyToCents(1500.75), 150075);
  assert.equal(parseDateToIso("30/04/2026"), "2026-04-30");
  assert.equal(parseDateToIso("2026-04-30"), "2026-04-30");
});

test("parseia a planilha de importação com cliente e cobrança", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [
      "nome_cliente",
      "empresa_razao_social",
      "telefone",
      "email",
      "observacoes",
      "criar_cobranca",
      "valor_cobranca",
      "vencimento",
      "recorrencia",
      "template_mensagem",
      "link_pagamento",
    ],
    [
      "Maria da Silva",
      "Padaria Boa Sorte LTDA",
      "5511999999999",
      "financeiro@padaria.com",
      "Cliente mensal",
      "SIM",
      1500.75,
      new Date(2026, 3, 30),
      "Mensal",
      "Cobrança 3 dias",
      "https://pagamento.exemplo.com/123",
    ],
    ["João Pereira", "", "5511988887777", "", "", "NAO", "", "", "", "", ""],
  ]);

  XLSX.utils.book_append_sheet(workbook, sheet, CLIENT_SHEET_NAME);
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

  const rows = parseClientImportBuffer({ buffer });
  assert.equal(rows.length, 2);

  assert.deepEqual(
    {
      rowNumber: rows[0].rowNumber,
      name: rows[0].name,
      companyName: rows[0].companyName,
      phone: rows[0].phone,
      email: rows[0].email,
      notes: rows[0].notes,
      createInvoice: rows[0].createInvoice,
      valueCents: rows[0].valueCents,
      dueDate: rows[0].dueDate,
      recurrence: rows[0].recurrence,
      templateName: rows[0].templateName,
      paymentLink: rows[0].paymentLink,
    },
    {
      rowNumber: 2,
      name: "Maria da Silva",
      companyName: "Padaria Boa Sorte LTDA",
      phone: "5511999999999",
      email: "financeiro@padaria.com",
      notes: "Cliente mensal",
      createInvoice: true,
      valueCents: 150075,
      dueDate: "2026-04-30",
      recurrence: "Mensal",
      templateName: "Cobrança 3 dias",
      paymentLink: "https://pagamento.exemplo.com/123",
    }
  );

  assert.equal(rows[1].createInvoice, false);
  assert.equal(rows[1].valueCents, null);
  assert.equal(rows[1].dueDate, null);
});
