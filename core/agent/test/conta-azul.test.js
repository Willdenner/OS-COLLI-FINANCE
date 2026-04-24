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
  buildContaAzulInventoryListPath,
  buildContaAzulProductsPath,
  buildContaAzulFinancialEventsSearchPath,
  buildContaAzulFpaExportPayload,
  buildContaAzulPeoplePath,
  buildContaAzulTestFinancialEventRecord,
  filterContaAzulCatalogByMode,
  getContaAzulLovableContractPaths,
  mergeContaAzulSettings,
  normalizeContaAzulAcquittanceResponse,
  normalizeContaAzulAuthorizationCode,
  normalizeContaAzulContractResponse,
  normalizeContaAzulFinancialAccount,
  normalizeContaAzulFinancialCategory,
  normalizeContaAzulFinancialInstallment,
  mergeContaAzulCatalogListRows,
  normalizeContaAzulListItems,
  normalizeContaAzulPerson,
  normalizeContaAzulProduct,
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
  const productsPath = buildContaAzulProductsPath({
    search: "Assessoria",
    pageSize: 200,
    status: "ATIVO",
  });
  const productsPathNoStatus = buildContaAzulProductsPath({ page: 2, pageSize: 50 });
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
  assert.match(productsPath, /^\/v1\/produtos\?/);
  assert.match(productsPath, /busca=Assessoria/);
  assert.match(productsPath, /tamanho_pagina=200/);
  assert.match(buildContaAzulProductsPath({ pageSize: 300 }), /tamanho_pagina=500/);
  assert.match(productsPath, /status=ATIVO/);
  assert.match(productsPathNoStatus, /pagina=2/);
  assert.doesNotMatch(productsPathNoStatus, /status=/);
  const catalogItem = normalizeContaAzulProduct({
    id: "uuid-serv-1",
    nome: "Serviço recorrente",
    sku: "SKU-9",
    tipo: "SERVICO",
  });
  assert.equal(catalogItem.id, "uuid-serv-1");
  assert.match(catalogItem.label, /Serviço recorrente/);
  assert.match(catalogItem.label, /SKU-9/);
  assert.match(catalogItem.label, /Serviço/);
  assert.deepEqual(normalizeContaAzulListItems({ itens: [{ id: "x" }] }), [{ id: "x" }]);
  assert.deepEqual(normalizeContaAzulListItems({ produtos: [{ id: "p1" }] }), [{ id: "p1" }]);
  assert.deepEqual(normalizeContaAzulListItems({ data: { itens: [{ id: "nested" }] } }), [{ id: "nested" }]);
  assert.deepEqual(normalizeContaAzulListItems({ itens: [], items: [{ id: "from_items" }] }), [{ id: "from_items" }]);
  assert.deepEqual(
    mergeContaAzulCatalogListRows({ produtos: [{ id: "p" }], servicos: [{ id: "s", nome: "Srv" }] }),
    [{ id: "p" }, { id: "s", nome: "Srv" }]
  );
  const prodKind = normalizeContaAzulProduct({ id: "p2", nome: "Mesa", tipo: "PRODUTO" });
  assert.match(prodKind.label, /Produto/);
  assert.equal(prodKind.tipoRaw, "PRODUTO");
  assert.equal(catalogItem.tipoRaw, "SERVICO");
  const mixedCatalog = [
    normalizeContaAzulProduct({ id: "a", nome: "TV", tipo: "PRODUTO" }),
    normalizeContaAzulProduct({ id: "b", nome: "Consultoria", tipo: "SERVICO" }),
    normalizeContaAzulProduct({ id: "c", nome: "Misto", tipo: "PRODUCT" }),
    normalizeContaAzulProduct({ id: "d", nome: "Sem tipo no resumo", tipo: "" }),
  ];
  assert.equal(filterContaAzulCatalogByMode(mixedCatalog, "servicos").length, 2);
  assert.equal(filterContaAzulCatalogByMode(mixedCatalog, "produtos").length, 2);
  assert.equal(filterContaAzulCatalogByMode(mixedCatalog, "todos").length, 4);
  const fiscalServ = normalizeContaAzulProduct({ id: "e", nome: "Via fiscal", fiscal: { tipo_produto: "SERVICOS" } });
  assert.match(String(fiscalServ.tipoRaw || ""), /SERVICOS/i);
  assert.equal(filterContaAzulCatalogByMode([fiscalServ], "servicos").length, 1);
  const mixedTipo = normalizeContaAzulProduct({
    id: "f",
    nome: "Mensalidade",
    tipo: "PRODUTO",
    fiscal: { tipo_produto: "SERVICOS" },
  });
  assert.equal(mixedTipo.kind, "Serviço");
  assert.equal(filterContaAzulCatalogByMode([mixedTipo], "servicos").length, 1);
  assert.equal(filterContaAzulCatalogByMode([mixedTipo], "produtos").length, 0);
  assert.match(buildContaAzulInventoryListPath("/v1/services", { page: 1, pageSize: 100 }), /^\/v1\/services\?/);
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
  assert.equal(record.payload.condicao_pagamento.id_conta_financeira, "34afb732-3947-4fc8-9cb6-f9fec508872b");
  assert.equal(record.payload.condicao_pagamento.primeira_data_vencimento, "2026-05-10");
  assert.equal(record.payload.itens[0].id, "servico_123");
  assert.equal(record.payload.itens[0].valor, 990);
  assert.deepEqual(record.missingRequiredFields, []);
  assert.equal(response.id, "contrato_123");
  assert.equal(response.legacyId, 42);
  assert.equal(response.saleId, "venda_123");
});

test("lovableContracts.defaultContractFinancialAccountId tem precedencia sobre fpaExport para contrato", () => {
  const settings = {
    fpaExport: {
      defaultFinancialAccountId: "fpa_conta",
    },
    lovableContracts: {
      defaultContractFinancialAccountId: "conta_somente_contrato",
    },
  };
  const record = buildContaAzulContractRecord({
    settings,
    nextContractNumber: 1,
    source: { customerId: "c1", productId: "p1", amountCents: 1000, startDate: "2026-01-01", firstDueDate: "2026-01-10" },
  });
  assert.equal(record.payload.condicao_pagamento.id_conta_financeira, "conta_somente_contrato");
});

test("financePaymentMappings aplica condicao_pagamento, id_conta_financeira, itens[0] conforme forma de pagamento", () => {
  const settings = mergeContaAzulSettings(
    {
      fpaExport: {
        defaultReceivableCategoryId: "cat_r",
        defaultFinancialAccountId: "conta_padrao",
      },
    },
    {
      lovableContracts: {
        financePaymentMappings: [
          {
            financePaymentKey: "boleto",
            contaAzulTipoPagamento: "BOLETO_BANCARIO",
            contaAzulFinancialAccountId: "conta_boleto_uuid",
            contaAzulItemId: "item_servico_boleto",
            contaAzulItemValor: "150,50",
          },
        ],
      },
    }
  );
  const record = buildContaAzulContractRecord({
    settings,
    nextContractNumber: 50,
    source: {
      customerId: "c1",
      productId: "prod_ignored",
      amountCents: 10000,
      startDate: "2026-01-01",
      firstDueDate: "2026-01-10",
      paymentMethod: "boleto",
    },
  });
  assert.equal(record.payload.condicao_pagamento.tipo_pagamento, "BOLETO_BANCARIO");
  assert.equal(record.payload.condicao_pagamento.id_conta_financeira, "conta_boleto_uuid");
  assert.equal(record.payload.itens[0].id, "item_servico_boleto");
  assert.equal(record.payload.itens[0].valor, 150.5);
  assert.equal(record.amountCents, 15050);
});

test("baixa Lovable usa conta e metodo do financePaymentMappings quando a chave bate", () => {
  const settings = mergeContaAzulSettings(
    { fpaExport: { defaultFinancialAccountId: "conta_default" } },
    {
      lovableContracts: {
        financePaymentMappings: [
          {
            financePaymentKey: "pix",
            contaAzulFinancialAccountId: "conta_pix_mapeada",
            contaAzulTipoPagamento: "PIX",
          },
        ],
      },
    }
  );
  const record = buildContaAzulAcquittanceRecord({
    settings,
    installmentId: "parc1",
    source: { paymentMethod: "pix", amountCents: 10000 },
  });
  assert.equal(record.payload.conta_financeira, "conta_pix_mapeada");
  assert.equal(record.payload.metodo_pagamento, "PIX");
});

test("contaAzulContractPayload vazio nao descarta o payload calculado (merge com base)", () => {
  const record = buildContaAzulContractRecord({
    settings: { fpaExport: { defaultReceivableCategoryId: "categoria_receita" } },
    nextContractNumber: 100,
    source: {
      contractId: "c_webhook",
      customerId: "pessoa-1",
      productId: "prod-map-1",
      amountCents: 0,
      startDate: "2026-01-01",
      firstDueDate: "2026-01-10",
      contaAzulContractPayload: {},
    },
  });
  assert.equal(record.payload.itens[0].valor, 0);
  assert.equal(record.payload.itens[0].id, "prod-map-1");
  assert.equal(record.payload.condicao_pagamento.id_conta_financeira, "34afb732-3947-4fc8-9cb6-f9fec508872b");
  assert.equal(record.missingRequiredFields.filter((f) => f === "itens[0].valor").length, 0);
  assert.deepEqual(record.missingRequiredFields, []);
});

test("contaAzulContractPayload com strings vazias nao apaga id_conta_financeira nem itens[0] da base", () => {
  const record = buildContaAzulContractRecord({
    settings: { fpaExport: { defaultReceivableCategoryId: "categoria_receita" } },
    nextContractNumber: 200,
    source: {
      contractId: "c_finance",
      customerId: "pessoa-2",
      productId: "prod-x",
      amountCents: 5000,
      startDate: "2026-02-01",
      firstDueDate: "2026-02-10",
      contaAzulContractPayload: {
        condicao_pagamento: { id_conta_financeira: "" },
        itens: [{ id: "", descricao: "Sobrescreve descricao" }],
      },
    },
  });
  assert.equal(record.payload.condicao_pagamento.id_conta_financeira, "34afb732-3947-4fc8-9cb6-f9fec508872b");
  assert.equal(record.payload.itens[0].id, "prod-x");
  assert.equal(record.payload.itens[0].valor, 50);
  assert.deepEqual(record.missingRequiredFields, []);
});

test("mapeia contrato vindo do Finance com billing_clients em lista e campos em snake_case", () => {
  const settings = {
    fpaExport: {
      defaultReceivableCategoryId: "categoria_receita",
    },
  };
  const record = buildContaAzulContractRecord({
    settings,
    nextContractNumber: 200,
    source: {
      contractId: "fin_ct_1",
      contract_start_date: "2026-07-01T12:00:00.000Z",
      first_charge_date: "2026-07-10",
      monthly_value: 1500.5,
      billing_clients: [{ id: "pessoa-uuid-caz", conta_azul_id: "pessoa-uuid-caz" }],
      id_conta_financeira: "conta-financeira-uuid",
      servico_id: "servico-uuid-1",
    },
  });
  assert.equal(record.payload.id_cliente, "pessoa-uuid-caz");
  assert.equal(record.payload.termos.data_inicio, "2026-07-01");
  assert.equal(record.payload.condicao_pagamento.id_conta_financeira, "conta-financeira-uuid");
  assert.equal(record.payload.condicao_pagamento.primeira_data_vencimento, "2026-07-10");
  assert.equal(record.payload.itens[0].id, "servico-uuid-1");
  assert.equal(record.payload.itens[0].valor, 1500.5);
  assert.deepEqual(record.missingRequiredFields, []);
});

test("permite customizar rotas de contrato via integracao lovableContracts", () => {
  const settings = mergeContaAzulSettings(
    {},
    {
      lovableContracts: {
        contractsCreatePath: "/v1/contratos",
        nextContractNumberPath: "/v1/contratos/proximo-numero",
      },
    }
  );
  const paths = getContaAzulLovableContractPaths(settings);
  assert.equal(paths.contractsCreatePath, "/v1/contratos");
  assert.equal(paths.nextContractNumberPath, "/v1/contratos/proximo-numero");

  const record = buildContaAzulContractRecord({
    settings: mergeContaAzulSettings(
      { fpaExport: { defaultFinancialAccountId: "conta_x", defaultReceivableCategoryId: "cat_x" } },
      { lovableContracts: { contractsCreatePath: "/custom/v1/contratos" } }
    ),
    nextContractNumber: 1,
    source: {
      contractId: "x",
      customerId: "c",
      productId: "p",
      amountCents: 10000,
      startDate: "2026-01-01",
      firstDueDate: "2026-01-10",
    },
  });
  assert.equal(record.endpointPath, "/custom/v1/contratos");
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
