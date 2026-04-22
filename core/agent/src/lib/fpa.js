const CATEGORY_OPTIONS = [
  "Receita Operacional",
  "Outras Entradas",
  "Folha e Pessoas",
  "Impostos",
  "Marketing",
  "Tecnologia",
  "Serviços e Softwares",
  "Tarifas Bancárias",
  "Aluguel e Infraestrutura",
  "Operações e Fornecedores",
  "Viagens e Mobilidade",
  "Capex",
  "Sócios e Distribuições",
  "Investimentos e Aplicações",
  "Transferências Internas",
  "Não Classificado",
];

const DRE_TYPE_OPTIONS = [
  { value: "income", label: "Receita" },
  { value: "expense", label: "Despesa" },
  { value: "other", label: "Ajuste / Outro" },
];

const DEFAULT_DRE_ACCOUNT_TEMPLATES = [
  { name: "Receita Operacional", type: "income", categories: ["Receita Operacional"], orderIndex: 10 },
  { name: "Outras Entradas", type: "income", categories: ["Outras Entradas"], orderIndex: 20 },
  { name: "Folha e Pessoas", type: "expense", categories: ["Folha e Pessoas"], orderIndex: 30 },
  { name: "Impostos", type: "expense", categories: ["Impostos"], orderIndex: 40 },
  { name: "Marketing", type: "expense", categories: ["Marketing"], orderIndex: 50 },
  { name: "Tecnologia", type: "expense", categories: ["Tecnologia"], orderIndex: 60 },
  { name: "Serviços e Softwares", type: "expense", categories: ["Serviços e Softwares"], orderIndex: 70 },
  { name: "Aluguel e Infraestrutura", type: "expense", categories: ["Aluguel e Infraestrutura"], orderIndex: 80 },
  { name: "Operações e Fornecedores", type: "expense", categories: ["Operações e Fornecedores"], orderIndex: 90 },
  { name: "Viagens e Mobilidade", type: "expense", categories: ["Viagens e Mobilidade"], orderIndex: 100 },
  { name: "Tarifas Bancárias", type: "expense", categories: ["Tarifas Bancárias"], orderIndex: 110 },
  { name: "Investimentos e Aplicações", type: "other", categories: ["Investimentos e Aplicações"], orderIndex: 120 },
  { name: "Capex", type: "expense", categories: ["Capex"], orderIndex: 130 },
  { name: "Sócios e Distribuições", type: "other", categories: ["Sócios e Distribuições"], orderIndex: 140 },
  { name: "Não Classificado", type: "other", categories: ["Não Classificado"], orderIndex: 150 },
];

const REPORT_KEYWORDS = [
  { type: "dre", keywords: ["dre", "resultado", "demonstrativo", "lucro", "margem"] },
  { type: "expenses", keywords: ["despesa", "despesas", "categoria", "categorias", "gasto", "gastos"] },
  { type: "burn", keywords: ["burn", "queima", "runway", "caixa livre", "fôlego"] },
  { type: "revenue", keywords: ["receita", "receitas", "entradas", "faturamento", "recebimentos"] },
  { type: "cash_flow", keywords: ["fluxo", "caixa", "saldo", "movimentacao", "movimentação"] },
];

const CATEGORY_RULES = [
  {
    category: "Transferências Internas",
    subcategory: "Movimentação entre contas",
    keywords: ["transferencia entre contas", "transferência entre contas", "mesma titularidade", "transf interna", "transferencia interna", "resgate aplicacao", "resgate aplicação", "aplicacao financeira", "aplicação financeira"],
    reportSection: "internal_transfer",
    isInternalTransfer: true,
    confidence: 0.96,
  },
  {
    category: "Investimentos e Aplicações",
    subcategory: "Aplicações financeiras",
    keywords: ["cdb", "rdb", "tesouro", "aplicacao", "aplicação", "investimento", "fundo", "rendimento"],
    reportSection: "investing",
    confidence: 0.88,
  },
  {
    category: "Folha e Pessoas",
    subcategory: "Remuneração",
    keywords: ["salario", "salário", "folha", "pro labore", "pro-labore", "adiantamento salarial", "ferias", "férias", "rescisao", "rescisão", "fgts", "inss"],
    reportSection: "payroll",
    confidence: 0.95,
  },
  {
    category: "Impostos",
    subcategory: "Tributos",
    keywords: ["simples nacional", "darf", "gps", "imposto", "tributo", "iss", "icms", "pis", "cofins", "irpj", "csll", "mei"],
    reportSection: "taxes",
    confidence: 0.94,
  },
  {
    category: "Marketing",
    subcategory: "Mídia paga",
    keywords: ["google ads", "facebook ads", "meta ads", "instagram ads", "linkedin ads", "tiktok ads", "trafego", "tráfego", "mídia paga", "midia paga"],
    reportSection: "marketing",
    confidence: 0.93,
  },
  {
    category: "Tecnologia",
    subcategory: "Infra e ferramentas",
    keywords: ["aws", "amazon web services", "google cloud", "azure", "vercel", "openai", "figma", "notion", "slack", "github", "cloudflare", "hostinger", "digitalocean"],
    reportSection: "technology",
    confidence: 0.91,
  },
  {
    category: "Serviços e Softwares",
    subcategory: "Assinaturas e parceiros",
    keywords: ["adobe", "canva", "zoom", "hubspot", "rd station", "mailchimp", "contabilidade", "advocacia", "consultoria", "agencia", "agência"],
    reportSection: "g_and_a",
    confidence: 0.86,
  },
  {
    category: "Tarifas Bancárias",
    subcategory: "Custos financeiros",
    keywords: ["tarifa", "iof", "juros", "multa", "encargo", "taxa bancaria", "taxa bancária", "tarifa pix", "cesta de servicos", "cesta de serviços"],
    reportSection: "financial",
    confidence: 0.92,
  },
  {
    category: "Aluguel e Infraestrutura",
    subcategory: "Estrutura física",
    keywords: ["aluguel", "condominio", "condomínio", "energia", "agua", "água", "internet", "vivo", "claro", "tim", "telefonia", "escritorio", "escritório"],
    reportSection: "office",
    confidence: 0.9,
  },
  {
    category: "Operações e Fornecedores",
    subcategory: "Operação",
    keywords: ["fornecedor", "materia prima", "matéria prima", "insumo", "frete", "correios", "logistica", "logística", "manutencao", "manutenção", "estoque"],
    reportSection: "operations",
    confidence: 0.87,
  },
  {
    category: "Viagens e Mobilidade",
    subcategory: "Deslocamento",
    keywords: ["uber", "99app", "99 pop", "latam", "gol linhas", "azul linhas", "hotel", "airbnb", "passagem"],
    reportSection: "travel",
    confidence: 0.9,
  },
  {
    category: "Capex",
    subcategory: "Equipamentos",
    keywords: ["notebook", "computador", "monitor", "cadeira", "equipamento", "impressora", "moveis", "móveis"],
    reportSection: "capex",
    confidence: 0.85,
  },
  {
    category: "Sócios e Distribuições",
    subcategory: "Saídas para sócios",
    keywords: ["distribuicao de lucros", "distribuição de lucros", "dividendos", "retirada socio", "retirada sócio", "pro labore socio", "pro labore sócio"],
    reportSection: "financing",
    confidence: 0.92,
  },
  {
    category: "Receita Operacional",
    subcategory: "Recebimentos de clientes",
    direction: "in",
    keywords: ["pix recebido", "ted recebida", "cliente", "recebimento", "boleto recebido", "faturamento", "venda", "receita"],
    reportSection: "revenue",
    confidence: 0.83,
  },
];

function compactWhitespace(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeText(value) {
  return compactWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function truncateText(value, maxLength = 240) {
  const safeValue = compactWhitespace(value);
  if (!safeValue) return "";
  if (safeValue.length <= maxLength) return safeValue;
  return `${safeValue.slice(0, maxLength - 1)}…`;
}

function formatCurrencyBRL(valueCents) {
  return (Number(valueCents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function toIsoDate(year, month, day) {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  const iso = `${y}-${m}-${d}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

function parseFlexibleDate(rawValue) {
  const raw = compactWhitespace(rawValue);
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  let match = raw.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/);
  if (match) return toIsoDate(match[3], match[2], match[1]);

  match = raw.match(/^(\d{4})[\/.-](\d{2})[\/.-](\d{2})$/);
  if (match) return toIsoDate(match[1], match[2], match[3]);

  match = raw.match(/^(\d{8})$/);
  if (match) {
    const digits = match[1];
    if (digits.startsWith("20")) {
      return toIsoDate(digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8));
    }
  }

  return null;
}

function parseOfxDate(rawValue) {
  const digits = String(rawValue ?? "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  return toIsoDate(digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8));
}

function parseMoneyToCents(rawValue) {
  const raw = compactWhitespace(rawValue);
  if (!raw) return null;

  const negative = raw.includes("(") || raw.includes("-") || raw.toUpperCase().includes("D");
  let normalized = raw
    .replace(/[R$\s]/gi, "")
    .replace(/[()]/g, "")
    .replace(/[A-Z]/g, "")
    .replace(/[^0-9,.-]/g, "");

  if (!normalized) return null;

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const decimals = normalized.length - lastComma - 1;
    normalized = decimals === 2 ? normalized.replace(/\./g, "").replace(",", ".") : normalized.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const decimals = normalized.length - lastDot - 1;
    normalized = decimals === 2 ? normalized.replace(/,/g, "") : normalized.replace(/\./g, "");
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;

  const cents = Math.round(Math.abs(amount) * 100);
  return negative ? -cents : amount < 0 ? -cents : cents;
}

function decodeFileBuffer(buffer) {
  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/�/g) || []).length;
  return replacementCount > 3 ? buffer.toString("latin1") : utf8;
}

function detectDelimiter(lines) {
  const sample = lines.slice(0, 5).join("\n");
  const delimiters = [",", ";", "\t"];
  const counts = delimiters.map((delimiter) => ({
    delimiter,
    count: sample.split(delimiter).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0]?.count > 0 ? counts[0].delimiter : ",";
}

function parseDelimitedLine(line, delimiter) {
  const values = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === delimiter && !insideQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => compactWhitespace(value));
}

function normalizeHeader(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function findHeaderIndex(headers, aliases) {
  return headers.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
}

function buildTransactionFingerprint({ accountName, transactionDate, description, amountCents, fitId }) {
  if (fitId) return `fit:${fitId}`;
  return [
    normalizeText(accountName || "conta-principal"),
    transactionDate || "sem-data",
    amountCents ?? 0,
    normalizeText(description || "sem-historico"),
  ].join("|");
}

function detectCounterparty(description) {
  const safeDescription = truncateText(description, 120);
  if (!safeDescription) return null;

  const separators = [" - ", " | ", " / ", " pix ", " ted ", " doc "];
  for (const separator of separators) {
    if (safeDescription.toLowerCase().includes(separator.trim())) {
      const [, tail] = safeDescription.split(separator, 2);
      if (tail) return truncateText(tail, 80);
    }
  }

  return null;
}

function categorizeTransaction(transaction) {
  const normalizedDescription = normalizeText(transaction.description);
  const direction = transaction.amountCents >= 0 ? "in" : "out";

  for (const rule of CATEGORY_RULES) {
    if (rule.direction && rule.direction !== direction) continue;
    if (!rule.keywords.some((keyword) => normalizedDescription.includes(normalizeText(keyword)))) continue;
    return {
      category: rule.category,
      subcategory: rule.subcategory,
      reportSection: rule.reportSection,
      isInternalTransfer: rule.isInternalTransfer === true,
      categoryConfidence: rule.confidence,
    };
  }

  if (direction === "in") {
    return {
      category: "Outras Entradas",
      subcategory: "Entrada não classificada",
      reportSection: "other_income",
      isInternalTransfer: false,
      categoryConfidence: 0.45,
    };
  }

  return {
    category: "Não Classificado",
    subcategory: "Saída não classificada",
    reportSection: "uncategorized",
    isInternalTransfer: false,
    categoryConfidence: 0.3,
  };
}

function finalizeParsedTransactions(transactions, metadata = {}) {
  const safeTransactions = (Array.isArray(transactions) ? transactions : [])
    .filter((transaction) => transaction?.transactionDate && transaction?.description && Number.isInteger(transaction?.amountCents))
    .map((transaction, index) => {
      const accountName = compactWhitespace(transaction.accountName || metadata.accountName || metadata.accountId || "Conta principal");
      const classification = categorizeTransaction(transaction);
      return {
        accountName,
        transactionDate: transaction.transactionDate,
        description: truncateText(transaction.description, 240),
        amountCents: transaction.amountCents,
        balanceCents: Number.isInteger(transaction.balanceCents) ? transaction.balanceCents : null,
        direction: transaction.amountCents >= 0 ? "in" : "out",
        category: classification.category,
        subcategory: classification.subcategory,
        reportSection: classification.reportSection,
        categoryConfidence: classification.categoryConfidence,
        isInternalTransfer: classification.isInternalTransfer,
        counterparty: detectCounterparty(transaction.description),
        fitId: truncateText(transaction.fitId, 120) || null,
        reference: truncateText(transaction.reference, 120) || null,
        sourceRowNumber: Number(transaction.sourceRowNumber ?? index + 2),
        fingerprint: buildTransactionFingerprint({
          accountName,
          transactionDate: transaction.transactionDate,
          description: transaction.description,
          amountCents: transaction.amountCents,
          fitId: transaction.fitId,
        }),
      };
    });

  const sortedByDate = safeTransactions.slice().sort((a, b) => {
    if (a.transactionDate === b.transactionDate) return (a.sourceRowNumber || 0) - (b.sourceRowNumber || 0);
    return a.transactionDate < b.transactionDate ? -1 : 1;
  });

  return {
    accountName: compactWhitespace(metadata.accountName || metadata.accountId || "Conta principal"),
    accountId: compactWhitespace(metadata.accountId),
    transactions: sortedByDate,
    dateFrom: sortedByDate[0]?.transactionDate || null,
    dateTo: sortedByDate.at(-1)?.transactionDate || null,
  };
}

function parseCsvStatement(content, metadata = {}) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\ufeff/g, ""))
    .filter((line) => line.trim());

  if (lines.length < 2) {
    throw new Error("O CSV precisa ter cabeçalho e ao menos uma linha de lançamento.");
  }

  const delimiter = detectDelimiter(lines);
  const headers = parseDelimitedLine(lines[0], delimiter).map(normalizeHeader);
  const dateIndex = findHeaderIndex(headers, ["data", "date", "data lancamento", "posted date", "transaction date"]);
  const descriptionIndex = findHeaderIndex(headers, ["descricao", "descrição", "historico", "historico lancamento", "memo", "description", "detalhes", "documento", "name"]);
  const amountIndex = findHeaderIndex(headers, ["valor", "amount", "montante", "valor rs"]);
  const creditIndex = findHeaderIndex(headers, ["credito", "crédito", "entrada", "entradas", "credit"]);
  const debitIndex = findHeaderIndex(headers, ["debito", "débito", "saida", "saidas", "debit"]);
  const balanceIndex = findHeaderIndex(headers, ["saldo", "balance"]);
  const referenceIndex = findHeaderIndex(headers, ["documento", "numero documento", "referencia", "referência", "fitid"]);
  const accountIndex = findHeaderIndex(headers, ["conta", "account"]);

  if (dateIndex < 0 || descriptionIndex < 0 || (amountIndex < 0 && creditIndex < 0 && debitIndex < 0)) {
    throw new Error("Não consegui reconhecer as colunas principais do extrato. Use Data, Descrição e Valor/Crédito/Débito.");
  }

  const transactions = [];
  lines.slice(1).forEach((line, rowIndex) => {
    const values = parseDelimitedLine(line, delimiter);
    const transactionDate = parseFlexibleDate(values[dateIndex]);
    const description = values[descriptionIndex];
    let amountCents = amountIndex >= 0 ? parseMoneyToCents(values[amountIndex]) : null;

    if (!Number.isInteger(amountCents)) {
      const creditCents = creditIndex >= 0 ? parseMoneyToCents(values[creditIndex]) : null;
      const debitCents = debitIndex >= 0 ? parseMoneyToCents(values[debitIndex]) : null;
      if (Number.isInteger(creditCents) || Number.isInteger(debitCents)) {
        amountCents = Math.abs(creditCents || 0) - Math.abs(debitCents || 0);
      }
    }

    if (!transactionDate || !description || !Number.isInteger(amountCents) || amountCents === 0) return;

    transactions.push({
      transactionDate,
      description,
      amountCents,
      balanceCents: balanceIndex >= 0 ? parseMoneyToCents(values[balanceIndex]) : null,
      reference: referenceIndex >= 0 ? values[referenceIndex] : null,
      accountName: accountIndex >= 0 ? values[accountIndex] : metadata.accountName,
      sourceRowNumber: rowIndex + 2,
    });
  });

  if (!transactions.length) {
    throw new Error("Nenhum lançamento financeiro válido foi encontrado no CSV.");
  }

  return finalizeParsedTransactions(transactions, metadata);
}

function extractOfxTag(block, tagName) {
  const regex = new RegExp(`<${tagName}>([^<\\r\\n]+)`, "i");
  return block.match(regex)?.[1]?.trim() || "";
}

function parseOfxStatement(content, metadata = {}) {
  const safeContent = String(content || "");
  const blocks = safeContent.split(/<STMTTRN>/i).slice(1);
  if (!blocks.length) {
    throw new Error("Nenhuma transação OFX foi encontrada no arquivo.");
  }

  const accountId =
    compactWhitespace(extractOfxTag(safeContent, "ACCTID")) ||
    compactWhitespace(metadata.accountId) ||
    null;

  const transactions = blocks.map((block, index) => {
    const postedAt = parseOfxDate(extractOfxTag(block, "DTPOSTED"));
    const amountCents = parseMoneyToCents(extractOfxTag(block, "TRNAMT"));
    const name = extractOfxTag(block, "NAME");
    const memo = extractOfxTag(block, "MEMO");
    const description = truncateText([name, memo].filter(Boolean).join(" • "), 240) || truncateText(name || memo, 240);

    return {
      transactionDate: postedAt,
      description,
      amountCents,
      fitId: extractOfxTag(block, "FITID"),
      reference: extractOfxTag(block, "CHECKNUM"),
      accountName: metadata.accountName || accountId,
      sourceRowNumber: index + 1,
    };
  });

  return finalizeParsedTransactions(transactions, {
    ...metadata,
    accountId,
    accountName: metadata.accountName || accountId || metadata.accountName,
  });
}

function parseStatementFile({ buffer, originalFilename, mimeType, accountName }) {
  const text = decodeFileBuffer(buffer);
  const lowerName = String(originalFilename || "").toLowerCase();
  const looksLikeOfx =
    lowerName.endsWith(".ofx") ||
    String(mimeType || "").toLowerCase().includes("ofx") ||
    /<OFX>|<STMTTRN>/i.test(text);

  const parsed = looksLikeOfx
    ? parseOfxStatement(text, { accountName })
    : parseCsvStatement(text, { accountName });

  return {
    sourceType: looksLikeOfx ? "ofx" : "csv",
    originalFilename: originalFilename || "extrato",
    ...parsed,
  };
}

function monthLabel(isoMonth) {
  const [year, month] = String(isoMonth || "").split("-");
  if (!year || !month) return isoMonth;
  return `${month}/${year}`;
}

function isIsoMonth(value) {
  return /^\d{4}-\d{2}$/.test(String(value || "").trim());
}

function formatShortDate(isoDate) {
  const [year, month, day] = String(isoDate || "").split("-");
  if (!year || !month || !day) return isoDate;
  return `${day}/${month}/${year}`;
}

function sumCents(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function buildAvailableCategories(transactions, dreAccounts = []) {
  const categories = [];
  const seen = new Set();

  function pushCategory(value) {
    const normalized = compactWhitespace(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    categories.push(normalized);
  }

  CATEGORY_OPTIONS.forEach(pushCategory);
  (Array.isArray(transactions) ? transactions : []).forEach((transaction) => pushCategory(transaction?.category));
  (Array.isArray(dreAccounts) ? dreAccounts : []).forEach((account) =>
    (Array.isArray(account?.categories) ? account.categories : []).forEach(pushCategory)
  );

  return categories;
}

function inferDreTypeForCategory(category) {
  const normalized = normalizeText(category);
  if (["receita operacional", "outras entradas"].includes(normalized)) return "income";
  if (["socios e distribuicoes", "investimentos e aplicacoes", "nao classificado"].includes(normalized)) return "other";
  return "expense";
}

function sortDreAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : []).slice().sort((a, b) => {
    const orderDiff = (Number(a?.orderIndex) || 0) - (Number(b?.orderIndex) || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a?.name || "").localeCompare(String(b?.name || ""), "pt-BR", { sensitivity: "base" });
  });
}

function buildSuggestedDreAccounts(categories = CATEGORY_OPTIONS) {
  const availableCategories = new Set((Array.isArray(categories) ? categories : []).map(compactWhitespace).filter(Boolean));
  availableCategories.delete("Transferências Internas");

  const templates = DEFAULT_DRE_ACCOUNT_TEMPLATES
    .filter((entry) => entry.categories.some((category) => availableCategories.has(category)))
    .map((entry) => ({
      name: entry.name,
      type: entry.type,
      orderIndex: entry.orderIndex,
      categories: entry.categories.slice(),
      notes: null,
    }));

  const mappedCategories = new Set(templates.flatMap((entry) => entry.categories));
  Array.from(availableCategories)
    .filter((category) => !mappedCategories.has(category))
    .sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }))
    .forEach((category, index) => {
      templates.push({
        name: category,
        type: inferDreTypeForCategory(category),
        orderIndex: 200 + index * 10,
        categories: [category],
        notes: null,
      });
    });

  return sortDreAccounts(templates);
}

function normalizeMonthFilters(rawMonths) {
  const values = Array.isArray(rawMonths)
    ? rawMonths
    : String(rawMonths || "")
        .split(",")
        .map((value) => value.trim());

  return Array.from(new Set(values.filter(isIsoMonth))).sort((a, b) => (a < b ? -1 : 1));
}

function buildAvailableMonths(transactions) {
  const months = new Map();

  (Array.isArray(transactions) ? transactions : []).forEach((transaction) => {
    const month = String(transaction?.transactionDate || "").slice(0, 7);
    if (!isIsoMonth(month) || months.has(month)) return;
    months.set(month, {
      value: month,
      label: monthLabel(month),
    });
  });

  return Array.from(months.values()).sort((a, b) => (a.value < b.value ? 1 : -1));
}

function buildAvailableAccounts(transactions) {
  return Array.from(
    new Set(
      (Array.isArray(transactions) ? transactions : [])
        .map((transaction) => compactWhitespace(transaction?.accountName))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}

function buildMonthlySeries(transactions) {
  const byMonth = new Map();

  transactions.forEach((transaction) => {
    const month = transaction.transactionDate.slice(0, 7);
    const current = byMonth.get(month) || {
      month,
      label: monthLabel(month),
      inflowsCents: 0,
      outflowsCents: 0,
      netCashCents: 0,
    };

    if (transaction.amountCents >= 0) {
      current.inflowsCents += transaction.amountCents;
    } else {
      current.outflowsCents += Math.abs(transaction.amountCents);
    }
    current.netCashCents += transaction.amountCents;
    byMonth.set(month, current);
  });

  return Array.from(byMonth.values()).sort((a, b) => (a.month < b.month ? -1 : 1));
}

function buildExpenseBreakdown(transactions) {
  const byCategory = new Map();

  transactions
    .filter((transaction) => transaction.amountCents < 0)
    .forEach((transaction) => {
      const current = byCategory.get(transaction.category) || {
        category: transaction.category,
        totalCents: 0,
        transactionsCount: 0,
      };
      current.totalCents += Math.abs(transaction.amountCents);
      current.transactionsCount += 1;
      byCategory.set(transaction.category, current);
    });

  return Array.from(byCategory.values()).sort((a, b) => b.totalCents - a.totalCents);
}

function buildRevenueBreakdown(transactions) {
  const byCategory = new Map();

  transactions
    .filter((transaction) => transaction.amountCents > 0)
    .forEach((transaction) => {
      const current = byCategory.get(transaction.category) || {
        category: transaction.category,
        totalCents: 0,
        transactionsCount: 0,
      };
      current.totalCents += transaction.amountCents;
      current.transactionsCount += 1;
      byCategory.set(transaction.category, current);
    });

  return Array.from(byCategory.values()).sort((a, b) => b.totalCents - a.totalCents);
}

function buildDefaultDreRows(transactions) {
  const rows = [
    { label: "Receita Operacional", amountCents: 0 },
    { label: "Outras Entradas", amountCents: 0 },
    { label: "Folha e Pessoas", amountCents: 0 },
    { label: "Impostos", amountCents: 0 },
    { label: "Marketing", amountCents: 0 },
    { label: "Tecnologia", amountCents: 0 },
    { label: "Serviços e Softwares", amountCents: 0 },
    { label: "Aluguel e Infraestrutura", amountCents: 0 },
    { label: "Operações e Fornecedores", amountCents: 0 },
    { label: "Viagens e Mobilidade", amountCents: 0 },
    { label: "Tarifas Bancárias", amountCents: 0 },
    { label: "Capex", amountCents: 0 },
    { label: "Sócios e Distribuições", amountCents: 0 },
    { label: "Não Classificado", amountCents: 0 },
  ];

  const rowMap = new Map(rows.map((row) => [row.label, row]));
  transactions.forEach((transaction) => {
    const row = rowMap.get(transaction.category) || rowMap.get("Não Classificado");
    row.amountCents += transaction.amountCents;
  });

  const revenue = (rowMap.get("Receita Operacional")?.amountCents || 0) + (rowMap.get("Outras Entradas")?.amountCents || 0);
  const expenses = sumCents(
    rows
      .filter((row) => !["Receita Operacional", "Outras Entradas"].includes(row.label))
      .map((row) => row.amountCents)
  );

  rows.push({ label: "Resultado Caixa Aproximado", amountCents: revenue + expenses });
  return rows;
}

function buildConfiguredDreRows(transactions, dreAccounts) {
  const sortedAccounts = sortDreAccounts(dreAccounts).map((account) => ({
    name: compactWhitespace(account?.name) || "Conta DRE",
    type: ["income", "expense", "other"].includes(account?.type) ? account.type : "expense",
    orderIndex: Number.isFinite(Number(account?.orderIndex)) ? Math.trunc(Number(account.orderIndex)) : 999,
    categories: Array.from(
      new Set((Array.isArray(account?.categories) ? account.categories : []).map(compactWhitespace).filter(Boolean))
    ),
  }));

  if (!sortedAccounts.length) return buildDefaultDreRows(transactions);

  const rows = sortedAccounts.map((account) => ({
    label: account.name,
    amountCents: sumCents(
      transactions
        .filter((transaction) => account.categories.includes(transaction.category))
        .map((transaction) => transaction.amountCents)
    ),
  }));

  const mappedCategories = new Set(sortedAccounts.flatMap((account) => account.categories));
  const unmappedTransactions = transactions.filter((transaction) => !mappedCategories.has(transaction.category));
  if (unmappedTransactions.length) {
    rows.push({
      label: "Não Mapeado no Plano DRE",
      amountCents: sumCents(unmappedTransactions.map((transaction) => transaction.amountCents)),
    });
  }

  rows.push({
    label: "Resultado Caixa Aproximado",
    amountCents: sumCents(rows.map((row) => row.amountCents)),
  });

  return rows;
}

function buildDreRows(transactions, dreAccounts = []) {
  return Array.isArray(dreAccounts) && dreAccounts.length
    ? buildConfiguredDreRows(transactions, dreAccounts)
    : buildDefaultDreRows(transactions);
}

function buildDreReconciliation({ dreAccounts = [], categories = [], transactions = [] } = {}) {
  const availableCategories = new Set(
    buildAvailableCategories(transactions, dreAccounts)
      .concat(Array.isArray(categories) ? categories : [])
      .map(compactWhitespace)
      .filter(Boolean)
  );
  availableCategories.delete("Transferências Internas");

  const mappedCategories = new Set(
    sortDreAccounts(dreAccounts).flatMap((account) =>
      (Array.isArray(account?.categories) ? account.categories : []).map(compactWhitespace).filter(Boolean)
    )
  );

  const unmappedCategories = Array.from(availableCategories)
    .filter((category) => !mappedCategories.has(category))
    .sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));

  return {
    accountsCount: Array.isArray(dreAccounts) ? dreAccounts.length : 0,
    totalCategories: availableCategories.size,
    mappedCategoriesCount: Array.from(availableCategories).filter((category) => mappedCategories.has(category)).length,
    unmappedCategoriesCount: unmappedCategories.length,
    unmappedCategories,
  };
}

function getLatestCashPosition(transactions) {
  const balancesByAccount = new Map();

  transactions.forEach((transaction) => {
    if (!Number.isInteger(transaction.balanceCents)) return;
    const current = balancesByAccount.get(transaction.accountName);
    if (!current || current.transactionDate < transaction.transactionDate) {
      balancesByAccount.set(transaction.accountName, transaction);
    }
  });

  const latestBalances = Array.from(balancesByAccount.values());
  return {
    accountsCount: latestBalances.length,
    cashPositionCents: sumCents(latestBalances.map((entry) => entry.balanceCents)),
  };
}

function buildInsights(transactions, monthlySeries, expenseBreakdown, revenueBreakdown, context = {}) {
  if (!transactions.length) {
    if (
      context.hasAnyTransactions &&
      (context.accountName || (Array.isArray(context.months) && context.months.length) || context.from || context.to)
    ) {
      return ["Nenhum lançamento encontrado para os filtros selecionados."];
    }
    return ["Importe pelo menos um extrato para começar a análise financeira."];
  }

  const insights = [];
  const latestMonth = monthlySeries.at(-1);
  const worstMonth = monthlySeries.slice().sort((a, b) => a.netCashCents - b.netCashCents)[0];
  const biggestExpense = expenseBreakdown[0];
  const biggestRevenue = revenueBreakdown[0];
  const internalTransfers = transactions.filter((transaction) => transaction.isInternalTransfer).length;

  if (latestMonth) {
    insights.push(
      latestMonth.netCashCents >= 0
        ? `No período mais recente (${latestMonth.label}), as entradas superaram as saídas em ${formatCurrencyBRL(latestMonth.netCashCents)}.`
        : `No período mais recente (${latestMonth.label}), o caixa ficou negativo em ${formatCurrencyBRL(Math.abs(latestMonth.netCashCents))}.`
    );
  }

  if (biggestExpense) {
    insights.push(
      `A maior pressão de caixa veio de ${biggestExpense.category}, somando ${formatCurrencyBRL(biggestExpense.totalCents)} no período analisado.`
    );
  }

  if (biggestRevenue) {
    insights.push(
      `A principal origem de entradas foi ${biggestRevenue.category}, com ${formatCurrencyBRL(biggestRevenue.totalCents)} no período.`
    );
  }

  if (worstMonth && monthlySeries.length > 1) {
    insights.push(
      `O mês com pior resultado foi ${worstMonth.label}, com saldo líquido de ${formatCurrencyBRL(worstMonth.netCashCents)}.`
    );
  }

  if (internalTransfers) {
    insights.push(
      `${internalTransfers} movimentação(ões) foram classificadas como transferências internas e ficaram fora da DRE caixa para evitar dupla contagem.`
    );
  }

  return insights;
}

function filterTransactions(transactions, { from, to, months, accountName } = {}) {
  const allowedMonths = normalizeMonthFilters(months);
  const monthSet = allowedMonths.length ? new Set(allowedMonths) : null;
  const normalizedAccountName = normalizeText(accountName);

  return (Array.isArray(transactions) ? transactions : []).filter((transaction) => {
    if (monthSet && !monthSet.has(String(transaction.transactionDate || "").slice(0, 7))) return false;
    if (normalizedAccountName && normalizeText(transaction.accountName) !== normalizedAccountName) return false;
    if (from && transaction.transactionDate < from) return false;
    if (to && transaction.transactionDate > to) return false;
    return true;
  });
}

function filterTransactionsByRange(transactions, { from, to } = {}) {
  return filterTransactions(transactions, { from, to });
}

function resolveSuggestedRange(transactions, from, to) {
  if (from || to) return { from: from || null, to: to || null };
  const sorted = transactions
    .slice()
    .sort((a, b) => (a.transactionDate < b.transactionDate ? -1 : 1));
  return {
    from: sorted[0]?.transactionDate || null,
    to: sorted.at(-1)?.transactionDate || null,
  };
}

function createTableSection(title, columns, rows) {
  return { title, columns, rows };
}

function buildReportType(prompt) {
  const normalizedPrompt = normalizeText(prompt || "visao geral");
  const found = REPORT_KEYWORDS.find((entry) =>
    entry.keywords.some((keyword) => normalizedPrompt.includes(normalizeText(keyword)))
  );
  return found?.type || "overview";
}

function buildPeriodLabel(range, transactionsCount) {
  if (range.from && range.to) return `${formatShortDate(range.from)} a ${formatShortDate(range.to)}`;
  if (range.from) return `A partir de ${formatShortDate(range.from)}`;
  if (range.to) return `Até ${formatShortDate(range.to)}`;
  return transactionsCount ? "Todo o histórico" : "Sem dados";
}

function buildFpaOverview(transactions, options = {}) {
  const scopedTransactions = filterTransactions(transactions, {
    months: options.months,
    accountName: options.accountName,
  });
  const range = resolveSuggestedRange(scopedTransactions, options.from, options.to);
  const inRange = filterTransactions(scopedTransactions, range);
  const reportable = inRange.filter((transaction) => !transaction.isInternalTransfer);
  const monthlySeries = buildMonthlySeries(reportable);
  const expenseBreakdown = buildExpenseBreakdown(reportable);
  const revenueBreakdown = buildRevenueBreakdown(reportable);
  const expenseMonths = monthlySeries.map((month) => month.outflowsCents).filter((value) => value > 0);
  const negativeMonths = monthlySeries.filter((month) => month.netCashCents < 0);
  const cashPosition = getLatestCashPosition(inRange);

  return {
    period: {
      from: range.from,
      to: range.to,
      label: buildPeriodLabel(range, inRange.length),
    },
    transactionsCount: inRange.length,
    reportableTransactionsCount: reportable.length,
    internalTransfersCount: inRange.length - reportable.length,
    inflowsCents: sumCents(reportable.filter((transaction) => transaction.amountCents > 0).map((transaction) => transaction.amountCents)),
    outflowsCents: sumCents(reportable.filter((transaction) => transaction.amountCents < 0).map((transaction) => Math.abs(transaction.amountCents))),
    netCashCents: sumCents(reportable.map((transaction) => transaction.amountCents)),
    averageMonthlyExpensesCents: expenseMonths.length ? Math.round(sumCents(expenseMonths) / expenseMonths.length) : 0,
    averageMonthlyBurnCents: negativeMonths.length
      ? Math.round(sumCents(negativeMonths.map((month) => Math.abs(month.netCashCents))) / negativeMonths.length)
      : 0,
    latestKnownCashCents: cashPosition.cashPositionCents,
    accountsWithBalance: cashPosition.accountsCount,
    expenseBreakdown,
    revenueBreakdown,
    monthlySeries,
    insights: buildInsights(inRange, monthlySeries, expenseBreakdown, revenueBreakdown, {
      hasAnyTransactions: Array.isArray(transactions) && transactions.length > 0,
      months: options.months,
      accountName: options.accountName,
      from: options.from,
      to: options.to,
    }),
  };
}

function buildRequestedFpaReport({ transactions, prompt, from, to, months, accountName, dreAccounts = [] }) {
  const overview = buildFpaOverview(transactions, { from, to, months, accountName });
  const reportType = buildReportType(prompt);
  const filteredTransactions = filterTransactions(transactions, {
    from: overview.period.from,
    to: overview.period.to,
    months,
    accountName,
  });
  const reportableTransactions = filteredTransactions.filter((transaction) => !transaction.isInternalTransfer);
  const monthlySeries = overview.monthlySeries;
  const expenseBreakdown = overview.expenseBreakdown;
  const revenueBreakdown = overview.revenueBreakdown;
  const latestTransactions = filteredTransactions
    .slice()
    .sort((a, b) => {
      if (a.transactionDate === b.transactionDate) return (b.createdAt || "").localeCompare(a.createdAt || "");
      return a.transactionDate < b.transactionDate ? 1 : -1;
    })
    .slice(0, 12)
    .map((transaction) => ({
      date: formatShortDate(transaction.transactionDate),
      description: transaction.description,
      category: transaction.category,
      amountCents: transaction.amountCents,
      accountName: transaction.accountName,
    }));

  const sections = [];
  let title = "Visão Geral de FP&A";
  let summaryText = "Resumo gerencial de caixa com base nos extratos importados.";

  if (!overview.transactionsCount) {
    return {
      reportType,
      prompt: compactWhitespace(prompt || "visão geral"),
      title: "Sem dados para o recorte selecionado",
      summaryText:
        Array.isArray(transactions) && transactions.length
          ? "A conta e/ou os meses selecionados não possuem lançamentos dentro do recorte informado."
          : "Assim que houver extratos importados, o sistema monta a leitura gerencial automaticamente.",
      overview,
      insights: overview.insights,
      sections: [],
    };
  }

  if (reportType === "cash_flow" || reportType === "overview" || reportType === "burn") {
    sections.push(
      createTableSection(
        "Fluxo de Caixa por Mês",
        [
          { key: "label", label: "Mês", type: "text" },
          { key: "inflowsCents", label: "Entradas", type: "currency" },
          { key: "outflowsCents", label: "Saídas", type: "currency" },
          { key: "netCashCents", label: "Saldo Líquido", type: "currency" },
        ],
        monthlySeries
      )
    );
  }

  if (reportType === "expenses" || reportType === "overview" || reportType === "burn") {
    sections.push(
      createTableSection(
        "Despesas por Categoria",
        [
          { key: "category", label: "Categoria", type: "text" },
          { key: "transactionsCount", label: "Lançamentos", type: "number" },
          { key: "totalCents", label: "Total", type: "currency" },
        ],
        expenseBreakdown.slice(0, 12)
      )
    );
  }

  if (reportType === "revenue" || reportType === "overview") {
    sections.push(
      createTableSection(
        "Entradas por Categoria",
        [
          { key: "category", label: "Categoria", type: "text" },
          { key: "transactionsCount", label: "Lançamentos", type: "number" },
          { key: "totalCents", label: "Total", type: "currency" },
        ],
        revenueBreakdown.slice(0, 10)
      )
    );
  }

  if (reportType === "dre" || reportType === "overview") {
    sections.push(
      createTableSection(
        "DRE Caixa Aproximada",
        [
          { key: "label", label: "Linha", type: "text" },
          { key: "amountCents", label: "Valor", type: "currency" },
        ],
        buildDreRows(reportableTransactions, dreAccounts)
      )
    );
  }

  sections.push(
    createTableSection(
      "Lançamentos Recentes",
      [
        { key: "date", label: "Data", type: "text" },
        { key: "description", label: "Histórico", type: "text" },
        { key: "category", label: "Categoria", type: "text" },
        { key: "accountName", label: "Conta", type: "text" },
        { key: "amountCents", label: "Valor", type: "currency" },
      ],
      latestTransactions
    )
  );

  if (reportType === "cash_flow") {
    title = "Fluxo de Caixa";
    summaryText = "Entradas, saídas e saldo líquido organizados por mês.";
  } else if (reportType === "expenses") {
    title = "Despesas por Categoria";
    summaryText = "Mapa de custos para identificar onde o caixa está sendo consumido.";
  } else if (reportType === "dre") {
    title = "DRE Caixa Aproximada";
    summaryText = Array.isArray(dreAccounts) && dreAccounts.length
      ? "Leitura gerencial do resultado conciliada com o plano de contas DRE cadastrado."
      : "Leitura gerencial do resultado a partir do que efetivamente entrou e saiu do banco.";
  } else if (reportType === "burn") {
    title = "Burn Rate";
    summaryText = "Análise da queima de caixa e do ritmo médio de consumo mensal.";
  } else if (reportType === "revenue") {
    title = "Análise de Entradas";
    summaryText = "Consolidação das principais origens de entrada de caixa.";
  }

  return {
    reportType,
    prompt: compactWhitespace(prompt || "visão geral"),
    title,
    summaryText,
    overview,
    insights: overview.insights,
    sections,
  };
}

module.exports = {
  CATEGORY_OPTIONS,
  DRE_TYPE_OPTIONS,
  buildAvailableCategories,
  buildAvailableAccounts,
  buildAvailableMonths,
  buildDreReconciliation,
  buildFpaOverview,
  buildRequestedFpaReport,
  buildSuggestedDreAccounts,
  buildTransactionFingerprint,
  filterTransactions,
  filterTransactionsByRange,
  normalizeMonthFilters,
  parseStatementFile,
};
