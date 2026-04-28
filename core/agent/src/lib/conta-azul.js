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
const CONTA_AZUL_SERVICOS_PATH = "/v1/servicos";
/** Conta Azul /v1/produtos only accepts these exact tamanho_pagina values. */
const CONTA_AZUL_PRODUCT_PAGE_SIZES = Object.freeze([10, 20, 50, 100, 200, 500, 1000]);
/** Conta Azul GET /v1/servicos — enum menor que /v1/produtos (ex.: não aceita 500). */
const CONTA_AZUL_SERVICOS_PAGE_SIZES = Object.freeze([10, 20, 50, 100]);
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

function normalizeContaAzulServicosPageSize(value) {
  const n = clampInteger(value, 10, 100, 100);
  const allowed = CONTA_AZUL_SERVICOS_PAGE_SIZES;
  if (allowed.includes(n)) return n;
  const ceiling = allowed.find((s) => s >= n);
  return ceiling ?? 100;
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

function normalizeContaAzulDocumentDigits(value) {
  return String(value == null ? "" : value).replace(/\D+/g, "");
}

function formatContaAzulBrazilianDocument(value) {
  const digits = normalizeContaAzulDocumentDigits(value);
  if (digits.length === 14) {
    return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  }
  if (digits.length === 11) {
    return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  }
  return normalizeOptionalText(value, 40);
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

const CONTA_AZUL_CATALOG_MERGE_KEYS = [
  "itens",
  "items",
  "produtos",
  "servicos",
  "services",
  "lista",
  "registros",
  "records",
  "resultados",
];

const CONTA_AZUL_CATALOG_MERGE_NESTED = [
  "data.itens",
  "data.items",
  "data.produtos",
  "data.servicos",
  "data.services",
  "resultado.itens",
  "result.items",
  "result.itens",
];

function scoreContaAzulCatalogLikeRow(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return 0;
  let s = 0;
  if (o.id != null && String(o.id).trim() !== "") s += 3;
  if (o.uuid != null && String(o.uuid).trim() !== "") s += 3;
  if (o.nome || o.name || o.descricao || o.description) s += 2;
  if (o.codigo || o.codigo_sku || o.sku) s += 1;
  if (o.tipo || o.type || o.valor_venda != null || o.valorVenda != null) s += 1;
  return s;
}

/** Último recurso: varrer JSON (ex.: envelope Microsoft, OData value, etc.). */
function deepCollectContaAzulCatalogRows(node, depth = 0, maxDepth = 12) {
  const acc = [];
  function walk(n, d) {
    if (d > maxDepth || n == null) return;
    if (Array.isArray(n)) {
      if (!n.length) return;
      const allObj = n.every((x) => x && typeof x === "object" && !Array.isArray(x));
      if (allObj) {
        const scores = n.map(scoreContaAzulCatalogLikeRow);
        const maxS = scores.length ? Math.max(...scores) : 0;
        if (maxS >= 4 || (n.length > 0 && scores.some((sc) => sc >= 3))) {
          acc.push(...n);
          return;
        }
      }
      for (const el of n) walk(el, d + 1);
      return;
    }
    if (typeof n === "object") {
      for (const v of Object.values(n)) walk(v, d + 1);
    }
  }
  walk(node, depth);
  return acc;
}

/**
 * Une todas as listas plausíveis do JSON de catálogo (produtos/serviços em chaves diferentes).
 * Usado no fluxo GET /v1/produtos e GET /v1/servicos.
 */
function mergeContaAzulCatalogListRows(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  const safe = typeof payload === "object" ? payload : {};
  const seen = new Set();
  const out = [];
  function pushRows(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rid =
        row.id ??
        row.uuid ??
        row.produto_id ??
        row.id_produto ??
        row.service_id ??
        row.serviceId ??
        row.task_id ??
        row.taskId;
      const key = rid != null && String(rid).trim() !== "" ? `id:${String(rid)}` : `anon:${out.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  for (const k of CONTA_AZUL_CATALOG_MERGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(safe, k)) pushRows(safe[k]);
  }
  for (const path of CONTA_AZUL_CATALOG_MERGE_NESTED) {
    pushRows(readNestedArray(safe, path));
  }
  if (Array.isArray(safe.data)) pushRows(safe.data);
  if (Array.isArray(safe.result)) pushRows(safe.result);
  if (Array.isArray(safe.value)) pushRows(safe.value);
  if (out.length) return out;
  pushRows(normalizeContaAzulListItems(safe));
  if (out.length) return out;
  pushRows(deepCollectContaAzulCatalogRows(safe));
  return out;
}

function normalizeContaAzulListItems(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  const safePayload = typeof payload === "object" ? payload : {};
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

/** fiscal.tipo_produto SERVICOS = cadastro de prestação de serviço no Conta Azul (mesmo com tipo=PRODUTO na listagem). */
function isContaAzulFiscalTipoServico(value) {
  const u = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  return u === "SERVICOS" || u.includes("SERVICO");
}

function pickContaAzulProductRowId(safe) {
  const nested = safe.produto && typeof safe.produto === "object" ? safe.produto : {};
  const candidates = [
    safe.id,
    safe.uuid,
    safe.produto_id,
    safe.id_produto,
    safe.productId,
    safe.product_id,
    safe.service_id,
    safe.serviceId,
    safe.task_id,
    safe.taskId,
    nested.id,
    nested.uuid,
  ];
  for (const c of candidates) {
    if (c == null || c === "") continue;
    const t = String(c).trim();
    if (!t) continue;
    const n = normalizeOptionalText(t, 120);
    if (n) return n;
  }
  if (safe.id_legado != null && String(safe.id_legado).trim() !== "") {
    return normalizeOptionalText(`legacy_${safe.id_legado}`, 120);
  }
  return null;
}

function normalizeContaAzulProduct(product) {
  const safe = product && typeof product === "object" ? product : {};
  const fiscal = safe.fiscal && typeof safe.fiscal === "object" ? safe.fiscal : {};
  const fiscalTipo = fiscal.tipo_produto || fiscal.tipoProduto;
  const fiscalTipoRaw = normalizeOptionalText(fiscalTipo, 80) || null;
  const id = pickContaAzulProductRowId(safe);
  const name = normalizeOptionalText(safe.nome || safe.name || safe.descricao || safe.description, 200);
  const sku = normalizeOptionalText(safe.sku || safe.codigo || safe.codigo_sku, 80);
  const topTipo = safe.tipo || safe.type || safe.tipo_item || safe.tipoItem || safe.tipo_produto || safe.tipoProduto;
  const kindRaw =
    (isContaAzulFiscalTipoServico(fiscalTipo) ? fiscalTipo : null) ||
    topTipo ||
    fiscalTipo ||
    safe.natureza ||
    safe.classificacao;
  const tipoRaw = normalizeOptionalText(kindRaw, 80) || null;
  const kind = formatContaAzulProductKind(kindRaw) || normalizeOptionalText(kindRaw, 40) || "";
  const label = [name || id || "Item sem nome", sku || null, kind || null].filter(Boolean).join(" · ");

  return {
    id: id || null,
    name: name || null,
    sku: sku || null,
    fiscalTipoRaw,
    tipoRaw,
    kind: kind || null,
    label,
  };
}

/** Classifica item do catálogo (produtos e/ou serviços) para filtrar serviço vs produto físico/kit. */
function contaAzulCatalogItemClass(item) {
  if (isContaAzulFiscalTipoServico(item?.fiscalTipoRaw)) return "servico";
  const raw = String(item?.tipoRaw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  const kind = String(item?.kind || "");
  if (raw.includes("SERV") || kind.includes("Serviço") || kind.includes("Servico")) return "servico";
  // Resumo da listagem costuma trazer só PRODUTO | KIT_PRODUTO | VARIACAO_PRODUTO; serviços ficam como PRODUTO até o detalhe (fiscal.tipo_produto).
  if (raw.includes("KIT") || raw.includes("VARIACAO") || raw.includes("VARIAÇÃO") || raw === "PRODUCT") return "produto";
  const fiscalHint = normalizeOptionalText(item?.fiscalTipoRaw, 80);
  if (raw === "PRODUTO") {
    if (fiscalHint && !isContaAzulFiscalTipoServico(item.fiscalTipoRaw)) return "produto";
    return "unknown";
  }
  if (raw.includes("PROD") || kind.includes("Produto")) return "produto";
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

function buildContaAzulPeoplePath({ profileType, search, document, documentos, page = 1, pageSize = 20 } = {}) {
  const params = new URLSearchParams();
  const safeProfileType = normalizeContaAzulPersonProfileType(profileType);
  if (safeProfileType) params.set("tipo_perfil", safeProfileType);
  const safeSearch = normalizeOptionalText(search, 160);
  if (safeSearch) params.set("busca", safeSearch);
  const safeDocument = normalizeContaAzulDocumentDigits(document || documentos);
  if (safeDocument) params.set("documentos", safeDocument);
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

function buildContaAzulInventoryListPath(basePath, { search, page = 1, pageSize = 100, status } = {}) {
  const base = String(basePath || "").split("?")[0];
  const params = new URLSearchParams();
  const safeSearch = normalizeOptionalText(search, 160);
  if (safeSearch) params.set("busca", safeSearch);
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(normalizeContaAzulProductsPageSize(pageSize)));
  const safeStatus = normalizeOptionalText(status, 40);
  if (safeStatus) params.set("status", safeStatus.toUpperCase());
  return `${base}?${params.toString()}`;
}

/** GET /v1/servicos — busca textual usa query `busca_textual` (não `busca`). */
function buildContaAzulServicosPath({ search, page = 1, pageSize = 100, status } = {}) {
  const params = new URLSearchParams();
  const safeSearch = normalizeOptionalText(search, 160);
  if (safeSearch) params.set("busca_textual", safeSearch);
  params.set("pagina", String(clampInteger(page, 1, 10000, 1)));
  params.set("tamanho_pagina", String(normalizeContaAzulServicosPageSize(pageSize)));
  const safeStatus = normalizeOptionalText(status, 40);
  if (safeStatus) params.set("status", safeStatus.toUpperCase());
  return `${CONTA_AZUL_SERVICOS_PATH}?${params.toString()}`;
}

function buildContaAzulProductsPath(opts = {}) {
  return buildContaAzulInventoryListPath(CONTA_AZUL_PRODUCTS_PATH, opts);
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
    ? safe.financeProductMappings
        .map(normalizeFinanceProductMappingEntry)
        .filter((m) => (m.financeProductId || m.financeProductLabel) && m.contaAzulItemId)
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

/** Unwraps Finance/Lovable shapes like `{ id }` / `{ uuid }` so IDs are scalar strings accepted by CA. */
function coerceContaAzulApiId(raw, maxLength = 160) {
  const visit = (value, depth) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string" || typeof value === "number") {
      const text = normalizeOptionalText(String(value), maxLength);
      return text || null;
    }
    if (typeof value === "boolean") {
      const text = normalizeOptionalText(value ? "true" : "false", maxLength);
      return text || null;
    }
    if (!value || typeof value !== "object" || depth > 8) return null;
    const obj = /** @type {Record<string, unknown>} */ (value);
    const direct =
      obj.id ??
      obj.uuid ??
      obj.value ??
      obj.conta_azul_id ??
      obj.contaAzulId ??
      obj.id_parcela ??
      undefined;
    if (direct !== undefined && direct !== value) return visit(direct, depth + 1);
    const singleton = Object.entries(obj).filter(([k]) => /^id$/i.test(k) || /^uuid$/i.test(k));
    if (singleton.length === 1) return visit(singleton[0][1], depth + 1);
    return null;
  };
  return visit(raw, 0);
}

/** Long text fields: CA expects strings — objects/arrays from Lovable would become "[object Object]" via truncateText elsewhere. */
function coerceContaAzulContractLongText(raw, maxLength) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" || typeof raw === "number") {
    const text = normalizeOptionalText(String(raw), maxLength);
    return text || null;
  }
  if (Array.isArray(raw)) {
    const text = normalizeOptionalText(
      raw.map((chunk) => normalizeOptionalText(String(chunk ?? "").trim(), 160)).filter(Boolean).join(" · ").trim(),
      maxLength
    );
    return text || null;
  }
  if (typeof raw !== "object") return null;
  const obj = raw;
  const candidates = ["label", "text", "titulo", "title", "name", "nome", "description", "descricao", "message", "mensagem"];
  for (const key of candidates) {
    const inner = coerceContaAzulContractLongText(/** @type {Record<string, unknown>} */ (obj)[key], Math.min(maxLength, 640));
    if (inner) return truncateText(inner, maxLength);
  }
  try {
    return normalizeOptionalText(JSON.stringify(obj).slice(0, maxLength + 240), maxLength);
  } catch {
    return null;
  }
}

function coerceContaAzulContractMoneyNumber(raw) {
  if (raw === undefined || raw === null) return NaN;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = parseBrazilianDecimal(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  if (raw && typeof raw === "object" && "valor" in raw && /** @type {Record<string, unknown>} */ (raw).valor != null) {
    return coerceContaAzulContractMoneyNumber(/** @type {Record<string, unknown>} */ (raw).valor);
  }
  return NaN;
}

function isResolvableContractLineValor(value) {
  const n = coerceContaAzulContractMoneyNumber(value);
  return Number.isFinite(n);
}

/**
 * Conta Azul often answers `{"code":400,"message":"Formato JSON inválido"}` when the body is valid JSON
 * but field types are wrong (UUID as object, número do contrato como string, valor como objeto, etc.).
 */
function sanitizeContaAzulContractPayloadTypes(input) {
  let safe;
  try {
    safe = JSON.parse(JSON.stringify(input));
  } catch {
    safe = input;
  }
  if (!safe || typeof safe !== "object") return safe;

  for (const key of ["id_cliente", "id_categoria", "id_centro_custo", "id_vendedor"]) {
    if (!(key in safe)) continue;
    const id = coerceContaAzulApiId(safe[key]);
    if (!id) delete safe[key];
    else safe[key] = id;
  }

  for (const field of ["observacoes", "observacoes_pagamento"]) {
    if (!(field in safe)) continue;
    const text = coerceContaAzulContractLongText(safe[field], field === "observacoes" ? 3200 : 640);
    if (!text) delete safe[field];
    else safe[field] = text;
  }

  if (safe.data_emissao != null && safe.data_emissao !== "") {
    const iso = normalizeIsoDateFromFinance(safe.data_emissao);
    if (!iso) delete safe.data_emissao;
    else safe.data_emissao = iso;
  }

  const termos = safe.termos;
  if (termos && typeof termos === "object" && !Array.isArray(termos)) {
    if (termos.tipo_frequencia != null && termos.tipo_frequencia !== "")
      termos.tipo_frequencia = normalizeContaAzulContractFrequency(termos.tipo_frequencia);
    if (termos.tipo_expiracao != null && termos.tipo_expiracao !== "") {
      termos.tipo_expiracao = normalizeContaAzulContractExpiration(termos.tipo_expiracao, termos.data_fim);
    }
    ["data_inicio", "data_fim"].forEach((dk) => {
      if (!(dk in termos) || termos[dk] == null || termos[dk] === "") return;
      const isoDate = normalizeIsoDateFromFinance(termos[dk]);
      if (!isoDate) delete termos[dk];
      else termos[dk] = isoDate;
    });
    if (termos.numero !== undefined && termos.numero !== null && termos.numero !== "") {
      const n = typeof termos.numero === "number" ? termos.numero : Number.parseInt(String(termos.numero).trim(), 10);
      if (Number.isFinite(n) && n > 0) termos.numero = Math.trunc(n);
      else delete termos.numero;
    }
    if (termos.intervalo_frequencia != null) {
      termos.intervalo_frequencia = normalizePositiveInteger(termos.intervalo_frequencia, 1);
    }
    if (termos.dia_emissao_venda != null) {
      termos.dia_emissao_venda = normalizeContaAzulDueDay(termos.dia_emissao_venda, safe.data_emissao || termos.data_inicio);
    }
  }

  const cond = safe.condicao_pagamento;
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    if (cond.tipo_pagamento != null)
      cond.tipo_pagamento = normalizeContaAzulPaymentMethod(cond.tipo_pagamento);
    const acc = coerceContaAzulApiId(cond.id_conta_financeira);
    if (!acc) delete cond.id_conta_financeira;
    else cond.id_conta_financeira = acc;
    if (cond.dia_vencimento != null && cond.dia_vencimento !== "") {
      cond.dia_vencimento = normalizeContaAzulDueDay(
        cond.dia_vencimento,
        cond.primeira_data_vencimento || safe.termos?.data_inicio
      );
    }
    if (cond.primeira_data_vencimento != null && cond.primeira_data_vencimento !== "") {
      const ipv = normalizeIsoDateFromFinance(cond.primeira_data_vencimento);
      if (!ipv) delete cond.primeira_data_vencimento;
      else cond.primeira_data_vencimento = ipv;
    }
  }

  if (Array.isArray(safe.itens)) {
    safe.itens = safe.itens.map((row, index) => {
      if (!row || typeof row !== "object") return row;
      const item = { ...row };
      if (item.id != null && item.id !== "") {
        const iid = coerceContaAzulApiId(item.id);
        if (!iid) delete item.id;
        else item.id = iid;
      }
      if (item.descricao != null && item.descricao !== "") {
        const desc = coerceContaAzulContractLongText(item.descricao, 500);
        if (desc) item.descricao = desc;
        else {
          delete item.descricao;
          if (index === 0) item.descricao = "Contrato recorrente";
        }
      }
      if (item.quantidade != null) item.quantidade = normalizePositiveInteger(item.quantidade, 1);
      if (item.valor !== undefined && item.valor !== null && item.valor !== "") {
        const vn = coerceContaAzulContractMoneyNumber(item.valor);
        if (!Number.isFinite(vn)) delete item.valor;
        else item.valor = vn;
      }
      if (item.valor_custo !== undefined && item.valor_custo !== null && item.valor_custo !== "") {
        const vc = coerceContaAzulContractMoneyNumber(item.valor_custo);
        if (!Number.isFinite(vc)) delete item.valor_custo;
        else item.valor_custo = vc;
      }
      return item;
    });
  }

  const comp = safe.composicao_de_valor;
  if (comp && typeof comp === "object" && !Array.isArray(comp)) {
    if (comp.frete != null && comp.frete !== "") {
      const f = coerceContaAzulContractMoneyNumber(comp.frete);
      if (!Number.isFinite(f)) delete comp.frete;
      else comp.frete = f;
    }
    const dsc = comp.desconto;
    if (dsc && typeof dsc === "object" && !Array.isArray(dsc)) {
      if (dsc.tipo != null)
        dsc.tipo = normalizeOptionalText(String(dsc.tipo || "").trim().replace(/\s+/g, "_").toUpperCase(), 48) || "VALOR";
      if (dsc.valor != null && dsc.valor !== "") {
        const dv = coerceContaAzulContractMoneyNumber(dsc.valor);
        if (!Number.isFinite(dv)) delete dsc.valor;
        else dsc.valor = dv;
      }
    }
    if (!Object.keys(comp).length) delete safe.composicao_de_valor;
  }

  return safe;
}

function compactContaAzulPayload(value) {
  const shouldDrop = (entry) =>
    entry === undefined ||
    entry === null ||
    entry === "" ||
    (typeof entry === "number" && !Number.isFinite(entry)) ||
    (typeof entry === "string" && isContaAzulNullishText(entry));

  if (Array.isArray(value)) {
    return value
      .map(compactContaAzulPayload)
      .filter((entry) => {
        if (shouldDrop(entry)) return false;
        if (Array.isArray(entry) && !entry.length) return false;
        if (typeof entry === "object" && !Array.isArray(entry) && !Object.keys(entry).length) return false;
        return true;
      });
  }
  if (shouldDrop(value)) return undefined;
  if (!value || typeof value !== "object") return value;

  const compacted = {};
  Object.entries(value).forEach(([key, entry]) => {
    const nextValue = compactContaAzulPayload(entry);
    if (shouldDrop(nextValue)) return;
    if (Array.isArray(nextValue) && !nextValue.length) return;
    if (typeof nextValue === "object" && !Array.isArray(nextValue) && !Object.keys(nextValue).length) return;
    compacted[key] = nextValue;
  });
  return compacted;
}

function isContaAzulNullishText(value) {
  return /^(null|undefined|nan)$/i.test(String(value ?? "").trim());
}

function isContaAzulContractDateLikeKey(key) {
  if (/^(dia_vencimento|due_day|payment_due_day|diaVencimento)$/i.test(String(key || ""))) return false;
  return /(^|_)(data|date)(_|$)|vencimento|emissao|inicio|fim|competencia/i.test(String(key || ""));
}

function normalizeContaAzulContractDateInPlace(target, key, fallbackValue) {
  if (!target || typeof target !== "object") return;
  const normalized = normalizeIsoDateFromFinance(target[key]);
  if (normalized) {
    target[key] = normalized;
    return;
  }
  const fallback = normalizeIsoDateFromFinance(fallbackValue);
  if (fallback) {
    target[key] = fallback;
    return;
  }
  delete target[key];
}

function sanitizeContaAzulContractDatesDeep(node, depth = 0, seen = null) {
  if (!node || typeof node !== "object" || node instanceof Date || depth > 16) return node;
  if (!seen) seen = new WeakSet();
  if (seen.has(node)) return node;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let index = node.length - 1; index >= 0; index -= 1) {
      const value = node[index];
      if (value === undefined || value === null || value === "" || isContaAzulNullishText(value)) {
        node.splice(index, 1);
      } else {
        sanitizeContaAzulContractDatesDeep(value, depth + 1, seen);
      }
    }
    return node;
  }

  Object.entries(node).forEach(([key, value]) => {
    if (value && typeof value === "object") {
      sanitizeContaAzulContractDatesDeep(value, depth + 1, seen);
      return;
    }
    if (!isContaAzulContractDateLikeKey(key)) return;
    const normalized = normalizeIsoDateFromFinance(value);
    if (normalized) {
      node[key] = normalized;
      return;
    }
    delete node[key];
  });
  return node;
}

function pruneContaAzulContractPaymentCondition(payload) {
  const cond = payload?.condicao_pagamento;
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return;
  const allowed = new Set(["tipo_pagamento", "id_conta_financeira", "dia_vencimento", "primeira_data_vencimento"]);
  Object.keys(cond).forEach((key) => {
    if (!allowed.has(key)) delete cond[key];
  });
}

function normalizeMergedContaAzulContractDates(payload, basePayload = {}) {
  if (!payload || typeof payload !== "object") return payload;
  normalizeContaAzulContractDateInPlace(payload, "data_emissao", basePayload.data_emissao);
  if (payload.termos && typeof payload.termos === "object") {
    normalizeContaAzulContractDateInPlace(payload.termos, "data_inicio", basePayload.termos?.data_inicio);
    normalizeContaAzulContractDateInPlace(payload.termos, "data_fim", basePayload.termos?.data_fim);
  }
  if (payload.condicao_pagamento && typeof payload.condicao_pagamento === "object") {
    normalizeContaAzulContractDateInPlace(
      payload.condicao_pagamento,
      "primeira_data_vencimento",
      basePayload.condicao_pagamento?.primeira_data_vencimento
    );
  }
  pruneContaAzulContractPaymentCondition(payload);
  return sanitizeContaAzulContractDatesDeep(payload);
}

/**
 * Mescla o payload canônico calculado a partir do webhook com `contaAzulContractPayload` / `contaAzulPayload` opcional.
 * Um objeto vindo do Lovable com `{}` (ou parcial) não pode substituir o payload inteiro — caso contrário
 * faltam id_conta_financeira, itens e valor.
 */
function mergeContaAzulLovableContractPayload(base, override) {
  if (!override || typeof override !== "object") return normalizeMergedContaAzulContractDates({ ...base }, base);
  const o = { ...base, ...override };
  if (normalizeOptionalText(base.id_cliente, 160)) {
    o.id_cliente = base.id_cliente;
  }
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
    if (!isResolvableContractLineValor(row0.valor) && isResolvableContractLineValor(b0.valor)) {
      row0.valor = b0.valor;
    }
    o.itens[0] = row0;
  }
  if (o.termos && (o.termos.numero == null || o.termos.numero === "") && base.termos?.numero != null) {
    o.termos = { ...o.termos, numero: base.termos.numero };
  }
  return normalizeMergedContaAzulContractDates(o, base);
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
    PIX: "PIX_PAGAMENTO_INSTANTANEO",
    PIX_PAGAMENTO: "PIX_PAGAMENTO_INSTANTANEO",
    PIX_INSTANTANEO: "PIX_PAGAMENTO_INSTANTANEO",
    PIX_COBRANCA_QRCODE: "PIX_COBRANCA",
    CARTAO: "CARTAO_CREDITO",
    CARTAO_CREDITO: "CARTAO_CREDITO",
    CARTAO_DEBITO: "CARTAO_DEBITO",
    CARTAO_LINK: "CARTAO_CREDITO_VIA_LINK",
    CARTAO_CREDITO_LINK: "CARTAO_CREDITO_VIA_LINK",
    CREDITO: "CARTAO_CREDITO",
    DEBITO: "CARTAO_DEBITO",
    DEPOSITO: "DEPOSITO_BANCARIO",
    TRANSFERENCIA: "TRANSFERENCIA_BANCARIA",
    TED: "TRANSFERENCIA_BANCARIA",
    DOC: "TRANSFERENCIA_BANCARIA",
    OUTROS: "OUTRO",
    SEM_PAGAMENTO: "SEM_PAGAMENTO",
  };
  const normalized = aliases[raw] || raw || fallback;
  const valid = new Set([
    "BOLETO_BANCARIO",
    "CARTAO_CREDITO",
    "CARTAO_DEBITO",
    "CARTEIRA_DIGITAL",
    "CASHBACK",
    "CHEQUE",
    "CREDITO_LOJA",
    "CREDITO_VIRTUAL",
    "DEPOSITO_BANCARIO",
    "DINHEIRO",
    "OUTRO",
    "DEBITO_AUTOMATICO",
    "CARTAO_CREDITO_VIA_LINK",
    "PIX_PAGAMENTO_INSTANTANEO",
    "PIX_COBRANCA",
    "PROGRAMA_FIDELIDADE",
    "SEM_PAGAMENTO",
    "TRANSFERENCIA_BANCARIA",
    "VALE_ALIMENTACAO",
    "VALE_COMBUSTIVEL",
    "VALE_PRESENTE",
    "VALE_REFEICAO",
  ]);
  return valid.has(normalized) ? normalized : fallback;
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
  "amount_cents",
  "valueCents",
  "value_cents",
  "monthlyAmountCents",
  "monthly_amount_cents",
  "valorCentavos",
  "valor_centavos",
  "item.valorCentavos",
  "item.amount_cents",
  "items.0.amount_cents",
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

function addFinanceProductMappingCandidateKey(set, value) {
  if (value == null || value === "") return;
  const s = String(value).trim();
  if (s) set.add(s);
}

/** Normaliza texto para cruzar nome de serviço no Finance com `financeProductLabel` (minúsculas, espaços, sem acento). */
function normalizeFinanceProductMatchKey(value) {
  let s = String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!s) return "";
  try {
    s = s.normalize("NFD").replace(/\p{M}/gu, "");
  } catch {
    s = s.replace(/[\u0300-\u036f]/g, "");
  }
  return s;
}

function addFinanceProductLabelCandidate(set, value) {
  if (value == null || value === "") return;
  const s = String(value).trim();
  if (!s || s.length > 260) return;
  set.add(s);
}

/**
 * Coleta identificadores de produto/serviço do Finance no payload do contrato (webhook Lovable, API, etc.).
 * Inclui linhas em arrays (items, line_items, …) — caminhos do tipo items.0.x falham com readNestedValue.
 */
function collectFinanceProductMappingCandidateKeys(contract) {
  const keys = new Set();
  if (!contract || typeof contract !== "object") return keys;
  for (const path of [
    "productId",
    "product_id",
    "financeProductId",
    "sku",
    "service_id",
    "serviceId",
    "codigo_produto",
    "product_code",
    "plano_id",
    "planoId",
    "servico_codigo",
    "id_produto_finance",
    "servico_id",
    "produto_id",
    "billing.productId",
    "billing.product_id",
    "billing.sku",
    "billing.financeProductId",
    "billing.service_id",
    "billing.serviceId",
  ]) {
    addFinanceProductMappingCandidateKey(keys, readNestedValue(contract, path));
  }
  const productObj = readNestedValue(contract, "product");
  if (productObj && typeof productObj === "object") {
    addFinanceProductMappingCandidateKey(keys, productObj.id);
    addFinanceProductMappingCandidateKey(keys, productObj.productId);
    addFinanceProductMappingCandidateKey(keys, productObj.product_id);
    addFinanceProductMappingCandidateKey(keys, productObj.financeProductId);
    addFinanceProductMappingCandidateKey(keys, productObj.sku);
  }
  const serviceObj = readNestedValue(contract, "service");
  if (serviceObj && typeof serviceObj === "object") {
    addFinanceProductMappingCandidateKey(keys, serviceObj.id);
    addFinanceProductMappingCandidateKey(keys, serviceObj.serviceId);
    addFinanceProductMappingCandidateKey(keys, serviceObj.service_id);
    addFinanceProductMappingCandidateKey(keys, serviceObj.productId);
    addFinanceProductMappingCandidateKey(keys, serviceObj.product_id);
    addFinanceProductMappingCandidateKey(keys, serviceObj.sku);
  }
  const lineArrays = [
    readNestedArray(contract, "items"),
    readNestedArray(contract, "line_items"),
    readNestedArray(contract, "lines"),
    readNestedArray(contract, "products"),
    readNestedArray(contract, "services"),
    readNestedArray(contract, "contract_items"),
    readNestedArray(contract, "billing.items"),
    readNestedArray(contract, "billing.line_items"),
    readNestedArray(contract, "subscription.items"),
  ];
  for (const arr of lineArrays) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr.slice(0, 12)) {
      if (!row || typeof row !== "object") continue;
      addFinanceProductMappingCandidateKey(keys, row.productId);
      addFinanceProductMappingCandidateKey(keys, row.product_id);
      addFinanceProductMappingCandidateKey(keys, row.financeProductId);
      addFinanceProductMappingCandidateKey(keys, row.sku);
      addFinanceProductMappingCandidateKey(keys, row.id_produto);
      addFinanceProductMappingCandidateKey(keys, row.service_id);
      addFinanceProductMappingCandidateKey(keys, row.serviceId);
      const rp = row.product;
      if (rp && typeof rp === "object") {
        addFinanceProductMappingCandidateKey(keys, rp.id);
        addFinanceProductMappingCandidateKey(keys, rp.productId);
        addFinanceProductMappingCandidateKey(keys, rp.product_id);
      }
    }
  }
  return keys;
}

/**
 * Nomes / descrições de serviço no contrato (Colli Finance manda texto, não UUID).
 */
function collectFinanceProductMappingCandidateLabels(contract) {
  const labels = new Set();
  if (!contract || typeof contract !== "object") return labels;
  for (const path of [
    "serviceName",
    "service_name",
    "servicoNome",
    "servico_nome",
    "nomeServico",
    "nome_servico",
    "productName",
    "product_name",
    "productTitle",
    "planName",
    "plan_name",
    "planoNome",
    "title",
    "itemName",
    "item_name",
    "serviceLabel",
    "itemDescription",
    "descricao",
    "description",
    "name",
    "nome",
    "label",
    "billing.serviceName",
    "billing.productName",
    "billing.nome",
    "billing.descricao",
    "item.name",
    "item.nome",
    "item.title",
    "item.description",
    "item.descricao",
    "termos.descricao",
    "notes",
    "observacoes",
  ]) {
    addFinanceProductLabelCandidate(labels, readNestedValue(contract, path));
  }
  const lineArrays = [
    readNestedArray(contract, "items"),
    readNestedArray(contract, "line_items"),
    readNestedArray(contract, "lines"),
    readNestedArray(contract, "products"),
    readNestedArray(contract, "contract_items"),
    readNestedArray(contract, "billing.items"),
    readNestedArray(contract, "billing.line_items"),
    readNestedArray(contract, "subscription.items"),
    readNestedArray(contract, "services"),
  ];
  for (const arr of lineArrays) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr.slice(0, 12)) {
      if (!row || typeof row !== "object") continue;
      addFinanceProductLabelCandidate(labels, row.name);
      addFinanceProductLabelCandidate(labels, row.nome);
      addFinanceProductLabelCandidate(labels, row.title);
      addFinanceProductLabelCandidate(labels, row.label);
      addFinanceProductLabelCandidate(labels, row.serviceName);
      addFinanceProductLabelCandidate(labels, row.service_name);
      addFinanceProductLabelCandidate(labels, row.productName);
      addFinanceProductLabelCandidate(labels, row.description);
      addFinanceProductLabelCandidate(labels, row.descricao);
      const rp = row.product;
      if (rp && typeof rp === "object") {
        addFinanceProductLabelCandidate(labels, rp.name);
        addFinanceProductLabelCandidate(labels, rp.nome);
      }
    }
  }
  return labels;
}

/** Objetos onde o Finance/Lovable pode aninhar o id do produto (além do merge plano em `contract`). */
function gatherWebhookRootsForProductMapping(baseSource, contract) {
  const roots = [];
  const seen = new Set();
  const add = (o) => {
    if (!o || typeof o !== "object") return;
    if (seen.has(o)) return;
    seen.add(o);
    roots.push(o);
  };
  add(baseSource);
  add(contract);
  if (baseSource?.contract && typeof baseSource.contract === "object") add(baseSource.contract);
  const nestedKeys = ["data", "payload", "body", "record", "resource", "attributes", "meta", "event", "message", "details"];
  for (const key of nestedKeys) {
    const v = baseSource?.[key];
    if (v && typeof v === "object") add(v);
  }
  const nc = baseSource?.contract;
  if (nc && typeof nc === "object") {
    for (const key of nestedKeys) {
      const v = nc[key];
      if (v && typeof v === "object") add(v);
    }
  }
  return roots;
}

/** Primeira linha que definir cada chave vence (ID em minúsculas ou label normalizado). */
function buildFinanceProductMatchLookup(mappings) {
  const map = new Map();
  for (const m of mappings) {
    if (!m?.contaAzulItemId) continue;
    const itemId = String(m.contaAzulItemId).trim();
    if (!itemId) continue;
    const fid = String(m.financeProductId || "").trim();
    if (fid) {
      const k = fid.toLowerCase();
      if (!map.has(k)) map.set(k, itemId);
    }
    const flab = normalizeFinanceProductMatchKey(m.financeProductLabel);
    if (flab && !map.has(flab)) map.set(flab, itemId);
  }
  return map;
}

function lookupFinanceProductMatch(map, rawValue) {
  if (!map.size || rawValue == null || rawValue === "") return "";
  const t = String(rawValue).trim();
  if (!t) return "";
  const byLower = map.get(t.toLowerCase());
  if (byLower) return byLower;
  const norm = normalizeFinanceProductMatchKey(t);
  if (norm && map.has(norm)) return map.get(norm);
  return "";
}

/** Qualquer string/número no JSON que case com chave do mapa (id ou label). */
function deepWalkMatchFinanceProduct(map, node, depth = 0, seen = null) {
  if (!map.size || depth > 22 || node == null) return "";
  if (typeof node === "string" || typeof node === "number") {
    return lookupFinanceProductMatch(map, node);
  }
  if (typeof node !== "object") return "";
  if (node instanceof Date) return "";
  if (!seen) seen = new WeakSet();
  if (seen.has(node)) return "";
  seen.add(node);
  if (Array.isArray(node)) {
    for (const el of node) {
      const hit = deepWalkMatchFinanceProduct(map, el, depth + 1, seen);
      if (hit) return hit;
    }
    return "";
  }
  for (const v of Object.values(node)) {
    const hit = deepWalkMatchFinanceProduct(map, v, depth + 1, seen);
    if (hit) return hit;
  }
  return "";
}

function collectNormalizedTextChunksFromTree(node, acc, depth = 0, seen = null) {
  if (!node || depth > 22 || acc.length > 800) return;
  if (typeof node === "string" || typeof node === "number") {
    const norm = normalizeFinanceProductMatchKey(node);
    if (norm.length >= 2) acc.push(norm);
    return;
  }
  if (typeof node !== "object") return;
  if (node instanceof Date) return;
  if (!seen) seen = new WeakSet();
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const el of node) collectNormalizedTextChunksFromTree(el, acc, depth + 1, seen);
    return;
  }
  for (const v of Object.values(node)) collectNormalizedTextChunksFromTree(v, acc, depth + 1, seen);
}

/** Quando o contrato traz o nome em campo longo (ex.: observação) contendo o label cadastrado. */
function matchFinanceProductByLabelContains(roots, mappings) {
  const rows = [];
  for (const m of mappings) {
    const itemId = normalizeOptionalText(m?.contaAzulItemId, 160);
    const lab = normalizeFinanceProductMatchKey(m?.financeProductLabel);
    if (!itemId || lab.length < 4) continue;
    rows.push({ lab, itemId });
  }
  if (!rows.length) return "";
  const chunks = [];
  for (const root of roots) collectNormalizedTextChunksFromTree(root, chunks, 0, null);
  const uniq = [...new Set(chunks)];
  for (const { lab, itemId } of rows) {
    for (const chunk of uniq) {
      if (lab.length >= 5 && chunk.includes(lab)) return itemId;
      if (chunk.length >= 5 && lab.includes(chunk)) return itemId;
    }
  }
  return "";
}

function collectUuidLikeStringsFromTree(node, acc, depth = 0, seen = null) {
  if (!node || depth > 18 || acc.length >= 48) return;
  if (typeof node === "string" || typeof node === "number") {
    const s = String(node).trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) acc.push(s);
    return;
  }
  if (typeof node !== "object") return;
  if (node instanceof Date) return;
  if (!seen) seen = new WeakSet();
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const el of node) collectUuidLikeStringsFromTree(el, acc, depth + 1, seen);
    return;
  }
  for (const v of Object.values(node)) collectUuidLikeStringsFromTree(v, acc, depth + 1, seen);
}

function unionStructuredProductKeysFromRoots(baseSource, contract) {
  const u = new Set();
  for (const root of gatherWebhookRootsForProductMapping(baseSource, contract)) {
    for (const k of collectFinanceProductMappingCandidateKeys(root)) u.add(k);
  }
  return u;
}

function unionStructuredProductLabelsFromRoots(baseSource, contract) {
  const u = new Set();
  for (const root of gatherWebhookRootsForProductMapping(baseSource, contract)) {
    for (const k of collectFinanceProductMappingCandidateLabels(root)) u.add(k);
  }
  return u;
}

function resolveContaAzulItemFromProductMapping(contract, mappings, baseSource = null) {
  if (!Array.isArray(mappings) || !mappings.length) return "";
  const mapByKey = buildFinanceProductMatchLookup(mappings);
  if (!mapByKey.size) return "";

  const roots = gatherWebhookRootsForProductMapping(baseSource || {}, contract);
  for (const root of roots) {
    const candidateKeys = collectFinanceProductMappingCandidateKeys(root);
    for (const k of candidateKeys) {
      const hit = lookupFinanceProductMatch(mapByKey, k);
      if (hit) return hit;
    }
  }
  for (const root of roots) {
    for (const lbl of collectFinanceProductMappingCandidateLabels(root)) {
      const hit = lookupFinanceProductMatch(mapByKey, lbl);
      if (hit) return hit;
    }
  }
  for (const root of roots) {
    const hit = deepWalkMatchFinanceProduct(mapByKey, root, 0, null);
    if (hit) return hit;
  }
  const byContains = matchFinanceProductByLabelContains(roots, mappings);
  if (byContains) return byContains;

  // Pull do orquestrador sem nome/id no JSON: uma linha na tabela define o item sem ambiguidade.
  if (mappings.length === 1) {
    const only = mappings[0];
    const itemId = normalizeOptionalText(only?.contaAzulItemId, 160);
    const fid = normalizeOptionalText(only?.financeProductId, 160);
    const flab = normalizeOptionalText(only?.financeProductLabel, 240);
    if (itemId && (fid || flab)) return itemId;
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

const CONTRACT_CUSTOMER_NAME_PATHS = [
  "name",
  "customerName",
  "clientName",
  "client_name",
  "clienteNome",
  "cliente_nome",
  "nome_cliente",
  "razao_social",
  "razaoSocial",
  "companyName",
  "company_name",
  "organization.legal_name",
  "organization.legalName",
  "organization.trade_name",
  "organization.tradeName",
  "billing_clients.name",
  "billing_clients.nome",
  "billing_clients.razao_social",
  "billing_clients.razaoSocial",
  "billing_client.name",
  "billing_client.nome",
  "billing_client.razao_social",
  "billing_client.razaoSocial",
  "customer.name",
  "customer.nome",
  "customer.razao_social",
  "client.name",
  "client.nome",
  "client.razao_social",
  "cliente.name",
  "cliente.nome",
  "cliente.razao_social",
];

const CONTRACT_CUSTOMER_DOCUMENT_PATHS = [
  "cnpj",
  "cpf",
  "cpf_cnpj",
  "cpfCnpj",
  "document_digits",
  "documentDigits",
  "document_number",
  "documentNumber",
  "numero_documento",
  "numeroDocumento",
  "tax_id",
  "taxId",
  "documento",
  "document",
  "customerDocument",
  "clientDocument",
  "client_document",
  "billing_clients.cnpj_cpf",
  "billing_clients.cpf_cnpj",
  "billing_clients.document_digits",
  "billing_clients.documentDigits",
  "billing_clients.document_number",
  "billing_clients.documentNumber",
  "billing_clients.tax_id",
  "billing_clients.taxId",
  "billing_clients.cnpj",
  "billing_clients.cpf",
  "billing_clients.documento",
  "billing_client.cnpj_cpf",
  "billing_client.cpf_cnpj",
  "billing_client.document_digits",
  "billing_client.documentDigits",
  "billing_client.document_number",
  "billing_client.documentNumber",
  "billing_client.tax_id",
  "billing_client.taxId",
  "billing_client.cnpj",
  "billing_client.cpf",
  "billing_client.documento",
  "customer.cnpj_cpf",
  "customer.cpf_cnpj",
  "customer.document_digits",
  "customer.documentDigits",
  "customer.document_number",
  "customer.documentNumber",
  "customer.tax_id",
  "customer.taxId",
  "customer.cnpj",
  "customer.cpf",
  "customer.documento",
  "client.cnpj_cpf",
  "client.cpf_cnpj",
  "client.document_digits",
  "client.documentDigits",
  "client.document_number",
  "client.documentNumber",
  "client.tax_id",
  "client.taxId",
  "client.cnpj",
  "client.cpf",
  "client.documento",
  "cliente.cnpj_cpf",
  "cliente.cpf_cnpj",
  "cliente.cnpj",
  "cliente.cpf",
  "cliente.documento",
];

const CONTRACT_CUSTOMER_EMAIL_PATHS = [
  "email",
  "customerEmail",
  "clientEmail",
  "client_email",
  "contact.email",
  "billing_clients.email",
  "billing_clients.contact.email",
  "billing_client.email",
  "billing_client.contact.email",
  "customer.email",
  "customer.contact.email",
  "client.email",
  "client.contact.email",
  "cliente.email",
  "cliente.contact.email",
];

function getContractWithNestedPayload(source = {}) {
  const baseSource = source && typeof source === "object" ? source : {};
  const nestedContract = baseSource.contract && typeof baseSource.contract === "object" ? baseSource.contract : {};
  return { ...baseSource, ...nestedContract };
}

function buildContaAzulCustomerRecordFromContract(source = {}) {
  const contract = getContractWithNestedPayload(source);
  const rawDocument = pickFirstNested(contract, CONTRACT_CUSTOMER_DOCUMENT_PATHS);
  const documentDigits = normalizeContaAzulDocumentDigits(rawDocument);
  if (![11, 14].includes(documentDigits.length)) return null;

  const name =
    pickFirstText(pickFirstNested(contract, CONTRACT_CUSTOMER_NAME_PATHS)) ||
    (documentDigits.length === 14 ? `Cliente ${formatContaAzulBrazilianDocument(documentDigits)}` : `Cliente ${formatContaAzulBrazilianDocument(documentDigits)}`);
  const email = pickFirstText(pickFirstNested(contract, CONTRACT_CUSTOMER_EMAIL_PATHS));
  const payload = {
    nome: name,
    tipo_pessoa: documentDigits.length === 14 ? "Jurídica" : "Física",
    perfis: [{ tipo_perfil: "Cliente" }],
    ...(documentDigits.length === 14
      ? { cnpj: formatContaAzulBrazilianDocument(documentDigits) }
      : { cpf: formatContaAzulBrazilianDocument(documentDigits) }),
    ...(email ? { email } : {}),
  };

  return {
    document: formatContaAzulBrazilianDocument(documentDigits),
    documentDigits,
    name,
    email,
    payload,
  };
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
  const externalId = pickFirstText(
    contract.externalId,
    contract.external_id,
    contract.contractId,
    contract.contract_id,
    contract.id,
    contract.uuid,
    contract.codigo,
    contract.code
  );
  const firstDueDate = normalizeIsoDateFromFinance(
    pickFirstNested(contract, [
      "firstDueDate",
      "first_due_date",
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
  /** itens[0].id vem exclusivamente da tabela Produto Finance → Item (lovableContracts.financeProductMappings). */
  const mappedItemId = resolveContaAzulItemFromProductMapping(contract, lc.financeProductMappings, baseSource);
  const itemId = normalizeOptionalText(mappedItemId, 160) || "";
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
      "id_cliente",
      "contaAzulCustomerId",
      "contaAzulClientId",
      "conta_azul_client_id",
      "conta_azul_customer_id",
      "customer.contaAzulId",
      "client.contaAzulId",
      "cliente.id_cliente",
      "cliente.conta_azul_id",
      "cliente.contaAzulId",
      "billing_clients.conta_azul_id",
      "billing_clients.contaAzulId",
      "billing_clients.id_cliente",
      "billing_client.conta_azul_id",
      "billing_client.id_cliente",
      "customerId",
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
  const resolvedItemId = itemId;
  let lineValor = amount;
  if (paymentMapping) {
    if (paymentMapping.contaAzulFinancialAccountId) resolvedFinancialAccountId = paymentMapping.contaAzulFinancialAccountId;
    if (paymentMapping.contaAzulItemValor != null && Number.isFinite(paymentMapping.contaAzulItemValor)) {
      lineValor = paymentMapping.contaAzulItemValor;
    }
  }
  const dueDay = normalizeContaAzulDueDay(
    pickFirstNested(contract, ["dueDay", "due_day", "payment_due_day", "diaVencimento", "billing.dueDay", "billing.payment_due_day"]),
    firstDueDate || startDate
  );
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
  if (itemId && mergedContractPayload.itens?.[0]) {
    mergedContractPayload.itens[0] = { ...mergedContractPayload.itens[0], id: itemId };
  }
  const payload = compactContaAzulPayload(sanitizeContaAzulContractPayloadTypes(mergedContractPayload));

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

  const productMappingDebug =
    missingRequiredFields.includes("itens[0].id") && Array.isArray(lc.financeProductMappings)
      ? (() => {
          const uuidLike = [];
          collectUuidLikeStringsFromTree(baseSource, uuidLike);
          return {
            payloadProductKeys: [...unionStructuredProductKeysFromRoots(baseSource, contract)].slice(0, 24),
            payloadProductLabels: [...unionStructuredProductLabelsFromRoots(baseSource, contract)].slice(0, 24),
            uuidLikeInWebhook: [...new Set(uuidLike)].slice(0, 24),
            configuredFinanceProductIds: lc.financeProductMappings
              .map((m) => normalizeOptionalText(m.financeProductId, 160))
              .filter(Boolean)
              .slice(0, 24),
            configuredFinanceProductLabels: lc.financeProductMappings
              .map((m) => normalizeOptionalText(m.financeProductLabel, 200))
              .filter(Boolean)
              .slice(0, 24),
          };
        })()
      : null;

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
    productMappingDebug,
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
  const externalId = pickFirstText(
    payment.externalId,
    payment.external_id,
    payment.paymentId,
    payment.payment_id,
    payment.receiptId,
    payment.receipt_id,
    payment.id,
    payment.uuid
  );
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
  CONTA_AZUL_SERVICOS_PATH,
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
  buildContaAzulInventoryListPath,
  buildContaAzulProductsPath,
  buildContaAzulServicosPath,
  buildContaAzulFinancialEventsSearchPath,
  buildContaAzulFpaExportPayload,
  buildContaAzulFpaFinancialEventRecord,
  buildContaAzulCustomerRecordFromContract,
  buildContaAzulTestFinancialEventRecord,
  buildContaAzulHeaders,
  buildContaAzulPeoplePath,
  buildContaAzulTokenHeaders,
  createDefaultContaAzulSettings,
  filterContaAzulCatalogByMode,
  getContaAzulFpaExportCandidates,
  getContaAzulLovableContractPaths,
  isContaAzulAccessTokenExpired,
  mergeContaAzulCatalogListRows,
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
  normalizeContaAzulDocumentDigits,
  normalizeContaAzulProduct,
  normalizeContaAzulProductsPageSize,
  normalizeContaAzulServicosPageSize,
  normalizeContaAzulSettings,
  prependContaAzulSyncHistory,
  reconcileContaAzulFinancialRecords,
  resolveContaAzulEndpointUrl,
  resolveFinancePaymentMapping,
  sanitizeContaAzulSettings,
};
