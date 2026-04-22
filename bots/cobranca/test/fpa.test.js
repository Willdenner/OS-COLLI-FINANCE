const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildAvailableAccounts,
  buildAvailableMonths,
  buildFpaOverview,
  buildRequestedFpaReport,
  parseStatementFile,
} = require("../src/lib/fpa");

async function createTempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wa-fpa-test-"));
}

function loadFreshStore(dataDir) {
  process.env.BOT_DATA_DIR = dataDir;
  delete require.cache[require.resolve("../src/lib/store")];
  delete require.cache[require.resolve("../src/lib/domain")];
  delete require.cache[require.resolve("../src/lib/fpa")];
  return require("../src/lib/store");
}

test("importa extrato CSV com crédito e débito e categoriza lançamentos", () => {
  const csv = [
    "Data;Descrição;Crédito;Débito;Saldo",
    "01/04/2026;PIX RECEBIDO CLIENTE ACME;1.500,00;;10.000,00",
    "02/04/2026;GOOGLE ADS;;250,90;9.749,10",
  ].join("\n");

  const parsed = parseStatementFile({
    buffer: Buffer.from(csv, "utf8"),
    originalFilename: "extrato.csv",
    mimeType: "text/csv",
    accountName: "Conta Principal",
  });

  assert.equal(parsed.sourceType, "csv");
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0].amountCents, 150000);
  assert.equal(parsed.transactions[0].category, "Receita Operacional");
  assert.equal(parsed.transactions[1].amountCents, -25090);
  assert.equal(parsed.transactions[1].category, "Marketing");
});

test("importa extrato OFX e reconhece categoria de tecnologia", () => {
  const ofx = `
    <OFX>
      <BANKACCTFROM><ACCTID>9988</ACCTID></BANKACCTFROM>
      <BANKTRANLIST>
        <STMTTRN>
          <TRNTYPE>DEBIT
          <DTPOSTED>20260402120000[-3:BRT]
          <TRNAMT>-129.90
          <FITID>abc123
          <NAME>OPENAI
          <MEMO>OPENAI API BILLING
        </STMTTRN>
      </BANKTRANLIST>
    </OFX>
  `;

  const parsed = parseStatementFile({
    buffer: Buffer.from(ofx, "utf8"),
    originalFilename: "extrato.ofx",
    mimeType: "application/x-ofx",
    accountName: "Conta Operacional",
  });

  assert.equal(parsed.sourceType, "ofx");
  assert.equal(parsed.transactions.length, 1);
  assert.equal(parsed.transactions[0].transactionDate, "2026-04-02");
  assert.equal(parsed.transactions[0].amountCents, -12990);
  assert.equal(parsed.transactions[0].category, "Tecnologia");
});

test("gera relatório DRE e visão geral de caixa a partir das transações", () => {
  const transactions = [
    {
      accountName: "Conta A",
      transactionDate: "2026-04-01",
      description: "PIX RECEBIDO CLIENTE ALFA",
      amountCents: 200000,
      category: "Receita Operacional",
      reportSection: "revenue",
      isInternalTransfer: false,
    },
    {
      accountName: "Conta A",
      transactionDate: "2026-04-03",
      description: "GOOGLE ADS",
      amountCents: -80000,
      category: "Marketing",
      reportSection: "marketing",
      isInternalTransfer: false,
    },
    {
      accountName: "Conta A",
      transactionDate: "2026-04-05",
      description: "FOLHA SALARIAL",
      amountCents: -50000,
      category: "Folha e Pessoas",
      reportSection: "payroll",
      isInternalTransfer: false,
    },
  ];

  const overview = buildFpaOverview(transactions, { from: "2026-04-01", to: "2026-04-30" });
  assert.equal(overview.inflowsCents, 200000);
  assert.equal(overview.outflowsCents, 130000);
  assert.equal(overview.netCashCents, 70000);

  const report = buildRequestedFpaReport({
    transactions,
    prompt: "Quero uma DRE do período",
    from: "2026-04-01",
    to: "2026-04-30",
  });

  assert.equal(report.reportType, "dre");
  assert(report.sections.some((section) => section.title === "DRE Caixa Aproximada"));
  assert.equal(report.overview.netCashCents, 70000);
});

test("usa o plano de contas DRE cadastrado para conciliar a DRE caixa", () => {
  const transactions = [
    {
      accountName: "Conta A",
      transactionDate: "2026-04-01",
      description: "PIX RECEBIDO CLIENTE ALFA",
      amountCents: 200000,
      category: "Receita Operacional",
      reportSection: "revenue",
      isInternalTransfer: false,
    },
    {
      accountName: "Conta A",
      transactionDate: "2026-04-03",
      description: "GOOGLE ADS",
      amountCents: -80000,
      category: "Marketing",
      reportSection: "marketing",
      isInternalTransfer: false,
    },
    {
      accountName: "Conta A",
      transactionDate: "2026-04-05",
      description: "FOLHA SALARIAL",
      amountCents: -50000,
      category: "Folha e Pessoas",
      reportSection: "payroll",
      isInternalTransfer: false,
    },
  ];

  const report = buildRequestedFpaReport({
    transactions,
    prompt: "Quero uma DRE do período",
    from: "2026-04-01",
    to: "2026-04-30",
    dreAccounts: [
      {
        name: "Receita de Clientes",
        type: "income",
        orderIndex: 10,
        categories: ["Receita Operacional"],
      },
      {
        name: "CAC Pago",
        type: "expense",
        orderIndex: 20,
        categories: ["Marketing"],
      },
    ],
  });

  const dreSection = report.sections.find((section) => section.title === "DRE Caixa Aproximada");
  assert.match(report.summaryText, /plano de contas DRE cadastrado/i);
  assert.deepEqual(dreSection.rows, [
    { label: "Receita de Clientes", amountCents: 200000 },
    { label: "CAC Pago", amountCents: -80000 },
    { label: "Não Mapeado no Plano DRE", amountCents: -50000 },
    { label: "Resultado Caixa Aproximado", amountCents: 70000 },
  ]);
});

test("filtra a análise por meses específicos e por conta", () => {
  const transactions = [
    {
      accountName: "Conta A",
      transactionDate: "2026-04-01",
      description: "PIX RECEBIDO CLIENTE ALFA",
      amountCents: 200000,
      category: "Receita Operacional",
      reportSection: "revenue",
      isInternalTransfer: false,
    },
    {
      accountName: "Conta A",
      transactionDate: "2026-05-03",
      description: "GOOGLE ADS",
      amountCents: -80000,
      category: "Marketing",
      reportSection: "marketing",
      isInternalTransfer: false,
    },
    {
      accountName: "Conta B",
      transactionDate: "2026-05-05",
      description: "PIX RECEBIDO CLIENTE BETA",
      amountCents: 120000,
      category: "Receita Operacional",
      reportSection: "revenue",
      isInternalTransfer: false,
    },
  ];

  const overview = buildFpaOverview(transactions, {
    months: ["2026-05"],
    accountName: "Conta A",
  });

  assert.equal(overview.transactionsCount, 1);
  assert.equal(overview.inflowsCents, 0);
  assert.equal(overview.outflowsCents, 80000);
  assert.equal(overview.netCashCents, -80000);
  assert.deepEqual(buildAvailableAccounts(transactions), ["Conta A", "Conta B"]);
  assert.deepEqual(buildAvailableMonths(transactions), [
    { value: "2026-05", label: "05/2026" },
    { value: "2026-04", label: "04/2026" },
  ]);

  const report = buildRequestedFpaReport({
    transactions,
    prompt: "Quero um fluxo de caixa",
    months: ["2026-05"],
    accountName: "Conta A",
  });

  assert.equal(report.reportType, "cash_flow");
  assert.equal(report.overview.transactionsCount, 1);
  assert.deepEqual(report.sections[0].rows, [
    {
      month: "2026-05",
      label: "05/2026",
      inflowsCents: 0,
      outflowsCents: 80000,
      netCashCents: -80000,
    },
  ]);
});

test("retorna estado vazio quando a conta filtrada não tem lançamentos", () => {
  const transactions = [
    {
      accountName: "Conta Principal",
      transactionDate: "2026-04-01",
      description: "PIX RECEBIDO CLIENTE ACME",
      amountCents: 150000,
      category: "Receita Operacional",
      reportSection: "revenue",
      isInternalTransfer: false,
    },
  ];

  const overview = buildFpaOverview(transactions, {
    accountName: "Conta Inexistente",
  });
  const report = buildRequestedFpaReport({
    transactions,
    prompt: "Quero uma DRE do período",
    accountName: "Conta Inexistente",
  });

  assert.equal(overview.transactionsCount, 0);
  assert.equal(overview.period.label, "Sem dados");
  assert.match(overview.insights[0], /Nenhum lançamento encontrado para os filtros selecionados/i);
  assert.equal(report.title, "Sem dados para o recorte selecionado");
  assert.equal(report.sections.length, 0);
});

test("deduplica lançamentos financeiros ao importar o mesmo extrato duas vezes", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  const transactions = [
    {
      accountName: "Conta Principal",
      transactionDate: "2026-04-01",
      description: "PIX RECEBIDO CLIENTE ACME",
      amountCents: 150000,
      category: "Receita Operacional",
      reportSection: "revenue",
      fingerprint: "conta|2026-04-01|150000|pix recebido cliente acme",
    },
    {
      accountName: "Conta Principal",
      transactionDate: "2026-04-02",
      description: "GOOGLE ADS",
      amountCents: -25090,
      category: "Marketing",
      reportSection: "marketing",
      fingerprint: "conta|2026-04-02|-25090|google ads",
    },
  ];

  const firstImport = await store.createFpaImport({
    sourceType: "csv",
    originalFilename: "abril.csv",
    accountName: "Conta Principal",
    transactions,
  });
  const secondImport = await store.createFpaImport({
    sourceType: "csv",
    originalFilename: "abril.csv",
    accountName: "Conta Principal",
    transactions,
  });

  const savedTransactions = await store.listFpaTransactions({ limit: 20 });
  const imports = await store.listFpaImports();

  assert.equal(firstImport.importedTransactions.length, 2);
  assert.equal(secondImport.importedTransactions.length, 0);
  assert.equal(secondImport.duplicateCount, 2);
  assert.equal(savedTransactions.length, 2);
  assert.equal(imports.length, 2);
});

test("exclui uma conta financeira removendo imports e lançamentos associados", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.createFpaImport({
    sourceType: "csv",
    originalFilename: "conta-a.csv",
    accountName: "Conta Teste A",
    transactions: [
      {
        accountName: "Conta Teste A",
        transactionDate: "2026-04-01",
        description: "PIX RECEBIDO CLIENTE A",
        amountCents: 100000,
        category: "Receita Operacional",
        reportSection: "revenue",
        fingerprint: "conta-teste-a|2026-04-01|100000|pix recebido cliente a",
      },
    ],
  });

  await store.createFpaImport({
    sourceType: "csv",
    originalFilename: "conta-b.csv",
    accountName: "Conta Teste B",
    transactions: [
      {
        accountName: "Conta Teste B",
        transactionDate: "2026-04-02",
        description: "GOOGLE ADS",
        amountCents: -25090,
        category: "Marketing",
        reportSection: "marketing",
        fingerprint: "conta-teste-b|2026-04-02|-25090|google ads",
      },
    ],
  });

  const deleted = await store.deleteFpaAccount("Conta Teste A");
  const remainingTransactions = await store.listFpaTransactions({ limit: 20 });
  const remainingImports = await store.listFpaImports();

  assert.deepEqual(deleted, {
    accountName: "Conta Teste A",
    deletedImports: 1,
    deletedTransactions: 1,
  });
  assert.equal(remainingTransactions.length, 1);
  assert.equal(remainingTransactions[0].accountName, "Conta Teste B");
  assert.equal(remainingImports.length, 1);
  assert.equal(remainingImports[0].accountName, "Conta Teste B");
});

test("cria e atualiza contas DRE evitando categoria duplicada", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  const created = await store.createFpaDreAccount({
    name: "Receita SaaS",
    type: "income",
    orderIndex: 10,
    categories: ["Receita Operacional"],
    notes: "Conta principal de receita",
  });

  await assert.rejects(
    () =>
      store.createFpaDreAccount({
        name: "Receita Duplicada",
        type: "income",
        orderIndex: 20,
        categories: ["Receita Operacional"],
      }),
    /já está vinculada/i
  );

  const updated = await store.updateFpaDreAccount(created.id, {
    name: "Receita Recorrente",
    categories: ["Receita Operacional", "Outras Entradas"],
  });
  const listed = await store.listFpaDreAccounts();
  const deleted = await store.deleteFpaDreAccount(created.id);

  assert.equal(listed.length, 1);
  assert.equal(updated.name, "Receita Recorrente");
  assert.deepEqual(updated.categories, ["Receita Operacional", "Outras Entradas"]);
  assert.equal(deleted.id, created.id);
  assert.equal((await store.listFpaDreAccounts()).length, 0);
});

test("atualiza categoria financeira individual sem voltar para o valor original", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.createFpaImport({
    sourceType: "csv",
    originalFilename: "categoria-individual.csv",
    accountName: "Conta Operacional",
    transactions: [
      {
        accountName: "Conta Operacional",
        transactionDate: "2026-04-01",
        description: "GOOGLE ADS",
        amountCents: -25090,
        category: "Marketing",
        reportSection: "marketing",
        fingerprint: "conta-operacional|2026-04-01|-25090|google ads",
      },
    ],
  });

  const transaction = (await store.listFpaTransactions({ limit: 10 }))[0];
  const updated = await store.updateFpaTransaction(transaction.id, {
    category: "Tecnologia",
    isInternalTransfer: false,
  });
  const refreshed = (await store.listFpaTransactions({ limit: 10 })).find((entry) => entry.id === transaction.id);

  assert.equal(updated.category, "Tecnologia");
  assert.equal(refreshed.category, "Tecnologia");
  assert.equal(refreshed.isInternalTransfer, false);
});

test("salva categorias financeiras em massa", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.createFpaImport({
    sourceType: "csv",
    originalFilename: "categorias-em-lote.csv",
    accountName: "Conta Operacional",
    transactions: [
      {
        accountName: "Conta Operacional",
        transactionDate: "2026-04-01",
        description: "GOOGLE ADS",
        amountCents: -25090,
        category: "Marketing",
        reportSection: "marketing",
        fingerprint: "conta-operacional|2026-04-01|-25090|google ads",
      },
      {
        accountName: "Conta Operacional",
        transactionDate: "2026-04-02",
        description: "PIX ENTRE CONTAS",
        amountCents: -50000,
        category: "Não Classificado",
        reportSection: "uncategorized",
        fingerprint: "conta-operacional|2026-04-02|-50000|pix entre contas",
      },
    ],
  });

  const transactions = await store.listFpaTransactions({ limit: 10 });
  const updated = await store.updateFpaTransactionsBatch([
    {
      id: transactions[0].id,
      category: "Tecnologia",
      isInternalTransfer: false,
    },
    {
      id: transactions[1].id,
      category: "Transferências Internas",
      isInternalTransfer: true,
    },
  ]);
  const refreshed = await store.listFpaTransactions({ limit: 10 });

  assert.equal(updated.length, 2);
  assert.equal(refreshed.find((entry) => entry.id === transactions[0].id)?.category, "Tecnologia");
  assert.equal(refreshed.find((entry) => entry.id === transactions[1].id)?.category, "Transferências Internas");
  assert.equal(refreshed.find((entry) => entry.id === transactions[1].id)?.isInternalTransfer, true);
});

test("exclui um lançamento financeiro específico e remove o import quando ele fica vazio", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  const createdImport = await store.createFpaImport({
    sourceType: "csv",
    originalFilename: "conta-unica.csv",
    accountName: "Conta Única",
    transactions: [
      {
        accountName: "Conta Única",
        transactionDate: "2026-04-01",
        description: "PIX RECEBIDO CLIENTE TESTE",
        amountCents: 100000,
        category: "Receita Operacional",
        reportSection: "revenue",
        fingerprint: "conta-unica|2026-04-01|100000|pix recebido cliente teste",
      },
    ],
  });

  const transaction = (await store.listFpaTransactions({ limit: 10 }))[0];
  const deleted = await store.deleteFpaTransaction(transaction.id);
  const remainingTransactions = await store.listFpaTransactions({ limit: 10 });
  const remainingImports = await store.listFpaImports();

  assert.deepEqual(deleted, {
    transactionId: transaction.id,
    accountName: "Conta Única",
    importId: createdImport.importRecord.id,
    deletedImportId: createdImport.importRecord.id,
  });
  assert.equal(remainingTransactions.length, 0);
  assert.equal(remainingImports.length, 0);
});
