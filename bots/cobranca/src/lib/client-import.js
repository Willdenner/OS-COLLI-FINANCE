const XLSX = require("xlsx");

const TEMPLATE_FILENAME = "modelo-cadastro-clientes.xlsx";
const CLIENT_SHEET_NAME = "Clientes";
const INSTRUCTIONS_SHEET_NAME = "Instrucoes";

const TEMPLATE_HEADERS = [
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
];

const HEADER_ALIASES = {
  nome_cliente: "name",
  nome: "name",
  nome_completo: "name",
  cliente: "name",
  empresa_razao_social: "companyName",
  empresa: "companyName",
  razao_social: "companyName",
  razao: "companyName",
  telefone: "phone",
  celular: "phone",
  whatsapp: "phone",
  email: "email",
  e_mail: "email",
  observacoes: "notes",
  observacao: "notes",
  notas: "notes",
  criar_cobranca: "createInvoice",
  gera_cobranca: "createInvoice",
  cadastrar_cobranca: "createInvoice",
  valor_cobranca: "invoiceValue",
  valor: "invoiceValue",
  vencimento: "invoiceDueDate",
  data_vencimento: "invoiceDueDate",
  due_date: "invoiceDueDate",
  recorrencia: "invoiceRecurrence",
  recorrência: "invoiceRecurrence",
  template_mensagem: "templateName",
  template: "templateName",
  template_nome: "templateName",
  link_pagamento: "paymentLink",
  link_do_pagamento: "paymentLink",
  payment_link: "paymentLink",
};

function normalizeHeaderKey(value) {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeCellText(value) {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
      value.getUTCDate()
    ).padStart(2, "0")}`;
  }
  return String(value).trim();
}

function normalizeBoolean(value) {
  const normalized = normalizeHeaderKey(value);
  if (!normalized) return null;
  if (["sim", "s", "yes", "y", "true", "1", "x"].includes(normalized)) return true;
  if (["nao", "n", "no", "false", "0"].includes(normalized)) return false;
  return null;
}

function parseCurrencyToCents(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * 100);
  }

  const raw = String(value)
    .trim()
    .replace(/[^\d,.-]+/g, "");
  if (!raw) return null;

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  let normalized = raw;

  if (hasComma) {
    normalized = raw.replace(/\./g, "").replace(",", ".");
  } else if (hasDot) {
    const parts = raw.split(".");
    normalized = parts.at(-1)?.length === 2 ? raw : raw.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}

function formatIsoDateParts(year, month, day) {
  const safeYear = Number(year);
  const safeMonth = Number(month);
  const safeDay = Number(day);
  if (!Number.isInteger(safeYear) || !Number.isInteger(safeMonth) || !Number.isInteger(safeDay)) return null;
  if (safeMonth < 1 || safeMonth > 12 || safeDay < 1 || safeDay > 31) return null;
  return `${String(safeYear).padStart(4, "0")}-${String(safeMonth).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
}

function parseDateToIso(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatIsoDateParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return formatIsoDateParts(parsed.y, parsed.m, parsed.d);
  }

  const text = String(value).trim();
  if (!text) return null;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return formatIsoDateParts(isoMatch[1], isoMatch[2], isoMatch[3]);
  }

  const brMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (brMatch) {
    return formatIsoDateParts(brMatch[3], brMatch[2], brMatch[1]);
  }

  const nativeDate = new Date(text);
  if (Number.isNaN(nativeDate.getTime())) return null;
  return formatIsoDateParts(nativeDate.getFullYear(), nativeDate.getMonth() + 1, nativeDate.getDate());
}

function shouldCreateInvoiceFromRow(mappedRow) {
  const explicitChoice = normalizeBoolean(mappedRow.createInvoice);
  if (explicitChoice !== null) return explicitChoice;
  return Boolean(
    mappedRow.invoiceValue != null ||
      mappedRow.invoiceDueDate != null ||
      mappedRow.templateName != null ||
      mappedRow.paymentLink != null
  );
}

function parseClientImportBuffer({ buffer }) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
  });

  const sheetName = workbook.SheetNames.includes(CLIENT_SHEET_NAME) ? CLIENT_SHEET_NAME : workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    raw: true,
    defval: null,
    blankrows: false,
  });

  return rows
    .map((row, index) => {
      const mappedRow = {};
      Object.entries(row || {}).forEach(([rawKey, value]) => {
        const internalKey = HEADER_ALIASES[normalizeHeaderKey(rawKey)];
        if (!internalKey) return;
        mappedRow[internalKey] = value;
      });

      const normalized = {
        rowNumber: index + 2,
        name: normalizeCellText(mappedRow.name),
        companyName: normalizeCellText(mappedRow.companyName),
        phone: normalizeCellText(mappedRow.phone),
        email: normalizeCellText(mappedRow.email),
        notes: normalizeCellText(mappedRow.notes),
        createInvoice: shouldCreateInvoiceFromRow(mappedRow),
        valueCents: parseCurrencyToCents(mappedRow.invoiceValue),
        dueDate: parseDateToIso(mappedRow.invoiceDueDate),
        recurrence: normalizeCellText(mappedRow.invoiceRecurrence) || "Único",
        templateName: normalizeCellText(mappedRow.templateName),
        paymentLink: normalizeCellText(mappedRow.paymentLink),
      };

      normalized.isEmpty =
        !normalized.name &&
        !normalized.companyName &&
        !normalized.phone &&
        !normalized.email &&
        !normalized.notes &&
        !normalized.valueCents &&
        !normalized.dueDate &&
        !normalized.templateName &&
        !normalized.paymentLink;

      return normalized;
    })
    .filter((row) => !row.isEmpty);
}

function createTemplateInstructionRows() {
  return [
    ["Campo", "Obrigatório", "Descrição", "Exemplo"],
    ["nome_cliente", "Sim", "Nome completo do cliente.", "Maria da Silva"],
    ["empresa_razao_social", "Não", "Empresa ou razão social vinculada ao cliente.", "Padaria Boa Sorte LTDA"],
    ["telefone", "Sim", "Telefone com DDI e DDD, apenas números ou com máscara.", "5511999999999"],
    ["email", "Não", "E-mail do cliente para cobrança por e-mail.", "financeiro@cliente.com"],
    ["observacoes", "Não", "Anotações internas sobre o cliente.", "Prefere contato pela manhã"],
    ["criar_cobranca", "Não", "Use SIM para já cadastrar a cobrança junto com o cliente.", "SIM"],
    ["valor_cobranca", "Condicional", "Obrigatório quando criar_cobranca = SIM.", "1500,75"],
    ["vencimento", "Condicional", "Obrigatório quando criar_cobranca = SIM. Formato recomendado AAAA-MM-DD.", "2026-04-30"],
    ["recorrencia", "Não", "Único, Mensal, Semanal ou Quinzenal.", "Mensal"],
    ["template_mensagem", "Não", "Nome do template já cadastrado no sistema. Se vazio, usa o padrão.", "Cobrança 3 dias"],
    ["link_pagamento", "Não", "Link para pagamento da cobrança.", "https://pagamento.exemplo.com/123"],
    [
      "Observação",
      "—",
      "A importação em massa não envia anexos. Boletos e notas fiscais podem ser adicionados depois pelo painel.",
      "—",
    ],
  ];
}

function createClientImportTemplateBuffer() {
  const workbook = XLSX.utils.book_new();

  const clientRows = [
    TEMPLATE_HEADERS,
    [
      "Maria da Silva",
      "Padaria Boa Sorte LTDA",
      "5511999999999",
      "financeiro@padaria.com",
      "Cliente com cobrança mensal",
      "SIM",
      1500.75,
      "2026-04-30",
      "Mensal",
      "Cobrança 3 dias",
      "https://pagamento.exemplo.com/123",
    ],
    [
      "João Pereira",
      "",
      "5511988887777",
      "",
      "Cadastrar somente o cliente",
      "NAO",
      "",
      "",
      "",
      "",
      "",
    ],
  ];

  const clientSheet = XLSX.utils.aoa_to_sheet(clientRows);
  clientSheet["!cols"] = TEMPLATE_HEADERS.map((header) => ({
    wch:
      {
        nome_cliente: 28,
        empresa_razao_social: 28,
        telefone: 20,
        email: 28,
        observacoes: 30,
        criar_cobranca: 16,
        valor_cobranca: 18,
        vencimento: 16,
        recorrencia: 16,
        template_mensagem: 22,
        link_pagamento: 32,
      }[header] || 18,
  }));

  const instructionsSheet = XLSX.utils.aoa_to_sheet(createTemplateInstructionRows());
  instructionsSheet["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 60 }, { wch: 32 }];

  XLSX.utils.book_append_sheet(workbook, clientSheet, CLIENT_SHEET_NAME);
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, INSTRUCTIONS_SHEET_NAME);

  return XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
  });
}

module.exports = {
  CLIENT_SHEET_NAME,
  INSTRUCTIONS_SHEET_NAME,
  TEMPLATE_FILENAME,
  createClientImportTemplateBuffer,
  parseClientImportBuffer,
  parseCurrencyToCents,
  parseDateToIso,
};
