const {
  formatMoneyBRL,
  truncateText,
} = require("./domain");

const CONTA_AZUL_AUTH_URL = "https://auth.contaazul.com/login";
const CONTA_AZUL_TOKEN_URL = "https://auth.contaazul.com/oauth2/token";
const CONTA_AZUL_API_BASE_URL = "https://api-v2.contaazul.com";
const CONTA_AZUL_DEFAULT_SCOPE = "openid profile aws.cognito.signin.user.admin";
const CONTA_AZUL_CONNECTED_ACCOUNT_PATH = "/v1/pessoas/conta-conectada";
const CONTA_AZUL_PEOPLE_PATH = "/v1/pessoas";
const CONTA_AZUL_FINANCIAL_ACCOUNTS_PATH = "/v1/conta-financeira";
const CONTA_AZUL_FINANCIAL_CATEGORIES_PATH = "/v1/categorias";
const CONTA_AZUL_PRODUCTS_PATH = "/v1/produtos";
/** Conta Azul /v1/produtos only accepts these exact tamanho_pagina values. */
const CONTA_AZUL_PRODUCT_PAGE_SIZES = Object.freeze([10, 20, 50, 100, 200, 500, 1000]);
const CONTA_AZUL_FPA_EXPORT_RESOURCE = "fpa_transactions";
const CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE = "lovable_contracts";
const CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE = "lovable_receipts";
const CONTA_AZUL_PAYABLE_EVENT_PATH = "/v1/financeiro/eventos-financeiros/contas-a-pagar";
const CONTA_AZUL_RECEIVABLE_EVENT_PATH = "/v1/financeiro/eventos-financeiros/contas-a-receber";
const CONTA_AZUL_PAYABLE_SEARCH_PATH = "/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar";
const CONTA_AZUL_RECEIVABLE_SEARCH_PATH = "/v1/financeiro/eventos-financeiros/contas-a-receber/buscar";
const CONTA_AZUL_CONTRACTS_PATH = "/v1/contratos";
const CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH = "/v1/contratos/proximo-numero";
const CONTA_AZUL_DEFAULT_CONTRACT_FINANCIAL_ACCOUNT_ID = "34afb732-3947-4fc8-9cb6-f9fec508872b";
const CONTA_AZUL_ACQUITTANCE_PATH_TEMPLATE = "/v1/financeiro/eventos-financeiros/parcelas/{parcela_id}/baixa";

function normalizeOptionalText(value, maxLength = 240) {
  return truncateText(value, maxLength);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function normalizeContaAzulProductsPageSize(value) {
  const n = clampInteger(value, 10, 1000, 100);
  const allowed = CONTA_AZUL_PRODUCT_PAGE_SIZES;
  if (allowed.includes(n)) return n;
  const ceiling = allowed.find((s) => s >= n);
  return ceiling ?? 1000;
}

function parseBrazilianDecimal(value) {
  const str = String(value ?? "").trim();
  if (!str) return NaN;
  // "1.500,75" → "1500.75"
  if (/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(str)) return parseFloat(str.replace(/\./g, "").replace(",", "."));
  // "1500,75" → "1500.75"
  if (/^\d+(,\d+)?$/.test(str)) return parseFloat(str.replace(",", "."));
  return parseFloat(str);
}

function normalizeAmountCents(value) {
  const parsed = typeof value === "string" ? parseBrazilianDecimal(value) : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.abs(parsed) * 100);
}

function normalizeCentsValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.abs(Math.round(parsed));
}

function moneyCentsToDecimal(cents) {
  const parsed = normalizeCentsValue(cents);
  return parsed == null ? 0 : parsed / 100;
}

function normalizeDecimalMoney(value) {
  return moneyCentsToDecimal(normalizeAmountCents(value));
}

function normalizeOptionalNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function normalizePositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function pickFirstText(...values) {
  for (const value of values) {
    const normalized = normalizeOptionalText(value, 240);
    if (normalized) return normalized;
  }
  return "";
}

function readNestedValue(source, path) {
  const parts = String(path || "")
    .split(".")
    .filter(Boolean);
  let current = source;
  for (const part of parts) {
    while (Array.isArray(current) && current.length) {
      current = current[0];
    }
    if (current == null || typeof current !== "object") return undefined;
    if (!(part in current)) return undefined;
    current = current[part];
  }
  while (Array.isArray(current) && current.length) {
    current = current[0];
  }
  return current;
}

/** Like readNestedValue but returns an array as-is (no unwrap of first element). */
function readNestedArray(source, path) {
  const parts = String(path || "")
    .split(".")
    .filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    if (!(part in current)) return undefined;
    current = current[part];
  }
  return Array.isArray(current) ? current : undefined;
}

function pickFirstNested(source, paths = []) {
  for (const path of paths) {
    const value = readNestedValue(source, path);
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function resolveMoneyCents(source, centPaths = [], decimalPaths = []) {
  const centsValue = pickFirstNested(source, centPaths);
  const cents = normalizeCentsValue(centsValue);
  if (cents != null) return cents;
  return normalizeAmountCents(pickFirstNested(source, decimalPaths)) || 0;
}

function normalizeEnum(value, allowed, fallback) {
  const safeValue = String(value || "").trim();
  return allowed.includes(safeValue) ? safeValue : fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normalizeContaAzulApiBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (["contaazul.com", "www.contaazul.com", "auth.contaazul.com"].includes(url.hostname)) {
      return CONTA_AZUL_API_BASE_URL;
    }
  } catch {
    return "";
  }

  return normalized;
}

function normalizeContaAzulRedirectUri(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return "";

  try {
    const url = new URL(normalized);
    if (url.hostname === "auth.contaazul.com" && url.searchParams.get("redirect_uri")) {
      return normalizeBaseUrl(url.searchParams.get("redirect_uri"));
    }
  } catch {
    return "";
  }

  return normalized;
}

function normalizeEndpointPath(value, fallback = "") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (/^https?:\/\//i.test(raw)) {
    return normalizeBaseUrl(raw);
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeHeaderName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "x-conta-azul-token";
  return raw.replace(/[^\w-]+/g, "-").slice(0, 80) || "x-conta-azul-token";
}

function normalizeContaAzulScope(value) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  return raw || CONTA_AZUL_DEFAULT_SCOPE;
}

function normalizeContaAzulAuthorizationCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsedUrl = new URL(raw);
    const codeFromUrl = parsedUrl.searchParams.get("code");
    if (codeFromUrl) return normalizeOptionalText(codeFromUrl, 2048);
  } catch {
    // Users often paste only the query string, not a full URL.
  }

  if (raw.includes("=")) {
    const queryString = raw.startsWith("?") ? raw.slice(1) : raw;
    const params = new URLSearchParams(queryString);
    const codeFromQuery = params.get("code");
    if (codeFromQuery) return normalizeOptionalText(codeFromQuery, 2048);
  }

  return normalizeOptionalText(raw, 2048);
}

function normalizeContaAzulConnectedAccount(account) {
  const safeAccount = account && typeof account === "object" ? account : {};
  return {
    id: normalizeOptionalText(
      safeAccount.id || safeAccount.uuid || safeAccount.companyId || safeAccount.empresaId,
      120
    ) || null,
    companyName: normalizeOptionalText(
      safeAccount.razao_social ||
        safeAccount.companyName ||
        safeAccount.nome ||
        safeAccount.name,
      160
    ) || null,
    tradeName: normalizeOptionalText(
      safeAccount.nome_fantasia || safeAccount.tradeName || safeAccount.fantasyName,
      160
    ) || null,
    document: normalizeOptionalText(
      safeAccount.cnpj || safeAccount.documento || safeAccount.document,
      40
    ) || null,
    email: normalizeOptionalText(
      safeAccount.email || safeAccount.contato_email || safeAccount.contactEmail,
      320
    ) || null,
  };
}

function pickFirstListArray(candidates) {
  const arrays = candidates.filter(Array.isArray);
  const nonEmpty = arrays.find((a) => a.length > 0);
  if (nonEmpty) return nonEmpty;
  return arrays[0] || [];
}

function normalizeContaAzulListItems(payload) {
  if (Array.isArray(payload)) return payload;
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const nestedArrays = [
    readNestedArray(safePayload, "data.itens"),
    readNestedArray(safePayload, "data.items"),
    readNestedArray(safePayload, "data.produtos"),
    readNestedArray(safePayload, "resultado.itens"),
    readNestedArray(safePayload, "result.itens"),
  ];
  return pickFirstListArray([
    safePayload.itens,
    safePayload.items,
    safePayload.produtos,
    safePayload.lista,
    safePayload.registros,
    ...nestedArrays,
    safePayload.data,
    safePayload.pessoas,
    safePayload.contas,
    safePayload.contas_financeiras,
    safePayload.categorias,
    safePayload.results,
    safePayload.content,
  ]);
}

function normalizeContaAzulPersonProfileType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("forn")) return "Fornecedor";
  if (raw.startsWith("clie")) return "Cliente";
  return "";
}

function normalizeContaAzulPerson(person) {
  const safePerson = person && typeof person === "object" ? person : {};
  const id = normalizeOptionalText(safePerson.id || safePerson.uuid || safePerson.pessoa_id, 120);
  const name = normalizeOptionalText(
    safePerson.nome ||
      safePerson.name ||
      safePerson.razao_social ||
      safePerson.razaoSocial ||
      safePerson.nome_fantasia ||
      safePerson.fantasyName,
    180
  );
  const tradeName = normalizeOptionalText(safePerson.nome_fantasia || safePerson.tradeName || safePerson.fantasyName, 180);
  const document = normalizeOptionalText(
    safePerson.documento ||
      safePerson.document ||
      safePerson.cpf_cnpj ||
      safePerson.cpfCnpj ||
      safePerson.cnpj ||
      safePerson.cpf,
    40
  );
  const email = normalizeOptionalText(safePerson.email || safePerson.contato_email || safePerson.contactEmail, 320);
  const profileSource = safePerson.tipo_perfil || safePerson.tipoPerfil || safePerson.perfil || safePerson.profileType || safePerson.perfis || [];
  const profileTypes = Array.isArray(profileSource)
    ? profileSource.map((entry) => normalizeOptionalText(entry?.nome || entry?.name || entry, 80)).filter(Boolean)
    : String(profileSource || "").split(",").map((entry) => normalizeOptionalText(entry, 80)).filter(Boolean);
  const label = [name || tradeName || id || "Pessoa sem nome", document].filter(Boolean).join(" · ");

  return {
    id: id || null,
    name: name || tradeName || null,
    tradeName: tradeName || null,
    document: document || null,
    email: email || null,
    profileTypes,
    label,
  };
}

function normalizeContaAzulFinancialAccount(account) {
  const safeAccount = account && typeof account === "object" ? account : {};
  const id = normalizeOptionalText(safeAccount.id || safeAccount.uuid || safeAccount.conta_id, 120);
  const name = normalizeOptionalText(safeAccount.nome || safeAccount.name || safeAccount.descricao || safeAccount.description, 180);
  const bank = normalizeOptionalText(safeAccount.banco || safeAccount.bank || safeAccount.nome_banco || safeAccount.bankName, 120);
  const type = normalizeOptionalText(safeAccount.tipo || safeAccount.type || safeAccount.tipo_conta || safeAccount.accountType, 80);
  const isActive = "ativo" in safeAccount ? safeAccount.ativo === true : "active" in safeAccount ? safeAccount.active === true : true;
  const label = [name || id || "Conta sem nome", bank].filter(Boolean).join(" · ");

  return {
    id: id || null,
    name: name || null,
    bank: bank || null,
    type: type || null,
    active: isActive,
    label,
  };
}

function normalizeContaAzulFinancialCategoryType(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "RECEITA" || raw === "RECEIVABLE") return "RECEITA";
  if (raw === "DESPESA" || raw === "PAYABLE") return "DESPESA";
  return "";
}

function normalizeContaAzulFinancialCategory(category) {
  const safeCategory = category && typeof category === "object" ? category : {};
  const id = normalizeOptionalText(safeCategory.id || safeCategory.uuid || safeCategory.id_categoria, 120);
  const name = normalizeOptionalText(safeCategory.nome || safeCategory.name || safeCategory.descricao || safeCategory.description, 180);
  const parentId = normalizeOptionalText(safeCategory.categoria_pai || safeCategory.parentId || safeCategory.id_categoria_pai, 120);
  const type = normalizeContaAzulFinancialCategoryType(safeCategory.tipo || safeCategory.type);
  const dreEntry = normalizeOptionalText(safeCategory.entrada_dre || safeCategory.dreEntry, 120);
  const isActive = "ativo" in safeCategory ? safeCategory.ativo === true : "active" in safeCategory ? safeCategory.active === true : true;
  const label = [name || id || "Categoria sem nome", type].filter(Boolean).join(" · ");

  return {
    id: id || null,
    name: name || null,
    parentId: parentId || null,
    type: type || null,
    dreEntry: dreEntry || null,
    active: isActive,
    label,
  };
}

function formatContaAzulProductKind(raw) {
  const u = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (!u) return "";
  if (u.includes("SERV") || u === "SERVICE") return "Serviço";
  if (u.includes("PROD") && !u.includes("PRODUC")) return "Produto";
  if (u === "PRODUCT") return "Produto";
  return normalizeOptionalText(raw, 40) || "";
}

function normalizeContaAzulProduct(product) {
  const safe = product && typeof product === "object" ? product : {};
  const fiscal = safe.fiscal && typeof safe.fiscal === "object" ? safe.fiscal : {};
  const id = normalizeOptionalText(safe.id || safe.uuid || safe.produto_id || safe.id_produto, 120);
  const name = normalizeOptionalText(safe.nome || safe.name || safe.descricao || safe.description, 200);
  const sku = normalizeOptionalText(safe.sku || safe.codigo || safe.codigo_sku, 80);
  const kindRaw =
    safe.tipo ||
    safe.type ||
    safe.tipo_item ||
    safe.tipoItem ||
    safe.tipo_produto ||
    safe.tipoProduto ||
    fiscal.tipo_produto ||
    fiscal.tipoProduto ||
    safe.natureza ||
    safe.classificacao;
  const tipoRaw = normalizeOptionalText(kindRaw, 80) || null;
  const kind = formatContaAzulProductKind(kindRaw) || normalizeOptionalText(kindRaw, 40) || "";
  const label = [name || id || "Item sem nome", sku || null, kind || null].filter(Boolean).join(" · ");

  return {
    id: id || null,
    name: name || null,
    sku: sku || null,
    tipoRaw,
    kind: kind || null,
    label,
  };
}

/** Classifica item do GET /v1/produtos para filtrar serviço vs produto físico/kit. */
function contaAzulCatalogItemClass(item) {
  const raw = String(item?.tipoRaw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  const kind = String(item?.kind || "");
  if (raw.includes("SERV") || kind.includes("Serviço") || kind.includes("Servico")) return "servico";
  if (
    raw.includes("PROD") ||
    raw === "PRODUCT" ||
    raw.includes("KIT") ||
    raw.includes("VARIACAO") ||
    raw.includes("VARIAÇÃO") ||
    kind.includes("Produto")
  ) {
    return "produto";
  }
  return "unknown";
}

/**
 * @param {string} mode servicos | produtos | todos
 */
function filterContaAzulCatalogByMode(items, mode = "servicos") {
  const m = String(mode || "servicos").toLowerCase();
  if (m === "todos" || m === "all") return items;
  return items.filter((item) => {
    const cls = contaAzulCatalogItemClass(item);
    if (m === "produtos") return cls === "produto";
    // servicos: tudo que não é produto/kit/variação explícitos (a API muitas vezes omite `tipo` em serviços)
    return cls !== "produto";
  });
}

function normalizeContaAzulFinancialInstallment(installment, type) {
  const safeInstallment = installment && typeof installment === "object" ? installment : {};
  const event = safeInstallment.evento && typeof safeInstallment.evento === "object" ? safeInstallment.evento : {};
  const counterparty = safeInstallment.cliente || safeInstallment.fornecedor || safeInstallment.contato || event.contato || {};
  const amountCents = normalizeAmountCents(
    safeInstallment.total ??
      safeInstallment.valor ??
      safeInstallment.valor_total ??
      safeInstallment.valor_bruto ??
      safeInstallment.detalhe_valor?.valor_bruto ??
      safeInstallment.detalheValor?.valorBruto
  );
  const categories = Array.isArray(safeInstallment.categorias)
    ? safeInstallment.categorias.map(normalizeContaAzulFinancialCategory).filter((category) => category.id || category.name)
    : [];

  return {
    id: normalizeOptionalText(safeInstallment.id || safeInstallment.uuid || safeInstallment.id_parcela, 120) || null,
    eventId: normalizeOptionalText(event.id || event.uuid || safeInstallment.id_evento, 120) || null,
    type: normalizeContaAzulFinancialEventType(type),
    description: normalizeOptionalText(safeInstallment.descricao || safeInstallment.description || event.descricao, 240),
    dueDate: normalizeIsoDate(safeInstallment.data_vencimento || safeInstallment.dueDate),
    competenceDate: normalizeIsoDate(safeInstallment.data_competencia || event.data_competencia || safeInstallment.competenceDate),
    amountCents,
    amountFormatted: Number.isInteger(amountCents) ? formatMoneyBRL(amountCents) : "",
    status: normalizeOptionalText(safeInstallment.status || safeInstallment.status_traduzido, 80),
    counterpartyName: normalizeOptionalText(counterparty.nome || counterparty.name || counterparty.razao_social, 180),
    categories,
  };
}

function buildContaAzulPeoplePath({ profileType, search, page = 1, pageSize = 20 } = {}) {
  const params = new URLSearchParams();
  const safeProfileType = normalizeContaAzulPersonProfileType(profileType);
  if (safeProfileType) params.set("tipo_perfil", safeProfileType);
  const safeSearch = normalizeOptionalText(search, 160);
  if (safeSearch) params.set("busca", safeSearch);
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(clampInteger(pageSize, 1, 100, 20)));
  return `${CONTA_AZUL_PEOPLE_PATH}?${params.toString()}`;
}

function buildContaAzulFinancialAccountsPath({ search, page = 1, pageSize = 50 } = {}) {
  const params = new URLSearchParams();
  const safeSearch = normalizeOptionalText(search, 160);
  if (safeSearch) params.set("nome", safeSearch);
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(clampInteger(pageSize, 1, 100, 50)));
  return `${CONTA_AZUL_FINANCIAL_ACCOUNTS_PATH}?${params.toString()}`;
}

function buildContaAzulFinancialCategoriesPath({ search, type, page = 1, pageSize = 50, onlyChildren = true } = {}) {
  const params = new URLSearchParams();
  const safeSearch = normalizeOptionalText(search, 160);
  const safeType = normalizeContaAzulFinancialCategoryType(type);
  if (safeSearch) params.set("busca", safeSearch);
  if (safeType) params.set("tipo", safeType);
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(clampInteger(pageSize, 1, 500, 50)));
  if (onlyChildren !== false) params.set("apenas_filhos", "true");
  params.set("permite_apenas_filhos", onlyChildren === false ? "false" : "true");
  return `${CONTA_AZUL_FINANCIAL_CATEGORIES_PATH}?${params.toString()}`;
}

function buildContaAzulProductsPath({ search, page = 1, pageSize = 100, status } = {}) {
  const params = new URLSearchParams();
  const safeSearch = normalizeOptionalText(search, 160);
  if (safeSearch) params.set("busca", safeSearch);
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(normalizeContaAzulProductsPageSize(pageSize)));
  const safeStatus = normalizeOptionalText(status, 40);
  if (safeStatus) params.set("status", safeStatus);
  return `${CONTA_AZUL_PRODUCTS_PATH}?${params.toString()}`;
}

function buildContaAzulFinancialEventsSearchPath({
  type,
  from,
  to,
  page = 1,
  pageSize = 100,
  financialAccountId,
  amountCents,
  description,
  status,
} = {}) {
  const eventType = normalizeContaAzulFinancialEventType(type);
  const params = new URLSearchParams();
  const safeFrom = normalizeIsoDate(from);
  const safeTo = normalizeIsoDate(to) || safeFrom;
  const safeFinancialAccountId = normalizeOptionalText(financialAccountId, 160);
  const safeDescription = normalizeOptionalText(description, 160);
  const safeStatus = normalizeOptionalText(status, 80);
  const safeAmount = moneyCentsToDecimal(amountCents);
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(clampInteger(pageSize, 1, 1000, 100)));
  if (safeFrom) params.set("data_vencimento_de", safeFrom);
  if (safeTo) params.set("data_vencimento_ate", safeTo);
  if (safeFinancialAccountId) params.set("ids_contas_financeiras", safeFinancialAccountId);
  if (safeDescription) params.set("descricao", safeDescription);
  if (safeStatus) params.set("status", safeStatus);
  if (safeAmount > 0) {
    params.set("valor_de", String(safeAmount));
    params.set("valor_ate", String(safeAmount));
  }
  return `${eventType === "payable" ? CONTA_AZUL_PAYABLE_SEARCH_PATH : CONTA_AZUL_RECEIVABLE_SEARCH_PATH}?${params.toString()}`;
}

function buildContaAzulContractSearchPath({ search, customerId, from, to, page = 1, pageSize = 10, listPath } = {}) {
  const pathBase = normalizeEndpointPath(listPath, CONTA_AZUL_CONTRACTS_PATH);
  const params = new URLSearchParams();
  const safeSearch = normalizeOptionalText(search, 160);
  const safeCustomerId = normalizeOptionalText(customerId, 160);
  const safeFrom = normalizeIsoDate(from);
  const safeTo = normalizeIsoDate(to) || safeFrom;
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(clampInteger(pageSize, 1, 50, 10)));
  if (safeSearch) params.set("busca_textual", safeSearch);
  if (safeCustomerId) params.set("cliente_id", safeCustomerId);
  if (safeFrom) params.set("data_inicio", safeFrom);
  if (safeTo) params.set("data_fim", safeTo);
  return `${pathBase}?${params.toString()}`;
}

function buildContaAzulAcquittancePath(installmentId) {
  const safeInstallmentId = normalizeOptionalText(installmentId, 160);
  return CONTA_AZUL_ACQUITTANCE_PATH_TEMPLATE.replace("{parcela_id}", encodeURIComponent(safeInstallmentId || ""));
}

function createDefaultContaAzulSettings() {
  const defaultBase = normalizeContaAzulApiBaseUrl(readContaAzulEnvFirst("CONTA_AZUL_BASE_URL", "CONTA_AZUL_API_BASE_URL")) || CONTA_AZUL_API_BASE_URL;
  const defaultAuth = normalizeBaseUrl(readContaAzulEnvFirst("CONTA_AZUL_AUTH_URL")) || CONTA_AZUL_AUTH_URL;
  const defaultToken = normalizeBaseUrl(readContaAzulEnvFirst("CONTA_AZUL_TOKEN_URL")) || CONTA_AZUL_TOKEN_URL;
  const defaultScope = normalizeContaAzulScope(readContaAzulEnvFirst("CONTA_AZUL_SCOPE", "CONTA_AZUL_OAUTH_SCOPE") || CONTA_AZUL_DEFAULT_SCOPE);
  const defaultHealth = normalizeEndpointPath(
    readContaAzulEnvFirst("CONTA_AZUL_HEALTH_PATH", "CONTA_AZUL_HEALTH_ENDPOINT"),
    CONTA_AZUL_CONNECTED_ACCOUNT_PATH
  );
  return {
    enabled: false,
    accountLabel: "",
    baseUrl: defaultBase,
    authorizationUrl: defaultAuth,
    tokenUrl: defaultToken,
    redirectUri: normalizeContaAzulRedirectUri(process.env.CONTA_AZUL_REDIRECT_URI),
    clientId: normalizeOptionalText(process.env.CONTA_AZUL_CLIENT_ID, 200) || "",
    clientSecret: normalizeOptionalText(process.env.CONTA_AZUL_CLIENT_SECRET, 600) || "",
    scope: defaultScope,
    authMode: normalizeContaAzulAuthModeFromEnv(),
    accessToken: normalizeOptionalText(process.env.CONTA_AZUL_ACCESS_TOKEN, 4096) || "",
    refreshToken: normalizeOptionalText(process.env.CONTA_AZUL_REFRESH_TOKEN, 4096) || "",
    tokenType: normalizeOptionalText(readContaAzulEnvFirst("CONTA_AZUL_TOKEN_TYPE", "CONTA_AZUL_ACCESS_TOKEN_TYPE") || "Bearer", 40) || "Bearer",
    accessTokenExpiresAt: null,
    customHeaderName: normalizeHeaderName(process.env.CONTA_AZUL_CUSTOM_HEADER_NAME),
    customHeaderValue: normalizeOptionalText(process.env.CONTA_AZUL_CUSTOM_HEADER_VALUE, 600) || "",
    healthEndpoint: defaultHealth,
    allowOutbound: true,
    connectedAccount: {
      id: null,
      companyName: null,
      tradeName: null,
      document: null,
      email: null,
    },
    fpaExport: {
      enabled: false,
      defaultContactId: "",
      defaultFinancialAccountId: "",
      defaultReceivableCategoryId: "",
      defaultPayableCategoryId: "",
      payablePath: CONTA_AZUL_PAYABLE_EVENT_PATH,
      receivablePath: CONTA_AZUL_RECEIVABLE_EVENT_PATH,
      exportOnlyUnsent: true,
      includeInternalTransfers: false,
      markAsExported: true,
      maxRecordsPerRun: 50,
    },
    lovableContracts: buildInitialLovableContractsFromEnv(),
    status: {
      lastConnectionCheckAt: null,
      lastConnectionOk: false,
      lastAuthorizedAt: null,
      lastTokenRefreshAt: null,
      oauthState: null,
      oauthStateIssuedAt: null,
      lastPushAt: null,
      lastPushResource: null,
      lastPushStatus: "idle",
      lastError: null,
    },
    syncHistory: [],
  };
}

function normalizeContaAzulHistoryEntry(entry) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const resourceOptions = [
    CONTA_AZUL_FPA_EXPORT_RESOURCE,
    CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE,
    CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE,
    "oauth",
  ];
  return {
    id:
      normalizeOptionalText(safeEntry.id, 80) ||
      `caz_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: normalizeEnum(safeEntry.kind, ["connection", "preview", "push", "oauth"], "push"),
    direction: normalizeEnum(safeEntry.direction, ["inbound", "outbound"], "outbound"),
    resource: normalizeEnum(safeEntry.resource, resourceOptions, CONTA_AZUL_FPA_EXPORT_RESOURCE),
    status: normalizeEnum(safeEntry.status, ["success", "error", "preview", "ignored"], "success"),
    endpoint: normalizeOptionalText(safeEntry.endpoint, 260),
    summary: normalizeOptionalText(safeEntry.summary, 260),
    errorMessage: normalizeOptionalText(safeEntry.errorMessage, 400) || null,
    recordCount: clampInteger(safeEntry.recordCount, 0, 5000, 0),
    responseCode: Number.isFinite(Number(safeEntry.responseCode)) ? Math.trunc(Number(safeEntry.responseCode)) : null,
    startedAt: safeEntry.startedAt || null,
    finishedAt: safeEntry.finishedAt || null,
  };
}

function readContaAzulEnvFirst(...keys) {
  for (const key of keys) {
    const value = String((key && process.env[key]) || "").trim();
    if (value) return value;
  }
  return "";
}

function getBaseLovableContractDefaults() {
  return {
    contractsCreatePath: CONTA_AZUL_CONTRACTS_PATH,
    nextContractNumberPath: CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH,
    defaultContractFinancialAccountId: CONTA_AZUL_DEFAULT_CONTRACT_FINANCIAL_ACCOUNT_ID,
    contractAmountInputUnit: "centavos",
    financeProductMappings: [],
    financePaymentMappings: [],
  };
}

function normalizeFinanceProductMappingEntry(entry, index) {
  const safe = entry && typeof entry === "object" ? entry : {};
  return {
    id: normalizeOptionalText(safe.id, 80) || `fpm_${index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    financeProductId: normalizeOptionalText(safe.financeProductId, 200) || "",
    financeProductLabel: normalizeOptionalText(safe.financeProductLabel, 240) || "",
    contaAzulItemId: normalizeOptionalText(safe.contaAzulItemId, 160) || "",
  };
}

function normalizeFinancePaymentItemValorReais(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const cents = parseMoneyStringToCentavos(String(value));
  if (!cents && String(value).trim() !== "0" && String(value).trim() !== "0,00") return null;
  return Math.max(0, cents / 100);
}

function normalizeFinancePaymentMappingEntry(entry, index) {
  const safe = entry && typeof entry === "object" ? entry : {};
  const itemValor = normalizeFinancePaymentItemValorReais(safe.contaAzulItemValor);
  return {
    id: normalizeOptionalText(safe.id, 80) || `fpay_${index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    financePaymentKey: normalizeOptionalText(safe.financePaymentKey, 120) || "",
    financePaymentLabel: normalizeOptionalText(safe.financePaymentLabel, 240) || "",
    contaAzulTipoPagamento: normalizeOptionalText(safe.contaAzulTipoPagamento, 80) || "",
    contaAzulFinancialAccountId: normalizeOptionalText(safe.contaAzulFinancialAccountId, 160) || "",
    contaAzulItemId: normalizeOptionalText(safe.contaAzulItemId, 160) || "",
    contaAzulItemValor: itemValor,
  };
}

function buildInitialLovableContractsFromEnv() {
  return normalizeContaAzulLovableContractSettings(
    {
      contractsCreatePath: readContaAzulEnvFirst("CONTA_AZUL_CONTRACTS_PATH"),
      nextContractNumberPath: readContaAzulEnvFirst("CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH"),
      defaultContractFinancialAccountId: readContaAzulEnvFirst("CONTA_AZUL_DEFAULT_CONTRACT_FINANCIAL_ACCOUNT_ID"),
      contractAmountInputUnit: readContaAzulEnvFirst("CONTA_AZUL_CONTRACT_AMOUNT_UNIT"),
    },
    getBaseLovableContractDefaults()
  );
}

function normalizeContaAzulLovableContractSettings(rawSettings, fallback) {
  const safe = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
  const base = fallback && typeof fallback === "object" ? fallback : getBaseLovableContractDefaults();
  const amountUnit = normalizeEnum(safe.contractAmountInputUnit, ["centavos", "reais"], base.contractAmountInputUnit);
  const productRows = Array.isArray(safe.financeProductMappings)
    ? safe.financeProductMappings.map(normalizeFinanceProductMappingEntry).filter((m) => m.financeProductId && m.contaAzulItemId)
    : base.financeProductMappings;
  const paymentRows = Array.isArray(safe.financePaymentMappings)
    ? safe.financePaymentMappings
        .map(normalizeFinancePaymentMappingEntry)
        .filter(
          (m) =>
            m.financePaymentKey &&
            (m.contaAzulTipoPagamento ||
              m.contaAzulFinancialAccountId ||
              m.contaAzulItemId ||
              m.contaAzulItemValor != null)
        )
    : base.financePaymentMappings;
  return {
    contractsCreatePath: normalizeEndpointPath(safe.contractsCreatePath, base.contractsCreatePath),
    nextContractNumberPath: normalizeEndpointPath(safe.nextContractNumberPath, base.nextContractNumberPath),
    defaultContractFinancialAccountId:
      normalizeOptionalText(safe.defaultContractFinancialAccountId, 160) || base.defaultContractFinancialAccountId,
    contractAmountInputUnit: amountUnit,
    financeProductMappings: productRows.slice(0, 500),
    financePaymentMappings: paymentRows.slice(0, 200),
  };
}

function getContaAzulLovableContractPaths(settings) {
  const s = normalizeContaAzulSettings(settings);
  return s.lovableContracts;
}

function normalizeContaAzulAuthModeFromEnv() {
  const raw = readContaAzulEnvFirst("CONTA_AZUL_AUTH_MODE").toLowerCase();
  if (raw === "custom_header" || raw === "none") return raw;
  return "bearer";
}

function normalizeContaAzulFpaExportSettings(rawSettings, defaults = createDefaultContaAzulSettings().fpaExport) {
  const safeSettings = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
  return {
    enabled: safeSettings.enabled === true,
    defaultContactId: normalizeOptionalText(safeSettings.defaultContactId, 160),
    defaultFinancialAccountId: normalizeOptionalText(safeSettings.defaultFinancialAccountId, 160),
    defaultReceivableCategoryId: normalizeOptionalText(safeSettings.defaultReceivableCategoryId, 160),
    defaultPayableCategoryId: normalizeOptionalText(safeSettings.defaultPayableCategoryId, 160),
    payablePath: normalizeEndpointPath(safeSettings.payablePath, defaults.payablePath),
    receivablePath: normalizeEndpointPath(safeSettings.receivablePath, defaults.receivablePath),
    exportOnlyUnsent: safeSettings.exportOnlyUnsent !== false,
    includeInternalTransfers: safeSettings.includeInternalTransfers === true,
    markAsExported: safeSettings.markAsExported !== false,
    maxRecordsPerRun: clampInteger(safeSettings.maxRecordsPerRun, 1, 500, defaults.maxRecordsPerRun),
  };
}

function normalizeContaAzulSettings(rawSettings) {
  const defaults = createDefaultContaAzulSettings();
  const safeSettings = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
  const safeStatus = safeSettings.status && typeof safeSettings.status === "object" ? safeSettings.status : {};

  return {
    enabled: safeSettings.enabled === true,
    accountLabel: normalizeOptionalText(safeSettings.accountLabel, 120),
    baseUrl: normalizeContaAzulApiBaseUrl(safeSettings.baseUrl) || defaults.baseUrl,
    authorizationUrl: normalizeBaseUrl(safeSettings.authorizationUrl) || defaults.authorizationUrl,
    tokenUrl: normalizeBaseUrl(safeSettings.tokenUrl) || defaults.tokenUrl,
    redirectUri: "redirectUri" in safeSettings ? normalizeContaAzulRedirectUri(safeSettings.redirectUri) : defaults.redirectUri,
    clientId: "clientId" in safeSettings ? normalizeOptionalText(safeSettings.clientId, 200) : defaults.clientId,
    clientSecret: "clientSecret" in safeSettings ? normalizeOptionalText(safeSettings.clientSecret, 600) : defaults.clientSecret,
    scope: normalizeContaAzulScope(safeSettings.scope || defaults.scope),
    authMode: normalizeEnum(safeSettings.authMode, ["bearer", "custom_header", "none"], defaults.authMode),
    accessToken: normalizeOptionalText(safeSettings.accessToken, 4096),
    refreshToken: normalizeOptionalText(safeSettings.refreshToken, 4096),
    tokenType: normalizeOptionalText(safeSettings.tokenType, 40) || defaults.tokenType,
    accessTokenExpiresAt: safeSettings.accessTokenExpiresAt || null,
    customHeaderName: normalizeHeaderName(safeSettings.customHeaderName),
    customHeaderValue: normalizeOptionalText(safeSettings.customHeaderValue, 600),
    healthEndpoint: normalizeEndpointPath(safeSettings.healthEndpoint, defaults.healthEndpoint),
    allowOutbound: safeSettings.allowOutbound !== false,
    connectedAccount: normalizeContaAzulConnectedAccount(safeSettings.connectedAccount),
    fpaExport: normalizeContaAzulFpaExportSettings(safeSettings.fpaExport, defaults.fpaExport),
    lovableContracts: normalizeContaAzulLovableContractSettings(
      safeSettings.lovableContracts,
      defaults.lovableContracts
    ),
    status: {
      lastConnectionCheckAt: safeStatus.lastConnectionCheckAt || null,
      lastConnectionOk: safeStatus.lastConnectionOk === true,
      lastAuthorizedAt: safeStatus.lastAuthorizedAt || null,
      lastTokenRefreshAt: safeStatus.lastTokenRefreshAt || null,
      oauthState: normalizeOptionalText(safeStatus.oauthState, 160) || null,
      oauthStateIssuedAt: safeStatus.oauthStateIssuedAt || null,
      lastPushAt: safeStatus.lastPushAt || null,
      lastPushResource: normalizeEnum(
        safeStatus.lastPushResource,
        [CONTA_AZUL_FPA_EXPORT_RESOURCE, CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE, CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE, "oauth", ""],
        null
      ),
      lastPushStatus: normalizeEnum(safeStatus.lastPushStatus, ["idle", "preview", "success", "error"], defaults.status.lastPushStatus),
      lastError: normalizeOptionalText(safeStatus.lastError, 400) || null,
    },
    syncHistory: Array.isArray(safeSettings.syncHistory)
      ? safeSettings.syncHistory.map(normalizeContaAzulHistoryEntry).slice(0, 20)
      : [],
  };
}

function sanitizeContaAzulSettings(rawSettings) {
  const settings = normalizeContaAzulSettings(rawSettings);
  const hasAccessToken = Boolean(settings.accessToken);
  const hasRefreshToken = Boolean(settings.refreshToken);
  return {
    ...settings,
    clientSecret: "",
    hasClientSecret: Boolean(settings.clientSecret),
    accessToken: "",
    hasAccessToken,
    refreshToken: "",
    hasRefreshToken,
    customHeaderValue: "",
    hasCustomHeaderValue: Boolean(settings.customHeaderValue),
    isOAuthReady: Boolean(settings.clientId && settings.clientSecret && settings.redirectUri),
    hasValidToken: hasAccessToken && !isContaAzulAccessTokenExpired(settings, 0),
  };
}

function isContaAzulAccessTokenExpired(settings, bufferSeconds = 60) {
  const safeSettings = normalizeContaAzulSettings(settings);
  if (!safeSettings.accessTokenExpiresAt) return false;
  const expiresAtMs = new Date(safeSettings.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return Date.now() + Math.max(0, Number(bufferSeconds) || 0) * 1000 >= expiresAtMs;
}

function encodeContaAzulScope(value) {
  return String(value || CONTA_AZUL_DEFAULT_SCOPE).trim().replace(/\s+/g, "+");
}

function encodeContaAzulRedirectUri(value) {
  const redirectUri = normalizeBaseUrl(value);
  if (!redirectUri) return "";
  try {
    const url = new URL(redirectUri);
    if (!url.search && !url.hash) return redirectUri;
  } catch {
    return "";
  }
  return encodeURIComponent(redirectUri);
}

function buildContaAzulAuthorizationUrl(settings, stateToken) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const base = safeSettings.authorizationUrl || CONTA_AZUL_AUTH_URL;
  const query = [
    "response_type=code",
    `client_id=${encodeURIComponent(safeSettings.clientId || "")}`,
    `redirect_uri=${encodeContaAzulRedirectUri(safeSettings.redirectUri || "")}`,
    `state=${encodeURIComponent(String(stateToken || "").trim())}`,
    `scope=${encodeContaAzulScope(safeSettings.scope || CONTA_AZUL_DEFAULT_SCOPE)}`,
  ].join("&");
  return `${base}?${query}`;
}

function buildContaAzulTokenHeaders(settings) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const basicValue = Buffer.from(
    `${safeSettings.clientId || ""}:${safeSettings.clientSecret || ""}`,
    "utf8"
  ).toString("base64");
  return {
    Accept: "application/json",
    Authorization: `Basic ${basicValue}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function applyContaAzulTokenPayload(currentSettings, tokenPayload) {
  const safeCurrentSettings = normalizeContaAzulSettings(currentSettings);
  const safeTokenPayload = tokenPayload && typeof tokenPayload === "object" ? tokenPayload : {};
  const expiresIn = Number(safeTokenPayload.expires_in);
  const accessTokenExpiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : safeCurrentSettings.accessTokenExpiresAt;

  return normalizeContaAzulSettings({
    ...safeCurrentSettings,
    accessToken:
      normalizeOptionalText(safeTokenPayload.access_token, 4096) || safeCurrentSettings.accessToken,
    refreshToken:
      normalizeOptionalText(safeTokenPayload.refresh_token, 4096) || safeCurrentSettings.refreshToken,
    tokenType: normalizeOptionalText(safeTokenPayload.token_type, 40) || safeCurrentSettings.tokenType,
    accessTokenExpiresAt,
  });
}

function mergeContaAzulSettings(currentSettings, patchSettings) {
  const current = normalizeContaAzulSettings(currentSettings);
  const patch = patchSettings && typeof patchSettings === "object" ? patchSettings : {};
  const safeStatus = patch.status && typeof patch.status === "object" ? patch.status : {};
  const safeFpaExport = patch.fpaExport && typeof patch.fpaExport === "object" ? patch.fpaExport : null;
  const safeLovableContracts = patch.lovableContracts && typeof patch.lovableContracts === "object" ? patch.lovableContracts : null;

  const merged = {
    ...current,
    enabled: "enabled" in patch ? patch.enabled === true : current.enabled,
    accountLabel: "accountLabel" in patch ? normalizeOptionalText(patch.accountLabel, 120) : current.accountLabel,
    baseUrl: "baseUrl" in patch ? normalizeContaAzulApiBaseUrl(patch.baseUrl) : current.baseUrl,
    authorizationUrl: "authorizationUrl" in patch ? normalizeBaseUrl(patch.authorizationUrl) : current.authorizationUrl,
    tokenUrl: "tokenUrl" in patch ? normalizeBaseUrl(patch.tokenUrl) : current.tokenUrl,
    redirectUri: "redirectUri" in patch ? normalizeContaAzulRedirectUri(patch.redirectUri) : current.redirectUri,
    clientId: "clientId" in patch ? normalizeOptionalText(patch.clientId, 200) : current.clientId,
    scope: "scope" in patch ? normalizeContaAzulScope(patch.scope) : current.scope,
    authMode: "authMode" in patch ? patch.authMode : current.authMode,
    tokenType: "tokenType" in patch ? normalizeOptionalText(patch.tokenType, 40) : current.tokenType,
    accessTokenExpiresAt: "accessTokenExpiresAt" in patch ? patch.accessTokenExpiresAt || null : current.accessTokenExpiresAt,
    customHeaderName: "customHeaderName" in patch ? patch.customHeaderName : current.customHeaderName,
    healthEndpoint: "healthEndpoint" in patch ? patch.healthEndpoint : current.healthEndpoint,
    allowOutbound: "allowOutbound" in patch ? patch.allowOutbound === true : current.allowOutbound,
    connectedAccount: "connectedAccount" in patch ? normalizeContaAzulConnectedAccount(patch.connectedAccount) : current.connectedAccount,
    fpaExport: safeFpaExport
      ? normalizeContaAzulFpaExportSettings({
          ...current.fpaExport,
          ...safeFpaExport,
        })
      : current.fpaExport,
    lovableContracts: safeLovableContracts
      ? normalizeContaAzulLovableContractSettings(
          { ...current.lovableContracts, ...safeLovableContracts },
          current.lovableContracts
        )
      : current.lovableContracts,
    status: {
      ...current.status,
      ...safeStatus,
    },
    syncHistory: Array.isArray(patch.syncHistory) ? patch.syncHistory : current.syncHistory,
  };

  if (patch.clearClientSecret === true) {
    merged.clientSecret = "";
  } else if ("clientSecret" in patch) {
    const nextClientSecret = normalizeOptionalText(patch.clientSecret, 600);
    merged.clientSecret = nextClientSecret || current.clientSecret;
  } else {
    merged.clientSecret = current.clientSecret;
  }

  if (patch.clearAccessToken === true) {
    merged.accessToken = "";
  } else if ("accessToken" in patch) {
    const nextToken = normalizeOptionalText(patch.accessToken, 4096);
    merged.accessToken = nextToken || current.accessToken;
  } else {
    merged.accessToken = current.accessToken;
  }

  if (patch.clearRefreshToken === true) {
    merged.refreshToken = "";
  } else if ("refreshToken" in patch) {
    const nextRefreshToken = normalizeOptionalText(patch.refreshToken, 4096);
    merged.refreshToken = nextRefreshToken || current.refreshToken;
  } else {
    merged.refreshToken = current.refreshToken;
  }

  if (patch.clearCustomHeaderValue === true) {
    merged.customHeaderValue = "";
  } else if ("customHeaderValue" in patch) {
    const nextHeaderValue = normalizeOptionalText(patch.customHeaderValue, 600);
    merged.customHeaderValue = nextHeaderValue || current.customHeaderValue;
  } else {
    merged.customHeaderValue = current.customHeaderValue;
  }

  return normalizeContaAzulSettings(merged);
}

function prependContaAzulSyncHistory(existingHistory, entry) {
  return [normalizeContaAzulHistoryEntry(entry), ...(Array.isArray(existingHistory) ? existingHistory : [])].slice(0, 20);
}

function hasContaAzulFpaExport(transaction) {
  return transaction?.integration?.contaAzul?.status === "success";
}

function normalizeContaAzulFinancialEventType(value) {
  return String(value || "").trim() === "payable" ? "payable" : "receivable";
}

function normalizeIsoDate(value) {
  const raw = normalizeOptionalText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

/** Aceita ISO completo, data curta e timestamps vindos do Finance. */
function normalizeIsoDateFromFinance(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const t = new Date(value).getTime();
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${day}`;
  }
  return normalizeIsoDate(value);
}

function getContaAzulFpaExportCandidates({ settings, transactions }) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const exportSettings = safeSettings.fpaExport;
  return (Array.isArray(transactions) ? transactions : [])
    .filter((transaction) => {
      if (!exportSettings.includeInternalTransfers && transaction.isInternalTransfer) return false;
      if (exportSettings.exportOnlyUnsent && hasContaAzulFpaExport(transaction)) return false;
      return Number(transaction.amountCents || 0) !== 0;
    })
    .slice(0, exportSettings.maxRecordsPerRun);
}

function buildContaAzulFpaFinancialEventRecord(transaction, settings) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const exportSettings = safeSettings.fpaExport;
  const amountCents = Number(transaction?.amountCents || 0);
  const isReceivable = amountCents >= 0;
  const amount = Math.round(Math.abs(amountCents)) / 100;
  const endpointPath = isReceivable ? exportSettings.receivablePath : exportSettings.payablePath;
  const defaultCategoryId = isReceivable ? exportSettings.defaultReceivableCategoryId : exportSettings.defaultPayableCategoryId;
  const missingRequiredFields = [];

  if (!exportSettings.defaultContactId) missingRequiredFields.push("contato");
  if (!exportSettings.defaultFinancialAccountId) missingRequiredFields.push("conta_financeira");
  if (!defaultCategoryId) missingRequiredFields.push(isReceivable ? "categoria_receita" : "categoria_despesa");

  const description = normalizeOptionalText(transaction?.description, 240) || "Lançamento financeiro FP&A";
  const observation = [
    "Origem: Analista FP&A",
    `Conta: ${transaction?.accountName || "Sem conta"}`,
    `Categoria: ${transaction?.category || "Sem categoria"}`,
    transaction?.reference ? `Referência: ${transaction.reference}` : "",
    `ID local: ${transaction?.id || ""}`,
  ].filter(Boolean).join(" | ");

  return {
    localId: transaction?.id || null,
    type: isReceivable ? "receivable" : "payable",
    endpointPath,
    amountCents,
    amountFormatted: formatMoneyBRL(Math.abs(amountCents)),
    transactionDate: transaction?.transactionDate || null,
    category: transaction?.category || null,
    accountName: transaction?.accountName || null,
    missingRequiredFields,
    payload: {
      data_competencia: transaction?.transactionDate || null,
      valor: amount,
      observacao: truncateText(observation, 500),
      descricao: description,
      contato: exportSettings.defaultContactId || null,
      conta_financeira: exportSettings.defaultFinancialAccountId || null,
      rateio: [
        {
          id_categoria: defaultCategoryId || null,
          valor: amount,
        },
      ],
      condicao_pagamento: {
        parcelas: [
          {
            descricao: description,
            data_vencimento: transaction?.transactionDate || null,
            nota: truncateText(observation, 240),
            conta_financeira: exportSettings.defaultFinancialAccountId || null,
            detalhe_valor: {
              valor_bruto: amount,
              valor_liquido: amount,
            },
          },
        ],
      },
    },
  };
}

function buildContaAzulTestFinancialEventRecord({
  settings,
  type,
  description,
  amountCents,
  competenceDate,
  dueDate,
  contactId,
  financialAccountId,
  categoryId,
  notes,
}) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const exportSettings = safeSettings.fpaExport;
  const eventType = normalizeContaAzulFinancialEventType(type);
  const safeAmountCents = Math.abs(Math.round(Number(amountCents) || 0));
  const amount = safeAmountCents / 100;
  const safeCompetenceDate = normalizeIsoDate(competenceDate) || new Date().toISOString().slice(0, 10);
  const safeDueDate = normalizeIsoDate(dueDate) || safeCompetenceDate;
  const safeContactId = normalizeOptionalText(contactId, 160) || exportSettings.defaultContactId;
  const safeFinancialAccountId = normalizeOptionalText(financialAccountId, 160) || exportSettings.defaultFinancialAccountId;
  const safeCategoryId = normalizeOptionalText(categoryId, 160);
  const safeDescription =
    normalizeOptionalText(description, 240) ||
    (eventType === "receivable" ? "TESTE FP&A - Conta a receber" : "TESTE FP&A - Conta a pagar");
  const safeNotes = normalizeOptionalText(notes, 300);
  const endpointPath = eventType === "receivable" ? exportSettings.receivablePath : exportSettings.payablePath;
  const missingRequiredFields = [];

  if (!safeContactId) missingRequiredFields.push("contato");
  if (!safeFinancialAccountId) missingRequiredFields.push("conta_financeira");
  if (!safeCategoryId) missingRequiredFields.push("categoria_financeira");
  if (!safeAmountCents) missingRequiredFields.push("valor");
  if (!safeCompetenceDate) missingRequiredFields.push("data_competencia");
  if (!safeDueDate) missingRequiredFields.push("data_vencimento");

  const observation = [
    "Origem: Analista FP&A",
    "Tipo: lançamento manual de teste",
    eventType === "receivable" ? "Movimento: contas a receber" : "Movimento: contas a pagar",
    safeNotes,
  ].filter(Boolean).join(" | ");

  return {
    localId: null,
    type: eventType,
    endpointPath,
    amountCents: safeAmountCents,
    amountFormatted: formatMoneyBRL(safeAmountCents),
    transactionDate: safeCompetenceDate,
    dueDate: safeDueDate,
    description: safeDescription,
    missingRequiredFields,
    payload: {
      data_competencia: safeCompetenceDate,
      valor: amount,
      observacao: truncateText(observation, 500),
      descricao: safeDescription,
      contato: safeContactId || null,
      conta_financeira: safeFinancialAccountId || null,
      rateio: [
        {
          id_categoria: safeCategoryId || null,
          valor: amount,
        },
      ],
      condicao_pagamento: {
        parcelas: [
          {
            descricao: safeDescription,
            data_vencimento: safeDueDate,
            nota: truncateText(observation, 240),
            conta_financeira: safeFinancialAccountId || null,
            detalhe_valor: {
              valor_bruto: amount,
              valor_liquido: amount,
            },
          },
        ],
      },
    },
  };
}

function compactContaAzulPayload(value) {
  if (Array.isArray(value)) {
    return value.map(compactContaAzulPayload).filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const compacted = {};
  Object.entries(value).forEach(([key, entry]) => {
    const nextValue = compactContaAzulPayload(entry);
    if (nextValue === undefined || nextValue === null || nextValue === "") return;
    if (Array.isArray(nextValue) && !nextValue.length) return;
    if (typeof nextValue === "object" && !Array.isArray(nextValue) && !Object.keys(nextValue).length) return;
    compacted[key] = nextValue;
  });
  return compacted;
}

/**
 * Mescla o payload canônico calculado a partir do webhook com `contaAzulContractPayload` / `contaAzulPayload` opcional.
 * Um objeto vindo do Lovable com `{}` (ou parcial) não pode substituir o payload inteiro — caso contrário
 * faltam id_conta_financeira, itens e valor.
 */
function mergeContaAzulLovableContractPayload(base, override) {
  if (!override || typeof override !== "object") return { ...base };
  const o = { ...base, ...override };
  o.termos = { ...base.termos, ...override.termos };
  o.composicao_de_valor = { ...base.composicao_de_valor, ...override.composicao_de_valor };
  const baseCond = base.condicao_pagamento && typeof base.condicao_pagamento === "object" ? base.condicao_pagamento : {};
  const ovCond = override.condicao_pagamento && typeof override.condicao_pagamento === "object" ? override.condicao_pagamento : {};
  o.condicao_pagamento = { ...baseCond, ...ovCond };
  if (!normalizeOptionalText(ovCond.id_conta_financeira, 160)) {
    o.condicao_pagamento = { ...o.condicao_pagamento, id_conta_financeira: baseCond.id_conta_financeira };
  }
  const baseItens = Array.isArray(base.itens) ? base.itens : [];
  if (Array.isArray(override.itens) && override.itens.length) {
    o.itens = override.itens.map((row, i) => ({
      ...((i === 0 && baseItens[0]) || {}),
      ...row,
    }));
  } else {
    o.itens = baseItens;
  }
  const b0 = baseItens[0] || {};
  if (o.itens?.[0]) {
    const row0 = { ...o.itens[0] };
    if (!normalizeOptionalText(row0.id, 160) && normalizeOptionalText(b0.id, 160)) {
      row0.id = b0.id;
    }
    if (!Number.isFinite(Number(row0.valor)) && Number.isFinite(Number(b0.valor))) {
      row0.valor = b0.valor;
    }
    o.itens[0] = row0;
  }
  if (o.termos && (o.termos.numero == null || o.termos.numero === "") && base.termos?.numero != null) {
    o.termos = { ...o.termos, numero: base.termos.numero };
  }
  return o;
}

function normalizeContaAzulContractFrequency(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (["ANUAL", "ANNUAL", "YEARLY", "YEAR"].includes(raw)) return "ANUAL";
  return "MENSAL";
}

function normalizeContaAzulContractExpiration(value, endDate) {
  const raw = String(value || "").trim().toUpperCase();
  if (["NUNCA", "NEVER", "NONE", "SEM_FIM"].includes(raw)) return "NUNCA";
  return endDate ? "DATA" : "NUNCA";
}

function normalizeContaAzulPaymentMethod(value, fallback = "BOLETO_BANCARIO") {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases = {
    BOLETO: "BOLETO_BANCARIO",
    CARTAO: "CARTAO_CREDITO",
    CARTAO_CREDITO: "CARTAO_CREDITO",
    CARTAO_DEBITO: "CARTAO_DEBITO",
    CREDITO: "CARTAO_CREDITO",
    DEBITO: "CARTAO_DEBITO",
    DEPOSITO: "DEPOSITO_BANCARIO",
    TRANSFERENCIA: "TRANSFERENCIA_BANCARIA",
    TED: "TRANSFERENCIA_BANCARIA",
    DOC: "TRANSFERENCIA_BANCARIA",
  };
  return aliases[raw] || raw || fallback;
}

function normalizeContaAzulDueDay(value, fallbackDate) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return Math.min(Math.max(1, Math.trunc(parsed)), 31);
  const date = normalizeIsoDate(fallbackDate);
  if (date) return Math.min(Math.max(1, Number(date.slice(8, 10)) || 1), 31);
  return 1;
}

function normalizeContaAzulContractResponse(responseBody) {
  const safeBody = responseBody && typeof responseBody === "object" ? responseBody : {};
  return {
    id: normalizeOptionalText(safeBody.id || safeBody.uuid || safeBody.id_contrato, 160) || null,
    legacyId: Number.isFinite(Number(safeBody.id_legado)) ? Math.trunc(Number(safeBody.id_legado)) : null,
    saleId: normalizeOptionalText(safeBody.id_venda || safeBody.saleId || safeBody.venda_id, 160) || null,
    raw: safeBody,
  };
}

function normalizeContaAzulAcquittanceResponse(responseBody) {
  const safeBody = responseBody && typeof responseBody === "object" ? responseBody : {};
  return {
    id: normalizeOptionalText(safeBody.id || safeBody.uuid || safeBody.id_baixa, 160) || null,
    installmentId: normalizeOptionalText(safeBody.id_parcela || safeBody.parcela_id, 160) || null,
    reconciliationId: normalizeOptionalText(safeBody.id_reconciliacao, 160) || null,
    paymentDate: normalizeIsoDate(safeBody.data_pagamento),
    raw: safeBody,
  };
}

const CONTRACT_MONEY_CENTAVOS_PATHS = [
  "amountCents",
  "valueCents",
  "monthlyAmountCents",
  "valorCentavos",
  "valor_centavos",
  "item.valorCentavos",
];
const CONTRACT_MONEY_DECIMAL_PATHS = [
  "amount",
  "value",
  "monthlyAmount",
  "valor",
  "valorMensal",
  "valor_mensal",
  "target_amount",
  "targetAmount",
  "monthly_value",
  "monthlyValue",
  "price",
  "monthly_price",
  "preco",
  "preco_mensal",
  "total",
  "total_value",
  "totalValue",
  "valor_total",
  "item.valor",
  "item.amount",
  "item.price",
  "servico.valor",
  "billing.amount",
  "billing.valor",
  "billing.price",
  "billing.value",
];

function parseMoneyStringToCentavos(s) {
  const raw = String(s || "")
    .trim()
    .replace(/[^\d,.-]+/g, "");
  if (!raw) return 0;
  const hasComma = raw.includes(",");
  const normalized = hasComma ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 100));
}

/**
 * Modo "centavos" (visão moeda do Finance): inteiro = centavos; decimal BR ou float = reais.
 */
function pickContractAmountInCentavosFromFinance(contract) {
  const paths = [...CONTRACT_MONEY_CENTAVOS_PATHS, ...CONTRACT_MONEY_DECIMAL_PATHS];
  const v = pickFirstNested(contract, paths);
  if (v == null || v === "") return 0;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (Number.isInteger(v)) return Math.max(0, v);
    return Math.max(0, Math.round(v * 100));
  }
  return parseMoneyStringToCentavos(String(v));
}

function resolveContaAzulItemFromProductMapping(contract, mappings) {
  if (!Array.isArray(mappings) || !mappings.length) return "";
  const candidateKeys = new Set();
  for (const path of [
    "productId",
    "financeProductId",
    "sku",
    "codigo_produto",
    "plano_id",
    "servico_codigo",
    "id_produto_finance",
    "billing.productId",
    "billing.sku",
    "billing.financeProductId",
  ]) {
    const v = readNestedValue(contract, path);
    if (v != null && v !== "") candidateKeys.add(String(v).trim());
  }
  for (const m of mappings) {
    if (!m?.financeProductId || !m?.contaAzulItemId) continue;
    if (candidateKeys.has(String(m.financeProductId).trim())) return m.contaAzulItemId;
  }
  return "";
}

function resolveFinancePaymentMapping(rawKey, mappings) {
  if (rawKey == null || rawKey === "" || !Array.isArray(mappings)) return null;
  const k = String(rawKey).trim().toLowerCase();
  for (const m of mappings) {
    if (!m?.financePaymentKey) continue;
    if (String(m.financePaymentKey).trim().toLowerCase() !== k) continue;
    return m;
  }
  return null;
}

function resolveContaAzulPaymentFromMapping(rawKey, mappings) {
  const row = resolveFinancePaymentMapping(rawKey, mappings);
  return row?.contaAzulTipoPagamento ? row.contaAzulTipoPagamento : "";
}

function buildContaAzulContractRecord({ settings, source, nextContractNumber, financePaymentLinks } = {}) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const lc = safeSettings.lovableContracts;
  const baseSource = source && typeof source === "object" ? source : {};
  const nestedContract = baseSource.contract && typeof baseSource.contract === "object" ? baseSource.contract : {};
  const contract = { ...baseSource, ...nestedContract };
  const safeLinks = Array.isArray(financePaymentLinks) ? financePaymentLinks : [];
  const rawFinancePaymentMethod = String(
    pickFirstNested(contract, ["paymentMethod", "tipoPagamento", "billing.paymentMethod", "formaPagamento", "forma_pagamento", "payment_method"]) || ""
  ).trim();
  const rawFinanceCategory = String(
    pickFirstNested(contract, ["categoria", "category", "categoria_produto", "product_category", "service_category", "serviceCategory", "billing.categoria", "billing.category"]) || ""
  ).trim();
  const linkedByCategory = rawFinanceCategory
    ? safeLinks.find((l) => l.financeCategory && l.financeCategory.toUpperCase() === rawFinanceCategory.toUpperCase()) || null
    : null;
  const linkedByMethod = rawFinancePaymentMethod
    ? safeLinks.find((l) => l.financePaymentMethod && l.financePaymentMethod.toUpperCase() === rawFinancePaymentMethod.toUpperCase()) || null
    : null;
  const payloadOverride =
    (contract.contaAzulPayload && typeof contract.contaAzulPayload === "object" && contract.contaAzulPayload) ||
    (contract.contaAzulContractPayload && typeof contract.contaAzulContractPayload === "object" && contract.contaAzulContractPayload) ||
    null;
  const externalId = pickFirstText(contract.externalId, contract.contractId, contract.id, contract.uuid, contract.codigo, contract.code);
  const firstDueDate = normalizeIsoDateFromFinance(
    pickFirstNested(contract, [
      "firstDueDate",
      "first_charge_date",
      "firstChargeDate",
      "primeiraDataVencimento",
      "primeiro_vencimento",
      "data_primeiro_vencimento",
      "primeira_data_vencimento",
      "dueDate",
      "due_date",
      "vencimento",
      "data_vencimento",
      "billing.firstDueDate",
      "billing.dueDate",
      "billing.due_date",
      "billing.data_vencimento",
      "billing.primeira_data_vencimento",
      "condicao_pagamento.primeira_data_vencimento",
    ])
  );
  const startDate =
    normalizeIsoDateFromFinance(
      pickFirstNested(contract, [
        "startDate",
        "dataInicio",
        "data_inicio",
        "contract_start_date",
        "contractStartDate",
        "inicio",
        "termos.data_inicio",
        "billing.startDate",
        "billing.data_inicio",
      ])
    ) || firstDueDate;
  const endDate = normalizeIsoDateFromFinance(
    pickFirstNested(contract, [
      "endDate",
      "dataFim",
      "data_fim",
      "contract_end_date",
      "termos.data_fim",
      "billing.endDate",
    ])
  );
  const amountCents =
    lc.contractAmountInputUnit === "reais"
      ? resolveMoneyCents(contract, CONTRACT_MONEY_CENTAVOS_PATHS, CONTRACT_MONEY_DECIMAL_PATHS)
      : pickContractAmountInCentavosFromFinance(contract);
  const amount = moneyCentsToDecimal(amountCents) || 0;
  const mappedItemId = resolveContaAzulItemFromProductMapping(contract, lc.financeProductMappings);
  const itemId = pickFirstText(
    pickFirstNested(contract, [
      "itemId",
      "productId",
      "serviceId",
      "produtoId",
      "servicoId",
      "id_servico",
      "id_produto",
      "servico_id",
      "produto_id",
      "plano_id",
      "planoId",
      "item.id",
      "items.0.id",
      "itens.0.id",
      "servico.id",
      "produto.id",
      "billing.productId",
      "billing.serviceId",
      "billing.itemId",
      "item.itemId",
    ]),
    linkedByCategory?.contaAzulItemId,
    linkedByMethod?.contaAzulItemId,
    mappedItemId,
    readContaAzulEnvFirst("CONTA_AZUL_DEFAULT_CONTRACT_ITEM_ID")
  );
  const itemDescription = pickFirstText(
    pickFirstNested(contract, ["itemDescription", "description", "descricao", "name", "nome", "item.description", "item.descricao"]),
    linkedByCategory?.contaAzulItemDescription,
    linkedByMethod?.contaAzulItemDescription
  ) || "Contrato recorrente";
  const quantity = normalizePositiveInteger(pickFirstNested(contract, ["quantity", "quantidade", "item.quantity", "item.quantidade"]), 1);
  const rawContractNumber = Number(pickFirstNested(contract, ["contractNumber", "number", "numero", "termos.numero"]) || nextContractNumber);
  const contractNumber = Number.isFinite(rawContractNumber) && rawContractNumber > 0 ? Math.trunc(rawContractNumber) : 0;
  const customerId = pickFirstText(
    pickFirstNested(contract, [
      "customerId",
      "clientId",
      "contaAzulCustomerId",
      "contaAzulClientId",
      "conta_azul_client_id",
      "conta_azul_customer_id",
      "id_cliente",
      "cliente_id",
      "pessoa_id",
      "pessoaId",
      "contato_id",
      "contatoId",
      "customer.contaAzulId",
      "client.contaAzulId",
      "cliente.id",
      "cliente.id_cliente",
      "cliente.conta_azul_id",
      "cliente.contaAzulId",
      "client.id",
      "billing_clients.conta_azul_id",
      "billing_clients.contaAzulId",
      "billing_clients.id_cliente",
      "billing_clients.id",
      "billing_client.conta_azul_id",
      "billing_client.id",
      "billing_client.id_cliente",
      "customer.id",
      "billing.customerId",
    ]),
    readContaAzulEnvFirst("CONTA_AZUL_DEFAULT_CONTRACT_CUSTOMER_ID"),
    safeSettings.fpaExport.defaultContactId
  );
  const financialAccountId = pickFirstText(
    pickFirstNested(contract, [
      "financialAccountId",
      "contaAzulFinancialAccountId",
      "id_conta_financeira",
      "conta_financeira_id",
      "idContaFinanceira",
      "financial_account_id",
      "default_financial_account_id",
      "billing.financialAccountId",
      "billing.id_conta_financeira",
      "billing.conta_financeira_id",
      "condicao_pagamento.id_conta_financeira",
    ]),
    linkedByCategory?.contaAzulFinancialAccountId,
    linkedByMethod?.contaAzulFinancialAccountId,
    lc.defaultContractFinancialAccountId,
    readContaAzulEnvFirst("CONTA_AZUL_DEFAULT_CONTRACT_FINANCIAL_ACCOUNT_ID"),
    safeSettings.fpaExport.defaultFinancialAccountId
  );
  const categoryId = pickFirstText(
    pickFirstNested(contract, ["categoryId", "contaAzulCategoryId", "id_categoria"]),
    safeSettings.fpaExport.defaultReceivableCategoryId
  );
  const rawPaymentKey = pickFirstNested(contract, [
    "paymentMethod",
    "tipoPagamento",
    "forma_pagamento",
    "formaPagamento",
    "payment_method",
    "billing.paymentMethod",
    "billing.forma_pagamento",
    "condicao_pagamento.tipo_pagamento",
  ]);
  const paymentMapping = resolveFinancePaymentMapping(rawPaymentKey, lc.financePaymentMappings);
  const paymentMethod = normalizeContaAzulPaymentMethod(
    paymentMapping?.contaAzulTipoPagamento ||
      linkedByMethod?.contaAzulPaymentType ||
      linkedByCategory?.contaAzulPaymentType ||
      rawPaymentKey
  );
  let resolvedFinancialAccountId = financialAccountId;
  let resolvedItemId = itemId;
  let lineValor = amount;
  if (paymentMapping) {
    if (paymentMapping.contaAzulFinancialAccountId) resolvedFinancialAccountId = paymentMapping.contaAzulFinancialAccountId;
    if (paymentMapping.contaAzulItemId) resolvedItemId = paymentMapping.contaAzulItemId;
    if (paymentMapping.contaAzulItemValor != null && Number.isFinite(paymentMapping.contaAzulItemValor)) {
      lineValor = paymentMapping.contaAzulItemValor;
    }
  }
  const dueDay = normalizeContaAzulDueDay(pickFirstNested(contract, ["dueDay", "diaVencimento", "billing.dueDay"]), firstDueDate || startDate);
  const issueDate =
    normalizeIsoDateFromFinance(
      pickFirstNested(contract, [
        "issueDate",
        "dataEmissao",
        "data_emissao",
        "created_at",
        "createdAt",
        "billing.issueDate",
        "billing.data_emissao",
      ])
    ) || new Date().toISOString().slice(0, 10);
  const frequency = normalizeContaAzulContractFrequency(pickFirstNested(contract, ["frequency", "recurrence", "periodicity", "termos.tipo_frequencia"]));
  const expiration = normalizeContaAzulContractExpiration(pickFirstNested(contract, ["expirationType", "termos.tipo_expiracao"]), endDate);

  const baseContractPayload = {
    id_cliente: customerId,
    data_emissao: issueDate,
    id_categoria: categoryId,
    id_centro_custo: pickFirstNested(contract, ["costCenterId", "centroCustoId", "id_centro_custo"]),
    id_vendedor: pickFirstNested(contract, ["sellerId", "vendedorId", "id_vendedor"]),
    observacoes: pickFirstText(contract.notes, contract.observacoes, `Origem: Lovable | Contrato: ${externalId || "sem id"}`),
    observacoes_pagamento: pickFirstText(contract.paymentNotes, contract.observacoes_pagamento),
    termos: {
      tipo_frequencia: frequency,
      tipo_expiracao: expiration,
      data_inicio: startDate,
      data_fim: endDate,
      intervalo_frequencia: normalizePositiveInteger(pickFirstNested(contract, ["frequencyInterval", "intervaloFrequencia", "termos.intervalo_frequencia"]), 1),
      dia_emissao_venda: normalizeContaAzulDueDay(pickFirstNested(contract, ["saleIssueDay", "diaEmissaoVenda", "termos.dia_emissao_venda"]), issueDate),
      numero: contractNumber || undefined,
    },
    composicao_de_valor: {
      frete: normalizeOptionalNumber(pickFirstNested(contract, ["freight", "frete"]), 0) || undefined,
      desconto: pickFirstNested(contract, ["discount", "desconto"])
        ? {
            tipo: pickFirstText(pickFirstNested(contract, ["discountType", "tipoDesconto"])) || "VALOR",
            valor: normalizeOptionalNumber(pickFirstNested(contract, ["discount", "desconto"]), 0),
          }
        : undefined,
    },
    condicao_pagamento: {
      tipo_pagamento: paymentMethod,
      id_conta_financeira: resolvedFinancialAccountId,
      dia_vencimento: dueDay,
      primeira_data_vencimento: firstDueDate || startDate,
    },
    itens: [
      {
        id: resolvedItemId,
        quantidade: quantity,
        descricao: itemDescription,
        valor: lineValor,
        valor_custo: normalizeOptionalNumber(pickFirstNested(contract, ["costValue", "valorCusto", "item.costValue"]), 0) || undefined,
      },
    ],
  };

  const safeOverride = payloadOverride ? JSON.parse(JSON.stringify(payloadOverride)) : null;
  if (safeOverride && safeOverride.termos) {
    safeOverride.termos = {
      ...safeOverride.termos,
      numero: safeOverride.termos?.numero || contractNumber || baseContractPayload.termos?.numero,
    };
  }
  const mergedContractPayload = mergeContaAzulLovableContractPayload(
    baseContractPayload,
    safeOverride
  );
  const payload = compactContaAzulPayload(mergedContractPayload);

  const missingRequiredFields = [];
  const firstItem = payload.itens?.[0];
  const payloadLineValor = firstItem == null ? NaN : Number(firstItem.valor);
  const lineQty = firstItem == null ? NaN : Number(firstItem.quantidade);
  if (!payload.id_cliente) missingRequiredFields.push("id_cliente");
  if (!payload.termos?.tipo_frequencia) missingRequiredFields.push("termos.tipo_frequencia");
  if (!payload.termos?.tipo_expiracao) missingRequiredFields.push("termos.tipo_expiracao");
  if (!payload.termos?.data_inicio) missingRequiredFields.push("termos.data_inicio");
  if (payload.termos?.tipo_expiracao === "DATA" && !payload.termos?.data_fim) missingRequiredFields.push("termos.data_fim");
  if (!payload.termos?.numero) missingRequiredFields.push("termos.numero");
  if (!payload.condicao_pagamento?.id_conta_financeira) missingRequiredFields.push("condicao_pagamento.id_conta_financeira");
  if (!payload.condicao_pagamento?.dia_vencimento) missingRequiredFields.push("condicao_pagamento.dia_vencimento");
  if (!payload.condicao_pagamento?.primeira_data_vencimento) missingRequiredFields.push("condicao_pagamento.primeira_data_vencimento");
  if (!Array.isArray(payload.itens) || !payload.itens.length) missingRequiredFields.push("itens");
  if (!firstItem?.id) missingRequiredFields.push("itens[0].id");
  if (!Number.isFinite(lineQty) || lineQty < 1) missingRequiredFields.push("itens[0].quantidade");
  if (!Number.isFinite(payloadLineValor) || payloadLineValor < 0) missingRequiredFields.push("itens[0].valor");

  const outAmountCents = Number.isFinite(payloadLineValor) ? Math.round(payloadLineValor * 100) : amountCents;
  return {
    source: "lovable",
    resource: CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE,
    action: "create_contract",
    externalId: externalId || null,
    endpointPath: safeSettings.lovableContracts.contractsCreatePath,
    amountCents: outAmountCents,
    amountFormatted: outAmountCents ? formatMoneyBRL(outAmountCents) : "",
    missingRequiredFields: Array.from(new Set(missingRequiredFields)),
    payload,
  };
}

function buildContaAzulAcquittanceRecord({ settings, source, installmentId } = {}) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const baseSource = source && typeof source === "object" ? source : {};
  const nestedPayment = baseSource.payment && typeof baseSource.payment === "object" ? baseSource.payment : {};
  const nestedReceipt = baseSource.receipt && typeof baseSource.receipt === "object" ? baseSource.receipt : {};
  const payment = { ...baseSource, ...nestedPayment, ...nestedReceipt };
  const payloadOverride =
    (payment.contaAzulPayload && typeof payment.contaAzulPayload === "object" && payment.contaAzulPayload) ||
    (payment.contaAzulAcquittancePayload && typeof payment.contaAzulAcquittancePayload === "object" && payment.contaAzulAcquittancePayload) ||
    null;
  const externalId = pickFirstText(payment.externalId, payment.paymentId, payment.receiptId, payment.id, payment.uuid);
  const safeInstallmentId = pickFirstText(
    installmentId,
    pickFirstNested(payment, ["installmentId", "parcelaId", "contaAzulInstallmentId", "id_parcela"])
  );
  const amountCents = resolveMoneyCents(
    payment,
    ["amountCents", "paidAmountCents", "valorPagoCentavos", "valorBrutoCentavos"],
    ["amount", "paidAmount", "valor", "valorPago", "valor_bruto"]
  );
  const paidAt = normalizeIsoDate(pickFirstNested(payment, ["paidAt", "paymentDate", "dataPagamento", "data_pagamento"])) || new Date().toISOString().slice(0, 10);
  const rawPaymentKey = pickFirstNested(payment, [
    "paymentMethod",
    "metodoPagamento",
    "metodo_pagamento",
    "forma_pagamento",
    "tipoPagamento",
  ]);
  const paymentMapping = resolveFinancePaymentMapping(rawPaymentKey, safeSettings.lovableContracts.financePaymentMappings);
  const financialAccountId = pickFirstText(
    paymentMapping?.contaAzulFinancialAccountId,
    pickFirstNested(payment, ["financialAccountId", "contaAzulFinancialAccountId", "conta_financeira", "id_conta_financeira"]),
    safeSettings.fpaExport.defaultFinancialAccountId
  );
  const grossAmount = moneyCentsToDecimal(amountCents);
  const payload = payloadOverride
    ? compactContaAzulPayload(JSON.parse(JSON.stringify(payloadOverride)))
    : compactContaAzulPayload({
        data_pagamento: paidAt,
        composicao_valor: {
          multa: normalizeDecimalMoney(pickFirstNested(payment, ["fine", "multa"])),
          juros: normalizeDecimalMoney(pickFirstNested(payment, ["interest", "juros"])),
          valor_bruto: grossAmount,
          desconto: normalizeDecimalMoney(pickFirstNested(payment, ["discount", "desconto"])),
          taxa: normalizeDecimalMoney(pickFirstNested(payment, ["fee", "taxa"])),
        },
        conta_financeira: financialAccountId,
        metodo_pagamento: normalizeContaAzulPaymentMethod(
          paymentMapping?.contaAzulTipoPagamento || pickFirstNested(payment, ["paymentMethod", "metodoPagamento", "metodo_pagamento"]),
          "PIX"
        ),
        observacao: pickFirstText(payment.notes, payment.observacao, `Baixa automática via Lovable${externalId ? ` | Recebimento: ${externalId}` : ""}`),
        nsu: pickFirstText(payment.nsu, payment.transactionId, payment.tid, payment.authorizationCode),
      });

  const missingRequiredFields = [];
  if (!safeInstallmentId) missingRequiredFields.push("parcela_id");
  if (!payload.data_pagamento) missingRequiredFields.push("data_pagamento");
  if (!payload.composicao_valor?.valor_bruto) missingRequiredFields.push("composicao_valor.valor_bruto");
  if (!payload.conta_financeira) missingRequiredFields.push("conta_financeira");

  return {
    source: "lovable",
    resource: CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE,
    action: "create_acquittance",
    externalId: externalId || null,
    endpointPath: buildContaAzulAcquittancePath(safeInstallmentId),
    installmentId: safeInstallmentId || null,
    amountCents,
    amountFormatted: amountCents ? formatMoneyBRL(amountCents) : "",
    paymentDate: payload.data_pagamento || null,
    missingRequiredFields: Array.from(new Set(missingRequiredFields)),
    payload,
  };
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildMatchTokens(value) {
  return normalizeMatchText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token));
}

function calculateTokenSimilarity(left, right) {
  const leftTokens = new Set(buildMatchTokens(left));
  const rightTokens = new Set(buildMatchTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const shared = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function getContaAzulLocalRecordAmountCents(record) {
  if (Number.isInteger(record?.amountCents)) return Math.abs(record.amountCents);
  return normalizeAmountCents(record?.payload?.valor);
}

function getContaAzulLocalRecordDate(record) {
  return (
    normalizeIsoDate(record?.payload?.condicao_pagamento?.parcelas?.[0]?.data_vencimento) ||
    normalizeIsoDate(record?.transactionDate)
  );
}

function scoreContaAzulRecordMatch(localRecord, remoteRecord) {
  const localAmount = getContaAzulLocalRecordAmountCents(localRecord);
  const remoteAmount = remoteRecord?.amountCents;
  const localDate = getContaAzulLocalRecordDate(localRecord);
  const remoteDates = [remoteRecord?.dueDate, remoteRecord?.competenceDate].filter(Boolean);
  const amountMatches = Number.isInteger(localAmount) && Number.isInteger(remoteAmount) && Math.abs(localAmount - remoteAmount) <= 1;
  const dateMatches = Boolean(localDate && remoteDates.includes(localDate));
  const typeMatches = normalizeContaAzulFinancialEventType(localRecord?.type) === normalizeContaAzulFinancialEventType(remoteRecord?.type);
  const textSimilarity = calculateTokenSimilarity(
    [localRecord?.payload?.descricao, localRecord?.category, localRecord?.accountName].filter(Boolean).join(" "),
    [remoteRecord?.description, remoteRecord?.counterpartyName, ...(remoteRecord?.categories || []).map((category) => category.name)].filter(Boolean).join(" ")
  );

  let score = 0;
  if (typeMatches) score += 10;
  if (amountMatches) score += 45;
  if (dateMatches) score += 35;
  score += Math.round(textSimilarity * 10);

  return {
    score,
    amountMatches,
    dateMatches,
    typeMatches,
    textSimilarity,
    isStrongMatch: typeMatches && amountMatches && dateMatches && textSimilarity >= 0.2,
    isPossibleMatch: typeMatches && amountMatches && dateMatches,
  };
}

function reconcileContaAzulFinancialRecords(localRecords, remoteRecords) {
  const safeLocalRecords = Array.isArray(localRecords) ? localRecords : [];
  const safeRemoteRecords = Array.isArray(remoteRecords) ? remoteRecords : [];
  const matchedRecords = [];
  const possibleRecords = [];
  const missingRecords = [];

  safeLocalRecords.forEach((record) => {
    const candidates = safeRemoteRecords
      .map((remoteRecord) => ({
        remoteRecord,
        match: scoreContaAzulRecordMatch(record, remoteRecord),
      }))
      .filter((candidate) => candidate.match.isPossibleMatch)
      .sort((a, b) => b.match.score - a.match.score);
    const best = candidates[0] || null;

    if (!best) {
      missingRecords.push({
        ...record,
        reconciliation: {
          status: "missing",
          label: "Não encontrado no Conta Azul",
          score: 0,
          contaAzulRecord: null,
        },
      });
      return;
    }

    const reconciledRecord = {
      ...record,
      reconciliation: {
        status: best.match.isStrongMatch ? "matched" : "possible",
        label: best.match.isStrongMatch ? "Já existe no Conta Azul" : "Possível duplicidade",
        score: best.match.score,
        amountMatches: best.match.amountMatches,
        dateMatches: best.match.dateMatches,
        textSimilarity: best.match.textSimilarity,
        contaAzulRecord: best.remoteRecord,
      },
    };

    if (best.match.isStrongMatch) {
      matchedRecords.push(reconciledRecord);
    } else {
      possibleRecords.push(reconciledRecord);
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    totalLocalRecords: safeLocalRecords.length,
    totalContaAzulRecords: safeRemoteRecords.length,
    matchedRecords,
    possibleRecords,
    missingRecords,
    recordsToCreate: missingRecords,
    blockedRecords: [...matchedRecords, ...possibleRecords],
  };
}

function buildContaAzulFpaExportPayload({ settings, transactions }) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const records = getContaAzulFpaExportCandidates({
    settings: safeSettings,
    transactions,
  }).map((transaction) => buildContaAzulFpaFinancialEventRecord(transaction, safeSettings));

  return {
    source: "analista_fpa",
    integration: "conta_azul",
    resource: CONTA_AZUL_FPA_EXPORT_RESOURCE,
    action: "create_financial_event",
    generatedAt: new Date().toISOString(),
    defaults: {
      payablePath: safeSettings.fpaExport.payablePath,
      receivablePath: safeSettings.fpaExport.receivablePath,
      defaultContactId: safeSettings.fpaExport.defaultContactId,
      defaultFinancialAccountId: safeSettings.fpaExport.defaultFinancialAccountId,
      defaultReceivableCategoryId: safeSettings.fpaExport.defaultReceivableCategoryId,
      defaultPayableCategoryId: safeSettings.fpaExport.defaultPayableCategoryId,
      exportOnlyUnsent: safeSettings.fpaExport.exportOnlyUnsent,
      includeInternalTransfers: safeSettings.fpaExport.includeInternalTransfers,
    },
    records,
    missingRequiredFields: Array.from(new Set(records.flatMap((record) => record.missingRequiredFields))),
  };
}

function resolveContaAzulEndpointUrl(baseUrl, endpointPath) {
  const safeBaseUrl = normalizeBaseUrl(baseUrl);
  const safeEndpointPath = normalizeEndpointPath(endpointPath);
  if (!safeBaseUrl && /^https?:\/\//i.test(safeEndpointPath)) return safeEndpointPath;
  if (!safeBaseUrl) return "";
  if (!safeEndpointPath) return safeBaseUrl;
  try {
    return new URL(safeEndpointPath, `${safeBaseUrl}/`).toString();
  } catch {
    return "";
  }
}

function buildContaAzulHeaders(settings) {
  const safeSettings = normalizeContaAzulSettings(settings);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Source-System": "analista-fpa",
  };

  if (safeSettings.authMode === "bearer" && safeSettings.accessToken) {
    headers.Authorization = `${safeSettings.tokenType || "Bearer"} ${safeSettings.accessToken}`;
  }

  if (
    safeSettings.authMode === "custom_header" &&
    safeSettings.customHeaderName &&
    safeSettings.customHeaderValue
  ) {
    headers[safeSettings.customHeaderName] = safeSettings.customHeaderValue;
  }

  return headers;
}

module.exports = {
  CONTA_AZUL_API_BASE_URL,
  CONTA_AZUL_AUTH_URL,
  CONTA_AZUL_ACQUITTANCE_PATH_TEMPLATE,
  CONTA_AZUL_CONNECTED_ACCOUNT_PATH,
  CONTA_AZUL_CONTRACTS_PATH,
  CONTA_AZUL_DEFAULT_SCOPE,
  CONTA_AZUL_FINANCIAL_ACCOUNTS_PATH,
  CONTA_AZUL_FINANCIAL_CATEGORIES_PATH,
  CONTA_AZUL_PRODUCTS_PATH,
  CONTA_AZUL_FPA_EXPORT_RESOURCE,
  CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE,
  CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE,
  CONTA_AZUL_NEXT_CONTRACT_NUMBER_PATH,
  CONTA_AZUL_PAYABLE_EVENT_PATH,
  CONTA_AZUL_PAYABLE_SEARCH_PATH,
  CONTA_AZUL_PEOPLE_PATH,
  CONTA_AZUL_RECEIVABLE_EVENT_PATH,
  CONTA_AZUL_RECEIVABLE_SEARCH_PATH,
  CONTA_AZUL_TOKEN_URL,
  applyContaAzulTokenPayload,
  buildContaAzulAcquittancePath,
  buildContaAzulAcquittanceRecord,
  buildContaAzulAuthorizationUrl,
  buildContaAzulContractRecord,
  buildContaAzulContractSearchPath,
  buildContaAzulFinancialAccountsPath,
  buildContaAzulFinancialCategoriesPath,
  buildContaAzulProductsPath,
  buildContaAzulFinancialEventsSearchPath,
  buildContaAzulFpaExportPayload,
  buildContaAzulFpaFinancialEventRecord,
  buildContaAzulTestFinancialEventRecord,
  buildContaAzulHeaders,
  buildContaAzulPeoplePath,
  buildContaAzulTokenHeaders,
  createDefaultContaAzulSettings,
  filterContaAzulCatalogByMode,
  getContaAzulFpaExportCandidates,
  getContaAzulLovableContractPaths,
  isContaAzulAccessTokenExpired,
  mergeContaAzulSettings,
  normalizeContaAzulAuthorizationCode,
  normalizeContaAzulAcquittanceResponse,
  normalizeContaAzulConnectedAccount,
  normalizeContaAzulContractResponse,
  normalizeContaAzulFinancialAccount,
  normalizeContaAzulFinancialCategory,
  normalizeContaAzulFinancialCategoryType,
  normalizeContaAzulFinancialInstallment,
  normalizeContaAzulListItems,
  normalizeContaAzulPerson,
  normalizeContaAzulPersonProfileType,
  normalizeContaAzulProduct,
  normalizeContaAzulProductsPageSize,
  normalizeContaAzulSettings,
  prependContaAzulSyncHistory,
  reconcileContaAzulFinancialRecords,
  resolveContaAzulEndpointUrl,
  resolveFinancePaymentMapping,
  sanitizeContaAzulSettings,
};
