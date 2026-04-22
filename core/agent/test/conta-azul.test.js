const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  applyContaAzulTokenPayload,
  buildContaAzulAcquittancePath,
  buildContaAzulAcquittanceRecord,
  buildContaAzulAuthorizationUrl,
  buildContaAzulContractRecord,
  buildContaAzulFinancialAccountsPath,
  buildContaAzulFinancialCategoriesPath,
  buildContaAzulFinancialEventsSearchPath,
  buildContaAzulFpaExportPayload,
  buildContaAzulPeoplePath,
  buildContaAzulTestFinancialEventRecord,
  mergeContaAzulSettings,
  normalizeContaAzulAcquittanceResponse,
  normalizeContaAzulAuthorizationCode,
  normalizeContaAzulContractResponse,
  normalizeContaAzulFinancialAccount,
  normalizeContaAzulFinancialCategory,
  normalizeContaAzulFinancialInstallment,
  normalizeContaAzulListItems,
  normalizeContaAzulPerson,
  reconcileContaAzulFinancialRecords,
  sanitizeContaAzulSettings,
} = require("../src/lib/conta-azul");

async function createTempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wa-caz-test-"));
}

function loadFreshStore(dataDir) {
  process.env.BOT_DATA_DIR = dataDir;
  delete require.cache[require.resolve("../src/lib/store")];
  delete require.cache[require.resolve("../src/lib/domain")];
  delete require.cache[require.resolve("../src/lib/conta-azul")];
  return require("../src/lib/store");
}

test("preserva segredos do Conta Azul quando o patch chega sem novos valores", () => {
  const current = {
    clientId: "client_123",
    clientSecret: "secret_app",
    redirectUri: "https://localhost/callback",
    authMode: "bearer",
    accessToken: "token_atual",
    refreshToken: "refresh_atual",
    customHeaderName: "x-ca",
    customHeaderValue: "header_atual",
  };

  const merged = mergeContaAzulSettings(current, {
    clientSecret: "",
    accessToken: "",
    refreshToken: "",
    customHeaderValue: "",
    accountLabel: "Conta principal",
  });

  const sanitized = sanitizeContaAzulSettings(merged);

  assert.equal(merged.clientSecret, "secret_app");
  assert.equal(merged.accessToken, "token_atual");
  assert.equal(merged.refreshToken, "refresh_atual");
  assert.equal(merged.customHeaderValue, "header_atual");
  assert.equal(sanitized.hasClientSecret, true);
  assert.equal(sanitized.hasAccessToken, true);
  assert.equal(sanitized.hasRefreshToken, true);
  assert.equal(sanitized.hasCustomHeaderValue, true);

  const cleared = mergeContaAzulSettings(merged, {
    clearClientSecret: true,
    clearAccessToken: true,
    clearRefreshToken: true,
    clearCustomHeaderValue: true,
  });
  assert.equal(cleared.clientSecret, "");
  assert.equal(cleared.accessToken, "");
  assert.equal(cleared.refreshToken, "");
  assert.equal(cleared.customHeaderValue, "");
});

test("preserva e mascara o segredo dos webhooks Lovable", async () => {
  const previousEnvSecret = process.env.LOVABLE_WEBHOOK_SECRET;
  delete process.env.LOVABLE_WEBHOOK_SECRET;

  try {
    const dataDir = await createTempDataDir();
    const store = loadFreshStore(dataDir);

    await store.updateSettings({
      lovable: {
        enabled: true,
        webhookSecret: "secret_lovable",
      },
    });
    await store.updateSettings({
      lovable: {
        enabled: true,
        webhookSecret: "",
      },
    });

    const settings = await store.getSettings();
    const sanitized = store.sanitizeLovableSettings(settings.lovable);

    assert.equal(settings.lovable.enabled, true);
    assert.equal(settings.lovable.webhookSecret, "secret_lovable");
    assert.equal(sanitized.hasWebhookSecret, true);
    assert.equal(sanitized.hasStoredWebhookSecret, true);
    assert.equal(sanitized.integrationEnabled, true);
    assert.equal("webhookSecret" in sanitized, false);
  } finally {
    if (previousEnvSecret == null) {
      delete process.env.LOVABLE_WEBHOOK_SECRET;
    } else {
      process.env.LOVABLE_WEBHOOK_SECRET = previousEnvSecret;
    }
  }
});

test("recarrega configuracoes de Conta Azul e Lovable persistidas no arquivo", async () => {
  const dataDir = await createTempDataDir();
  let store = loadFreshStore(dataDir);

  await store.updateSettings({
    contaAzul: {
      enabled: true,
      clientId: "client_persistido",
      clientSecret: "secret_persistido",
      redirectUri: "https://www.contaazul.com",
      accessToken: "access_persistido",
      refreshToken: "refresh_persistido",
      fpaExport: {
        enabled: true,
        defaultContactId: "person_persistida",
        defaultFinancialAccountId: "account_persistida",
      },
    },
    lovable: {
      enabled: true,
      webhookSecret: "lovable_persistido",
    },
  });

  store = loadFreshStore(dataDir);
  const settings = await store.getSettings();

  assert.equal(settings.contaAzul.clientId, "client_persistido");
  assert.equal(settings.contaAzul.clientSecret, "secret_persistido");
  assert.equal(settings.contaAzul.accessToken, "access_persistido");
  assert.equal(settings.contaAzul.refreshToken, "refresh_persistido");
  assert.equal(settings.contaAzul.fpaExport.defaultContactId, "person_persistida");
  assert.equal(settings.contaAzul.fpaExport.defaultFinancialAccountId, "account_persistida");
  assert.equal(settings.lovable.enabled, true);
  assert.equal(settings.lovable.webhookSecret, "lovable_persistido");
});

test("monta a URL oficial de autorizacao OAuth do Conta Azul", () => {
  const url = buildContaAzulAuthorizationUrl(
    {
      clientId: "abc123",
      redirectUri: "https://app.exemplo.com/api/conta-azul/oauth/callback",
      scope: "openid profile aws.cognito.signin.user.admin",
    },
    "state_seguro"
  );

  assert.match(url, /^https:\/\/auth\.contaazul\.com\/login\?/);
  assert.match(url, /client_id=abc123/);
  assert.match(url, /response_type=code/);
  assert.match(url, /state=state_seguro/);
  assert.match(url, /redirect_uri=https:\/\/app\.exemplo\.com\/api\/conta-azul\/oauth\/callback/);
  assert.match(url, /scope=openid\+profile\+aws\.cognito\.signin\.user\.admin/);
});

test("preserva endpoint oficial de login OAuth e normaliza URL base do Conta Azul", () => {
  const settings = sanitizeContaAzulSettings({
    authorizationUrl: "https://auth.contaazul.com/login",
    baseUrl: "https://contaazul.com",
    redirectUri:
      "https://auth.contaazul.com/login?response_type=code&client_id=abc&redirect_uri=https://www.contaazul.com&state=ESTADO&scope=openid+profile+aws.cognito.signin.user.admin",
  });

  assert.equal(settings.authorizationUrl, "https://auth.contaazul.com/login");
  assert.equal(settings.baseUrl, "https://api-v2.contaazul.com");
  assert.equal(settings.redirectUri, "https://www.contaazul.com");
});

test("aplica payload de token OAuth preservando refresh token anterior quando necessario", () => {
  const nextSettings = applyContaAzulTokenPayload(
    {
      refreshToken: "refresh_anterior",
    },
    {
      access_token: "access_novo",
      token_type: "Bearer",
      expires_in: 3600,
    }
  );

  assert.equal(nextSettings.accessToken, "access_novo");
  assert.equal(nextSettings.refreshToken, "refresh_anterior");
  assert.equal(nextSettings.tokenType, "Bearer");
  assert.ok(nextSettings.accessTokenExpiresAt);
});

test("normaliza codigo OAuth colado como valor, query string ou URL completa", () => {
  assert.equal(normalizeContaAzulAuthorizationCode("abc-123"), "abc-123");
  assert.equal(normalizeContaAzulAuthorizationCode("code=abc-123&state=estado"), "abc-123");
  assert.equal(normalizeContaAzulAuthorizationCode("?state=estado&code=abc-123"), "abc-123");
  assert.equal(
    normalizeContaAzulAuthorizationCode("https://www.contaazul.com/?code=abc-123&state=estado"),
    "abc-123"
  );
});

test("monta consultas e normaliza listas de pessoas, contas e categorias do Conta Azul", () => {
  const peoplePath = buildContaAzulPeoplePath({
    profileType: "Fornecedor",
    search: "Acme Ltda",
    pageSize: 50,
  });
  const accountsPath = buildContaAzulFinancialAccountsPath({
    search: "Banco do Brasil",
  });
  const categoriesPath = buildContaAzulFinancialCategoriesPath({
    search: "Marketing",
    type: "DESPESA",
  });
  const receivableSearchPath = buildContaAzulFinancialEventsSearchPath({
    type: "receivable",
    from: "2026-04-01",
    to: "2026-04-30",
    financialAccountId: "account_123",
  });
  const person = normalizeContaAzulPerson({
    id: "person_123",
    nome: "Fornecedor Acme",
    documento: "12.345.678/0001-99",
    tipo_perfil: "Fornecedor",
  });
  const account = normalizeContaAzulFinancialAccount({
    id: "account_123",
    nome: "Conta Corrente Principal",
    banco: "BANCO_DO_BRASIL",
    ativo: true,
  });
  const category = normalizeContaAzulFinancialCategory({
    id: "category_123",
    nome: "Marketing",
    tipo: "DESPESA",
    entrada_dre: "DESPESAS_ADMINISTRATIVAS",
  });
  const installment = normalizeContaAzulFinancialInstallment(
    {
      id: "installment_123",
      descricao: "PIX RECEBIDO CLIENTE ACME",
      data_vencimento: "2026-04-01",
      data_competencia: "2026-04-01",
      total: 1500,
      cliente: { nome: "Cliente Acme" },
      categorias: [{ id: "category_receita", nome: "Receita Operacional", tipo: "RECEITA" }],
    },
    "receivable"
  );

  assert.match(peoplePath, /^\/v1\/pessoas\?/);
  assert.match(peoplePath, /tipo_perfil=Fornecedor/);
  assert.match(peoplePath, /busca=Acme\+Ltda/);
  assert.match(accountsPath, /^\/v1\/conta-financeira\?/);
  assert.match(accountsPath, /nome=Banco\+do\+Brasil/);
  assert.match(categoriesPath, /^\/v1\/categorias\?/);
  assert.match(categoriesPath, /busca=Marketing/);
  assert.match(categoriesPath, /tipo=DESPESA/);
  assert.match(categoriesPath, /apenas_filhos=true/);
  assert.match(categoriesPath, /permite_apenas_filhos=true/);
  assert.match(receivableSearchPath, /^\/v1\/financeiro\/eventos-financeiros\/contas-a-receber\/buscar\?/);
  assert.match(receivableSearchPath, /data_vencimento_de=2026-04-01/);
  assert.match(receivableSearchPath, /data_vencimento_ate=2026-04-30/);
  assert.match(receivableSearchPath, /ids_contas_financeiras=account_123/);
  assert.deepEqual(normalizeContaAzulListItems({ itens: [{ id: "x" }] }), [{ id: "x" }]);
  assert.equal(person.id, "person_123");
  assert.equal(person.label, "Fornecedor Acme · 12.345.678/0001-99");
  assert.equal(account.id, "account_123");
  assert.equal(account.label, "Conta Corrente Principal · BANCO_DO_BRASIL");
  assert.equal(category.id, "category_123");
  assert.equal(category.label, "Marketing · DESPESA");
  assert.equal(installment.id, "installment_123");
  assert.equal(installment.type, "receivable");
  assert.equal(installment.amountCents, 150000);
  assert.equal(installment.counterpartyName, "Cliente Acme");
  assert.equal(installment.categories[0].id, "category_receita");
});

test("monta payload de lançamento teste do Conta Azul para receber e pagar", () => {
  const settings = {
    fpaExport: {
      defaultContactId: "contact_123",
      defaultFinancialAccountId: "account_123",
      receivablePath: "/v1/financeiro/eventos-financeiros/contas-a-receber",
      payablePath: "/v1/financeiro/eventos-financeiros/contas-a-pagar",
    },
  };

  const receivable = buildContaAzulTestFinancialEventRecord({
    settings,
    type: "receivable",
    amountCents: 1250,
    description: "TESTE FP&A - Receber",
    competenceDate: "2026-04-21",
    dueDate: "2026-04-22",
    categoryId: "category_receita",
  });
  const payable = buildContaAzulTestFinancialEventRecord({
    settings,
    type: "payable",
    amountCents: 3450,
    description: "TESTE FP&A - Pagar",
    competenceDate: "2026-04-21",
    dueDate: "2026-04-23",
    categoryId: "category_despesa",
  });

  assert.equal(receivable.type, "receivable");
  assert.equal(receivable.endpointPath, "/v1/financeiro/eventos-financeiros/contas-a-receber");
  assert.equal(receivable.payload.valor, 12.5);
  assert.equal(receivable.payload.contato, "contact_123");
  assert.equal(receivable.payload.conta_financeira, "account_123");
  assert.deepEqual(receivable.payload.rateio, [{ id_categoria: "category_receita", valor: 12.5 }]);
  assert.equal(receivable.payload.condicao_pagamento.parcelas[0].descricao, "TESTE FP&A - Receber");
  assert.equal(receivable.payload.condicao_pagamento.parcelas[0].data_vencimento, "2026-04-22");
  assert.equal(receivable.payload.condicao_pagamento.parcelas[0].conta_financeira, "account_123");
  assert.match(receivable.payload.condicao_pagamento.parcelas[0].nota, /Origem: Analista FP&A/);
  assert.deepEqual(receivable.missingRequiredFields, []);

  assert.equal(payable.type, "payable");
  assert.equal(payable.endpointPath, "/v1/financeiro/eventos-financeiros/contas-a-pagar");
  assert.equal(payable.payload.valor, 34.5);
  assert.equal(payable.payload.descricao, "TESTE FP&A - Pagar");
  assert.deepEqual(payable.payload.rateio, [{ id_categoria: "category_despesa", valor: 34.5 }]);
  assert.equal(payable.payload.condicao_pagamento.parcelas[0].descricao, "TESTE FP&A - Pagar");
  assert.deepEqual(payable.missingRequiredFields, []);
});

test("monta payload de contrato recorrente do Lovable para o Conta Azul", () => {
  const settings = {
    fpaExport: {
      defaultContactId: "cliente_default",
      defaultFinancialAccountId: "conta_default",
      defaultReceivableCategoryId: "categoria_receita",
    },
  };

  const record = buildContaAzulContractRecord({
    settings,
    nextContractNumber: 4512645,
    source: {
      contractId: "lovable_ct_123",
      customerId: "cliente_123",
      productId: "servico_123",
      description: "Mensalidade assessoria financeira",
      amountCents: 99000,
      startDate: "2026-05-01",
      endDate: "2027-04-30",
      firstDueDate: "2026-05-10",
      dueDay: 10,
      paymentMethod: "pix",
    },
  });
  const response = normalizeContaAzulContractResponse({ id: "contrato_123", id_legado: 42, id_venda: "venda_123" });

  assert.equal(record.externalId, "lovable_ct_123");
  assert.equal(record.endpointPath, "/v1/contratos");
  assert.equal(record.payload.id_cliente, "cliente_123");
  assert.equal(record.payload.id_categoria, "categoria_receita");
  assert.equal(record.payload.termos.numero, 4512645);
  assert.equal(record.payload.termos.tipo_frequencia, "MENSAL");
  assert.equal(record.payload.condicao_pagamento.id_conta_financeira, "conta_default");
  assert.equal(record.payload.condicao_pagamento.primeira_data_vencimento, "2026-05-10");
  assert.equal(record.payload.itens[0].id, "servico_123");
  assert.equal(record.payload.itens[0].valor, 990);
  assert.deepEqual(record.missingRequiredFields, []);
  assert.equal(response.id, "contrato_123");
  assert.equal(response.legacyId, 42);
  assert.equal(response.saleId, "venda_123");
});

test("monta payload de baixa de recebimento do Lovable para o Conta Azul", () => {
  const settings = {
    fpaExport: {
      defaultFinancialAccountId: "conta_default",
    },
  };

  const record = buildContaAzulAcquittanceRecord({
    settings,
    installmentId: "parcela_123",
    source: {
      paymentId: "lovable_pay_123",
      amountCents: 99000,
      paidAt: "2026-05-10",
      paymentMethod: "pix",
      nsu: "abc123",
    },
  });
  const response = normalizeContaAzulAcquittanceResponse({
    id: "baixa_123",
    id_parcela: "parcela_123",
    data_pagamento: "2026-05-10",
  });

  assert.equal(buildContaAzulAcquittancePath("parcela_123"), "/v1/financeiro/eventos-financeiros/parcelas/parcela_123/baixa");
  assert.equal(record.externalId, "lovable_pay_123");
  assert.equal(record.installmentId, "parcela_123");
  assert.equal(record.endpointPath, "/v1/financeiro/eventos-financeiros/parcelas/parcela_123/baixa");
  assert.equal(record.payload.data_pagamento, "2026-05-10");
  assert.equal(record.payload.composicao_valor.valor_bruto, 990);
  assert.equal(record.payload.conta_financeira, "conta_default");
  assert.equal(record.payload.metodo_pagamento, "PIX");
  assert.equal(record.payload.nsu, "abc123");
  assert.deepEqual(record.missingRequiredFields, []);
  assert.equal(response.id, "baixa_123");
  assert.equal(response.installmentId, "parcela_123");
});

test("monta payload de eventos financeiros do FP&A para o Conta Azul", () => {
  const settings = {
    enabled: true,
    fpaExport: {
      enabled: true,
      defaultContactId: "35473eec-4e74-11ee-b500-9f61de8a8b8b",
      defaultFinancialAccountId: "9986f173-f531-4660-96ae-04b71c879264",
      defaultReceivableCategoryId: "category_receita",
      defaultPayableCategoryId: "category_despesa",
      maxRecordsPerRun: 10,
    },
  };
  const payload = buildContaAzulFpaExportPayload({
    settings,
    transactions: [
      {
        id: "txn_in",
        accountName: "Conta Operacional",
        transactionDate: "2026-04-01",
        description: "PIX RECEBIDO CLIENTE ACME",
        amountCents: 150000,
        category: "Receita Operacional",
      },
      {
        id: "txn_out",
        accountName: "Conta Operacional",
        transactionDate: "2026-04-02",
        description: "GOOGLE ADS",
        amountCents: -25090,
        category: "Marketing",
      },
    ],
  });

  assert.equal(payload.resource, "fpa_transactions");
  assert.equal(payload.records.length, 2);
  assert.equal(payload.records[0].type, "receivable");
  assert.equal(payload.records[0].endpointPath, "/v1/financeiro/eventos-financeiros/contas-a-receber");
  assert.equal(payload.records[0].payload.valor, 1500);
  assert.equal(payload.records[0].payload.contato, settings.fpaExport.defaultContactId);
  assert.deepEqual(payload.records[0].payload.rateio, [{ id_categoria: "category_receita", valor: 1500 }]);
  assert.equal(payload.records[0].payload.condicao_pagamento.parcelas[0].descricao, "PIX RECEBIDO CLIENTE ACME");
  assert.equal(payload.records[0].payload.condicao_pagamento.parcelas[0].conta_financeira, settings.fpaExport.defaultFinancialAccountId);
  assert.equal(payload.records[1].type, "payable");
  assert.equal(payload.records[1].endpointPath, "/v1/financeiro/eventos-financeiros/contas-a-pagar");
  assert.equal(payload.records[1].payload.valor, 250.9);
  assert.deepEqual(payload.records[1].payload.rateio, [{ id_categoria: "category_despesa", valor: 250.9 }]);
  assert.equal(payload.records[1].payload.condicao_pagamento.parcelas[0].descricao, "GOOGLE ADS");
  assert.deepEqual(payload.missingRequiredFields, []);
});

test("cruza lancamentos FP&A locais com eventos financeiros ja existentes no Conta Azul", () => {
  const settings = {
    enabled: true,
    fpaExport: {
      enabled: true,
      defaultContactId: "contact_123",
      defaultFinancialAccountId: "account_123",
      defaultReceivableCategoryId: "category_receita",
      defaultPayableCategoryId: "category_despesa",
      maxRecordsPerRun: 10,
    },
  };
  const payload = buildContaAzulFpaExportPayload({
    settings,
    transactions: [
      {
        id: "txn_in",
        accountName: "Conta Operacional",
        transactionDate: "2026-04-01",
        description: "PIX RECEBIDO CLIENTE ACME",
        amountCents: 150000,
        category: "Receita Operacional",
      },
      {
        id: "txn_out",
        accountName: "Conta Operacional",
        transactionDate: "2026-04-02",
        description: "GOOGLE ADS",
        amountCents: -25090,
        category: "Marketing",
      },
    ],
  });
  const remoteRecords = [
    normalizeContaAzulFinancialInstallment(
      {
        id: "installment_123",
        descricao: "PIX RECEBIDO CLIENTE ACME",
        data_vencimento: "2026-04-01",
        total: 1500,
        cliente: { nome: "Cliente Acme" },
        categorias: [{ id: "category_receita", nome: "Receita Operacional", tipo: "RECEITA" }],
      },
      "receivable"
    ),
  ];

  const reconciliation = reconcileContaAzulFinancialRecords(payload.records, remoteRecords);

  assert.equal(reconciliation.totalLocalRecords, 2);
  assert.equal(reconciliation.totalContaAzulRecords, 1);
  assert.equal(reconciliation.matchedRecords.length, 1);
  assert.equal(reconciliation.recordsToCreate.length, 1);
  assert.equal(reconciliation.matchedRecords[0].localId, "txn_in");
  assert.equal(reconciliation.recordsToCreate[0].localId, "txn_out");
});

test("persiste configuracao e historico do Conta Azul no store", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  await store.updateSettings({
    contaAzul: {
      enabled: true,
      baseUrl: "https://api-v2.contaazul.com",
      clientId: "client_123",
      clientSecret: "secret_123",
      redirectUri: "https://app.exemplo.com/api/conta-azul/oauth/callback",
      accessToken: "token_123",
      refreshToken: "refresh_123",
      fpaExport: {
        enabled: true,
        defaultContactId: "contact_123",
        defaultFinancialAccountId: "account_123",
      },
    },
  });

  await store.recordContaAzulSync(
    {
      kind: "push",
      direction: "outbound",
      resource: "fpa_transactions",
      status: "success",
      endpoint: "https://api-v2.contaazul.com/v1/financeiro/eventos-financeiros/contas-a-receber",
      recordCount: 3,
      summary: "Push executado",
      startedAt: "2026-04-15T12:00:00.000Z",
      finishedAt: "2026-04-15T12:00:01.000Z",
    },
    {
      lastPushAt: "2026-04-15T12:00:01.000Z",
      lastPushResource: "fpa_transactions",
      lastPushStatus: "success",
      lastError: null,
    }
  );

  const settings = await store.getSettings();
  assert.equal(settings.contaAzul.enabled, true);
  assert.equal(settings.contaAzul.clientId, "client_123");
  assert.equal(settings.contaAzul.clientSecret, "secret_123");
  assert.equal(settings.contaAzul.accessToken, "token_123");
  assert.equal(settings.contaAzul.refreshToken, "refresh_123");
  assert.equal(settings.contaAzul.fpaExport.enabled, true);
  assert.equal(settings.contaAzul.fpaExport.defaultContactId, "contact_123");
  assert.equal(settings.contaAzul.fpaExport.defaultFinancialAccountId, "account_123");
  assert.equal(settings.contaAzul.syncHistory.length, 1);
  assert.equal(settings.contaAzul.syncHistory[0].resource, "fpa_transactions");
  assert.equal(settings.contaAzul.status.lastPushStatus, "success");
});

test("persiste vinculos idempotentes de contratos e recebimentos vindos do Lovable", async () => {
  const dataDir = await createTempDataDir();
  const store = loadFreshStore(dataDir);

  const contract = await store.upsertLovableContractSync({
    externalId: "lovable_ct_123",
    amountCents: 99000,
    status: "success",
    contaAzulContractId: "contrato_123",
    contaAzulSaleId: "venda_123",
    responseCode: 200,
  });
  const updatedContract = await store.upsertLovableContractSync({
    externalId: "lovable_ct_123",
    amountCents: 99000,
    status: "success",
    contaAzulContractId: "contrato_123",
    contaAzulSaleId: "venda_123",
    responseCode: 200,
  });
  const receipt = await store.upsertLovableReceiptSync({
    externalId: "lovable_pay_123",
    externalContractId: "lovable_ct_123",
    amountCents: 99000,
    paymentDate: "2026-05-10",
    status: "success",
    contaAzulInstallmentId: "parcela_123",
    contaAzulAcquittanceId: "baixa_123",
  });

  const contracts = await store.listLovableContractSyncs();
  const receipts = await store.listLovableReceiptSyncs();

  assert.equal(contract.externalId, "lovable_ct_123");
  assert.equal(updatedContract.id, contract.id);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].contaAzulContractId, "contrato_123");
  assert.equal(receipt.externalContractId, "lovable_ct_123");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].contaAzulAcquittanceId, "baixa_123");
  assert.equal((await store.findLovableContractSync("lovable_ct_123")).id, contract.id);
  assert.equal((await store.findLovableReceiptSync("lovable_pay_123")).id, receipt.id);
});
