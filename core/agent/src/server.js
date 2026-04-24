const crypto = require("node:crypto");
const path = require("node:path");

const express = require("express");
const multer = require("multer");

const { createBasicAuthMiddleware, getAdminCredentialsFromEnv } = require("./lib/basic-auth");
const { truncateText } = require("./lib/domain");
const {
  createFpaDreAccount,
  createFpaImport,
  deleteFpaAccount,
  deleteFpaDreAccount,
  deleteFpaTransaction,
  findLovableContractSync,
  findLovableReceiptSync,
  getLatestReceivablesOrchestratorRun,
  getSettings,
  getStorageStatus,
  listFpaCategoryRules,
  listFpaDreAccounts,
  listFpaImports,
  listFpaTransactions,
  listLovableContractSyncs,
  listLovableReceiptSyncs,
  listReceivablesOrchestratorRuns,
  recordContaAzulSync,
  sanitizeLovableSettings,
  seedFpaDreAccounts,
  upsertReceivablesOrchestratorRun,
  upsertLovableContractSync,
  upsertLovableReceiptSync,
  updateFpaDreAccount,
  updateFpaTransaction,
  updateFpaTransactionsBatch,
  updateSettings,
  listFinancePaymentLinks,
  findFinancePaymentLinkByMethod,
  findFinancePaymentLinkByCategory,
  upsertFinancePaymentLink,
  deleteFinancePaymentLink,
} = require("./lib/store");
const {
  CATEGORY_OPTIONS,
  DRE_TYPE_OPTIONS,
  buildAvailableAccounts,
  buildAvailableCategories,
  buildAvailableMonths,
  buildDreReconciliation,
  buildFpaOverview,
  buildRequestedFpaReport,
  buildSuggestedDreAccounts,
  filterTransactions,
  normalizeMonthFilters,
  parseStatementFile,
} = require("./lib/fpa");
const {
  CONTA_AZUL_CONNECTED_ACCOUNT_PATH,
  CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE,
  CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE,
  getContaAzulLovableContractPaths,
  applyContaAzulTokenPayload,
  buildContaAzulAcquittanceRecord,
  buildContaAzulAuthorizationUrl,
  buildContaAzulContractRecord,
  buildContaAzulFinancialAccountsPath,
  buildContaAzulFinancialCategoriesPath,
  buildContaAzulProductsPath,
  buildContaAzulFinancialEventsSearchPath,
  buildContaAzulFpaExportPayload,
  buildContaAzulHeaders,
  buildContaAzulPeoplePath,
  buildContaAzulTestFinancialEventRecord,
  buildContaAzulTokenHeaders,
  isContaAzulAccessTokenExpired,
  mergeContaAzulSettings,
  normalizeContaAzulAcquittanceResponse,
  normalizeContaAzulAuthorizationCode,
  normalizeContaAzulConnectedAccount,
  normalizeContaAzulContractResponse,
  normalizeContaAzulFinancialAccount,
  normalizeContaAzulFinancialCategory,
  normalizeContaAzulFinancialInstallment,
  normalizeContaAzulProduct,
  normalizeContaAzulListItems,
  normalizeContaAzulPerson,
  normalizeContaAzulProductsPageSize,
  normalizeContaAzulSettings,
  reconcileContaAzulFinancialRecords,
  resolveContaAzulEndpointUrl,
  sanitizeContaAzulSettings,
} = require("./lib/conta-azul");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const STATIC_DIR = path.join(__dirname, "static");
const HOME_INDEX = path.join(STATIC_DIR, "index.html");
const FPA_INDEX = path.join(STATIC_DIR, "fpa.html");
const RECEIVABLES_ANALYSIS_INDEX = path.join(STATIC_DIR, "receivables-analysis.html");
const CONTA_AZUL_VINCULOS_INDEX = path.join(STATIC_DIR, "conta-azul-vinculos.html");
const DEFAULT_COBRANCAS_URL = "https://bot-cobranca-25qf.onrender.com";
const DEFAULT_EXTRATOR_URL = "https://bot-extrator.onrender.com";
let receivablesOrchestratorPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function readLargeLimit(raw, fallback = 120) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), 5000);
}

function readFpaMonths(rawValue) {
  if (Array.isArray(rawValue)) {
    return normalizeMonthFilters(rawValue.flatMap((value) => String(value || "").split(",").map((item) => item.trim())));
  }
  return normalizeMonthFilters(String(rawValue || "").split(",").map((item) => item.trim()));
}

function readFpaAccountName(value) {
  return truncateText(value, 120) || null;
}

function readMoneyAmountCents(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 100);
}

function readNestedValue(source, path) {
  return String(path || "")
    .split(".")
    .reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), source);
}

function readFirstValue(source, paths = []) {
  for (const path of paths) {
    const value = readNestedValue(source, path);
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function readFirstText(source, paths = [], maxLength = 160) {
  return truncateText(readFirstValue(source, paths), maxLength);
}

function readLovableAmountCents(source = {}) {
  const centsValue = readFirstValue(source, [
    "amountCents",
    "paidAmountCents",
    "valueCents",
    "valorCentavos",
    "payment.amountCents",
    "receipt.amountCents",
  ]);
  const parsedCents = Number(centsValue);
  if (Number.isFinite(parsedCents) && parsedCents > 0) return Math.round(parsedCents);
  return readMoneyAmountCents(
    readFirstValue(source, [
      "amount",
      "paidAmount",
      "value",
      "valor",
      "valorPago",
      "payment.amount",
      "payment.paidAmount",
      "receipt.amount",
      "receipt.paidAmount",
    ])
  );
}

function safeCompareSecrets(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readLovableWebhookSecret(req) {
  const bearer = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return (
    String(req.headers["x-lovable-webhook-secret"] || "").trim() ||
    String(req.headers["x-webhook-secret"] || "").trim() ||
    bearer.trim()
  );
}

async function requireLovableWebhookAuth(req, res, next) {
  const settings = await getSettings();
  const lovableSettings = settings?.lovable || {};
  const environmentSecret = String(process.env.LOVABLE_WEBHOOK_SECRET || "").trim();
  const storedSecret = String(lovableSettings.webhookSecret || "").trim();
  const expectedSecrets = [environmentSecret, lovableSettings.enabled ? storedSecret : ""].filter(Boolean);

  if (!expectedSecrets.length) {
    next(createHttpError(503, "Configure e ative a integração Lovable antes de receber webhooks."));
    return;
  }
  const receivedSecret = readLovableWebhookSecret(req);
  if (!expectedSecrets.some((expectedSecret) => safeCompareSecrets(receivedSecret, expectedSecret))) {
    next(createHttpError(401, "Webhook Lovable não autorizado."));
    return;
  }
  next();
}

function createContaAzulOAuthState() {
  return crypto.randomBytes(16).toString("hex");
}

function getContaAzulSettings(settings) {
  return normalizeContaAzulSettings(settings?.contaAzul);
}

function sanitizeSettingsForClient(settings) {
  const safeSettings = settings && typeof settings === "object" ? settings : {};
  return {
    contaAzul: sanitizeContaAzulSettings(safeSettings.contaAzul),
    lovable: sanitizeLovableSettings(safeSettings.lovable),
    storage: getStorageStatus(),
  };
}

function ensureContaAzulOAuthClientSettings(contaAzulSettings, { requireClientSecret = true } = {}) {
  if (!contaAzulSettings.clientId) {
    throw createHttpError(400, "Informe o client_id do app Conta Azul.");
  }
  if (requireClientSecret && !contaAzulSettings.clientSecret) {
    throw createHttpError(400, "Informe o client_secret do app Conta Azul.");
  }
  if (!contaAzulSettings.redirectUri) {
    throw createHttpError(400, "Informe a redirect_uri cadastrada no app Conta Azul.");
  }
}

function buildContaAzulSuggestedRedirectUri(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  return `${protocol}://${req.get("host")}/api/conta-azul/oauth/callback`;
}

function buildContaAzulResponsePreview(rawText) {
  const safeText = String(rawText || "").trim();
  if (!safeText) return "";
  return safeText.length <= 1200 ? safeText : `${safeText.slice(0, 1197)}...`;
}

function readFirstEnvEntry(keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return { key, value };
  }
  return { key: keys?.[0] || "", value: "" };
}

function readFirstEnvValue(keys) {
  return readFirstEnvEntry(keys).value;
}

function resolveModuleUrl(envKeys) {
  return readFirstEnvValue(envKeys);
}

function resolveProxyBaseUrl(config) {
  const externalBaseUrl = normalizeProxyBaseUrl(resolveModuleUrl(config.externalEnvKeys));
  if (externalBaseUrl) return externalBaseUrl;

  const internalBaseUrl = normalizeProxyBaseUrl(readFirstEnvValue(config.internalEnvKeys));
  if (internalBaseUrl) return internalBaseUrl;

  return normalizeProxyBaseUrl(config.defaultExternalUrl);
}

function normalizeProxyBaseUrl(rawValue) {
  const value = String(rawValue || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function buildProxyHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    const lowerKey = key.toLowerCase();
    if (["connection", "content-length", "host", "transfer-encoding"].includes(lowerKey)) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (value != null) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function buildInternalModuleAuthorizationHeader() {
  const username = String(process.env.ADMIN_USER || "").trim();
  const password = process.env.ADMIN_PASSWORD == null ? "" : String(process.env.ADMIN_PASSWORD);
  if (!username || !password) return "";
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function applyInternalModuleAuthorization(headers) {
  if (headers.has("authorization")) return headers;
  const authorization = buildInternalModuleAuthorizationHeader();
  if (authorization) headers.set("authorization", authorization);
  return headers;
}

function buildProxyBody(req) {
  if (["GET", "HEAD"].includes(req.method)) return undefined;
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json") && req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }
  if (contentType.includes("application/x-www-form-urlencoded") && req.body && typeof req.body === "object") {
    return new URLSearchParams(req.body).toString();
  }
  return req;
}

function rewriteCobrancasHtml(html) {
  return String(html || "")
    .replaceAll('"/api/', '"/cobrancas/api/')
    .replaceAll("'/api/", "'/cobrancas/api/")
    .replaceAll("`/api/", "`/cobrancas/api/")
    .replaceAll('"/uploads/', '"/cobrancas/uploads/')
    .replaceAll("'/uploads/", "'/cobrancas/uploads/")
    .replaceAll("`/uploads/", "`/cobrancas/uploads/");
}

function rewriteExtratorHtml(html) {
  return String(html || "")
    .replaceAll('action="/run"', 'action="/extrator/run"')
    .replaceAll("action='/run'", "action='/extrator/run'")
    .replaceAll('href="/"', 'href="/extrator"')
    .replaceAll("href='/'", "href='/extrator'");
}

function copyProxyResponseHeaders(proxyResponse, res, { contentLength = null, mountPath = "" } = {}) {
  proxyResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (["connection", "content-encoding", "content-length", "transfer-encoding"].includes(lowerKey)) return;
    if (lowerKey === "location" && mountPath && value.startsWith("/")) {
      res.setHeader(key, value === "/" ? mountPath : `${mountPath}${value}`);
      return;
    }
    res.setHeader(key, value);
  });
  if (contentLength != null) res.setHeader("content-length", String(contentLength));
}

function sendModuleNotConfigured(res, { title, description, envName }) {
  res.status(503).type("html").send(`
    <!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${title}</title>
      </head>
      <body style="font-family: system-ui, sans-serif; margin: 40px; line-height: 1.5;">
        <h1>${title}</h1>
        <p>${description}</p>
        <p>Defina <code>${envName}</code> apontando para o servico do Blueprint no Render ou sincronize o Blueprint novamente.</p>
        <p><a href="/">Voltar ao Colli Finance OS</a></p>
      </body>
    </html>
  `);
}

async function proxyModule(req, res, config) {
  const moduleBaseUrl = resolveProxyBaseUrl(config);
  if (!moduleBaseUrl) {
    sendModuleNotConfigured(res, config.notConfigured);
    return;
  }

  const suffix = req.originalUrl.slice(config.mountPath.length) || "/";
  const targetPath = suffix === "/" ? "/" : suffix;
  const targetUrl = new URL(targetPath, `${moduleBaseUrl}/`);
  const proxyOptions = {
    method: req.method,
    headers: applyInternalModuleAuthorization(buildProxyHeaders(req)),
    body: buildProxyBody(req),
    redirect: "manual",
  };
  if (proxyOptions.body && proxyOptions.body === req) proxyOptions.duplex = "half";

  const proxyResponse = await fetch(targetUrl, proxyOptions);
  const contentType = String(proxyResponse.headers.get("content-type") || "");
  if (contentType.includes("text/html")) {
    const html = config.rewriteHtml(await proxyResponse.text());
    const payload = Buffer.from(html, "utf8");
    copyProxyResponseHeaders(proxyResponse, res, { contentLength: payload.length, mountPath: config.mountPath });
    res.status(proxyResponse.status).send(payload);
    return;
  }

  const payload = Buffer.from(await proxyResponse.arrayBuffer());
  copyProxyResponseHeaders(proxyResponse, res, { contentLength: payload.length, mountPath: config.mountPath });
  res.status(proxyResponse.status).send(payload);
}

async function proxyCobrancasModule(req, res) {
  return proxyModule(req, res, {
    mountPath: "/cobrancas",
    internalEnvKeys: ["COBRANCAS_INTERNAL_URL", "BOT_COBRANCA_INTERNAL_URL"],
    externalEnvKeys: ["COBRANCAS_URL", "BOT_COBRANCA_URL"],
    defaultExternalUrl: DEFAULT_COBRANCAS_URL,
    rewriteHtml: rewriteCobrancasHtml,
    notConfigured: {
      title: "Modulo de cobrancas nao configurado",
      description: "O sistema principal ainda nao recebeu o endpoint interno do modulo de cobrancas.",
      envName: "COBRANCAS_INTERNAL_URL",
    },
  });
}

async function proxyExtratorModule(req, res) {
  return proxyModule(req, res, {
    mountPath: "/extrator",
    internalEnvKeys: ["EXTRATOR_INTERNAL_URL", "BOT_EXTRATOR_INTERNAL_URL"],
    externalEnvKeys: ["EXTRATOR_URL", "BOT_EXTRATOR_URL"],
    defaultExternalUrl: DEFAULT_EXTRATOR_URL,
    rewriteHtml: rewriteExtratorHtml,
    notConfigured: {
      title: "Bot Extrator nao configurado",
      description: "O sistema principal ainda nao recebeu o endpoint interno do bot extrator.",
      envName: "EXTRATOR_INTERNAL_URL",
    },
  });
}

async function readContaAzulResponse(response) {
  const rawText = await response.text();
  const preview = buildContaAzulResponsePreview(rawText);
  try {
    return {
      preview,
      json: rawText ? JSON.parse(rawText) : null,
    };
  } catch {
    return {
      preview,
      json: null,
    };
  }
}

async function fetchContaAzulConnectedAccount(contaAzulSettings) {
  const primaryPath = contaAzulSettings.healthEndpoint || CONTA_AZUL_CONNECTED_ACCOUNT_PATH;
  const endpoint = resolveContaAzulEndpointUrl(contaAzulSettings.baseUrl, primaryPath);
  if (!endpoint) {
    throw createHttpError(400, "Configure a URL base da API do Conta Azul antes de validar a conta conectada.");
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers: buildContaAzulHeaders(contaAzulSettings),
    signal: AbortSignal.timeout(12000),
  });
  const parsed = await readContaAzulResponse(response);

  // If the primary endpoint doesn't exist, fall back to listing pessoas (validates token)
  if (response.status === 404 && primaryPath === CONTA_AZUL_CONNECTED_ACCOUNT_PATH) {
    const fallbackPath = "/v1/pessoas?pagina=1&tamanho_pagina=1";
    const fallbackEndpoint = resolveContaAzulEndpointUrl(contaAzulSettings.baseUrl, fallbackPath);
    const fallbackResponse = await fetch(fallbackEndpoint, {
      method: "GET",
      headers: buildContaAzulHeaders(contaAzulSettings),
      signal: AbortSignal.timeout(12000),
    });
    const fallbackParsed = await readContaAzulResponse(fallbackResponse);
    if (!fallbackResponse.ok) {
      throw createHttpError(
        fallbackResponse.status === 401 ? 401 : 400,
        `Conta Azul respondeu com status ${fallbackResponse.status}. ${fallbackParsed.preview || "Sem corpo na resposta."}`
      );
    }
    const list = Array.isArray(fallbackParsed.json)
      ? fallbackParsed.json
      : (fallbackParsed.json?.data || fallbackParsed.json?.pessoas || []);
    return {
      endpoint: fallbackEndpoint,
      response: fallbackResponse,
      parsed: fallbackParsed,
      connectedAccount: normalizeContaAzulConnectedAccount(list[0] || {}),
    };
  }

  if (!response.ok) {
    throw createHttpError(
      response.status === 401 ? 401 : 400,
      `Conta Azul respondeu com status ${response.status}. ${parsed.preview || "Sem corpo na resposta."}`
    );
  }

  return {
    endpoint,
    response,
    parsed,
    connectedAccount: normalizeContaAzulConnectedAccount(parsed.json),
  };
}

async function fetchContaAzulJson(contaAzulSettings, endpointPath) {
  const endpoint = resolveContaAzulEndpointUrl(contaAzulSettings.baseUrl, endpointPath);
  if (!endpoint) throw createHttpError(400, "Configure a URL base da API do Conta Azul antes de consultar dados.");

  const response = await fetch(endpoint, {
    method: "GET",
    headers: buildContaAzulHeaders(contaAzulSettings),
    signal: AbortSignal.timeout(15000),
  });
  const parsed = await readContaAzulResponse(response);
  if (!response.ok) {
    throw createHttpError(
      response.status === 401 ? 401 : 400,
      `Conta Azul respondeu com status ${response.status}. ${parsed.preview || "Sem corpo na resposta."}`
    );
  }

  return { endpoint, response, parsed };
}

async function fetchContaAzulProductsAggregated(contaAzulSettings, { search, status, pageSize: requestedSize } = {}) {
  const pageSize = normalizeContaAzulProductsPageSize(requestedSize ?? 500);
  const maxPages = 30;
  const all = [];
  const seen = new Set();
  let page = 1;
  let lastEndpoint = "";
  while (page <= maxPages) {
    const endpointPath = buildContaAzulProductsPath({ search, page, pageSize, status });
    const result = await fetchContaAzulJson(contaAzulSettings, endpointPath);
    lastEndpoint = result.endpoint;
    const batch = normalizeContaAzulListItems(result.parsed.json).map(normalizeContaAzulProduct).filter((item) => item.id);
    for (const item of batch) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
    const reported = Number(result.parsed.json?.total_itens ?? result.parsed.json?.totalItems ?? 0);
    if (batch.length === 0) break;
    if (batch.length < pageSize) break;
    if (Number.isFinite(reported) && reported > 0 && all.length >= reported) break;
    page += 1;
  }
  return { items: all, total: all.length, endpoint: lastEndpoint };
}

async function postContaAzulJson(contaAzulSettings, endpointPath, payload) {
  const endpoint = resolveContaAzulEndpointUrl(contaAzulSettings.baseUrl, endpointPath);
  if (!endpoint) throw createHttpError(400, "Configure a URL base da API do Conta Azul antes de enviar dados.");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildContaAzulHeaders(contaAzulSettings),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const parsed = await readContaAzulResponse(response);
  return { endpoint, response, parsed };
}

async function fetchContaAzulNextContractNumber(contaAzulSettings) {
  const { nextContractNumberPath } = getContaAzulLovableContractPaths(contaAzulSettings);
  const result = await fetchContaAzulJson(contaAzulSettings, nextContractNumberPath);
  const parsedNumber = Number(result.parsed.json);
  return Number.isFinite(parsedNumber) && parsedNumber > 0 ? Math.trunc(parsedNumber) : null;
}

async function requestContaAzulToken({ contaAzulSettings, grantType, code, refreshToken }) {
  ensureContaAzulOAuthClientSettings(contaAzulSettings);
  const params = new URLSearchParams({
    client_id: contaAzulSettings.clientId,
    client_secret: contaAzulSettings.clientSecret,
    grant_type: grantType,
  });

  if (grantType === "authorization_code") {
    if (!code) throw createHttpError(400, "Informe o código de autorização recebido no fluxo OAuth.");
    params.set("code", String(code).trim());
    params.set("redirect_uri", contaAzulSettings.redirectUri);
  } else if (grantType === "refresh_token") {
    const safeRefreshToken = String(refreshToken || contaAzulSettings.refreshToken || "").trim();
    if (!safeRefreshToken) throw createHttpError(400, "Nenhum refresh token salvo para a integração Conta Azul.");
    params.set("refresh_token", safeRefreshToken);
  } else {
    throw createHttpError(400, "Grant type inválido para o fluxo OAuth do Conta Azul.");
  }

  const response = await fetch(contaAzulSettings.tokenUrl, {
    method: "POST",
    headers: buildContaAzulTokenHeaders(contaAzulSettings),
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const parsed = await readContaAzulResponse(response);
  if (!response.ok) {
    throw createHttpError(
      response.status === 401 ? 401 : 400,
      `Falha ao obter token no Conta Azul. ${parsed.preview || `HTTP ${response.status}`}`
    );
  }
  if (!parsed.json?.access_token) {
    throw createHttpError(400, "O Conta Azul não retornou um access_token válido.");
  }

  return {
    response,
    parsed,
    nextSettings: applyContaAzulTokenPayload(contaAzulSettings, parsed.json),
  };
}

async function persistContaAzulOAuthSuccess({ currentSettings, nextSettings, connectedAccount, kind, endpoint, responseCode, summary }) {
  const timestamp = nowIso();
  await updateSettings({
    contaAzul: {
      accessToken: nextSettings.accessToken,
      refreshToken: nextSettings.refreshToken,
      tokenType: nextSettings.tokenType,
      accessTokenExpiresAt: nextSettings.accessTokenExpiresAt,
      connectedAccount,
      status: {
        ...currentSettings.status,
        lastConnectionCheckAt: timestamp,
        lastConnectionOk: true,
        lastAuthorizedAt: kind === "oauth_authorize" ? timestamp : currentSettings.status.lastAuthorizedAt,
        lastTokenRefreshAt: kind === "oauth_refresh" ? timestamp : currentSettings.status.lastTokenRefreshAt,
        oauthState: null,
        oauthStateIssuedAt: null,
        lastError: null,
      },
    },
  });
  await recordContaAzulSync(
    {
      kind: kind === "connection" ? "connection" : "oauth",
      direction: "outbound",
      resource: "oauth",
      status: "success",
      endpoint,
      recordCount: 0,
      responseCode,
      summary,
      startedAt: timestamp,
      finishedAt: timestamp,
    },
    {
      lastConnectionCheckAt: timestamp,
      lastConnectionOk: true,
      lastAuthorizedAt: kind === "oauth_authorize" ? timestamp : currentSettings.status.lastAuthorizedAt,
      lastTokenRefreshAt: kind === "oauth_refresh" ? timestamp : currentSettings.status.lastTokenRefreshAt,
      lastError: null,
    }
  );
}

async function ensureContaAzulAccessToken(currentSettings, { allowRefresh = true } = {}) {
  const contaAzulSettings = getContaAzulSettings(currentSettings);
  const hasExpiredToken = Boolean(contaAzulSettings.accessToken) && isContaAzulAccessTokenExpired(contaAzulSettings);
  if (contaAzulSettings.accessToken && !hasExpiredToken) return contaAzulSettings;
  if (!allowRefresh || !contaAzulSettings.refreshToken) {
    throw createHttpError(401, "Conecte novamente o Conta Azul para obter um access token válido.");
  }

  const tokenResult = await requestContaAzulToken({ contaAzulSettings, grantType: "refresh_token" });
  const accountResult = await fetchContaAzulConnectedAccount(tokenResult.nextSettings);
  await persistContaAzulOAuthSuccess({
    currentSettings: contaAzulSettings,
    nextSettings: tokenResult.nextSettings,
    connectedAccount: accountResult.connectedAccount,
    kind: "oauth_refresh",
    endpoint: contaAzulSettings.tokenUrl,
    responseCode: tokenResult.response.status,
    summary: "Token Conta Azul renovado com sucesso.",
  });

  return mergeContaAzulSettings(tokenResult.nextSettings, { connectedAccount: accountResult.connectedAccount });
}

function readFpaContaAzulExportFilters(source = {}) {
  return {
    from: String(source?.from || "").trim() || null,
    to: String(source?.to || "").trim() || null,
    months: readFpaMonths(source?.months),
    accountName: readFpaAccountName(source?.accountName),
  };
}

async function buildFpaContaAzulExportContext(source = {}) {
  const filters = readFpaContaAzulExportFilters(source);
  const [settings, transactions] = await Promise.all([getSettings(), listFpaTransactions({ limit: 5000 })]);
  const contaAzulSettings = getContaAzulSettings(settings);
  const scopedTransactions = filterTransactions(transactions, filters);
  const payload = buildContaAzulFpaExportPayload({ settings: contaAzulSettings, transactions: scopedTransactions });
  return { settings, contaAzulSettings, filters, transactions: scopedTransactions, payload };
}

function resolveContaAzulReconciliationRange(records) {
  const dates = (Array.isArray(records) ? records : [])
    .map((record) => record?.payload?.condicao_pagamento?.parcelas?.[0]?.data_vencimento || record?.transactionDate)
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")))
    .sort();
  return {
    from: dates[0] || null,
    to: dates.at(-1) || null,
  };
}

async function fetchContaAzulFinancialInstallments(contaAzulSettings, { type, from, to }) {
  const endpointPath = buildContaAzulFinancialEventsSearchPath({
    type,
    from,
    to,
    pageSize: 500,
    financialAccountId: contaAzulSettings.fpaExport.defaultFinancialAccountId,
  });
  const result = await fetchContaAzulJson(contaAzulSettings, endpointPath);
  const items = normalizeContaAzulListItems(result.parsed.json)
    .map((item) => normalizeContaAzulFinancialInstallment(item, type))
    .filter((item) => item.id || Number.isInteger(item.amountCents));

  return {
    endpoint: result.endpoint,
    responseCode: result.response.status,
    items,
  };
}

function isContaAzulInstallmentOpen(installment) {
  const status = String(installment?.status || "").toUpperCase();
  return !["QUITADO", "RECEBIDO", "CANCELADO", "PERDIDO"].includes(status);
}

function selectContaAzulInstallment(candidates, { amountCents, dueDate } = {}) {
  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  if (!safeCandidates.length) return null;
  const scored = safeCandidates
    .map((installment) => {
      let score = 0;
      if (isContaAzulInstallmentOpen(installment)) score += 20;
      if (amountCents && installment.amountCents && Math.abs(installment.amountCents - amountCents) <= 1) score += 45;
      if (dueDate && [installment.dueDate, installment.competenceDate].includes(dueDate)) score += 35;
      return { installment, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.installment || null;
}

async function fetchContaAzulInstallmentsByEventId(contaAzulSettings, eventId) {
  const safeEventId = truncateText(eventId, 160);
  if (!safeEventId) return [];
  const result = await fetchContaAzulJson(contaAzulSettings, `/v1/financeiro/eventos-financeiros/${encodeURIComponent(safeEventId)}/parcelas`);
  return normalizeContaAzulListItems(result.parsed.json)
    .map((item) => normalizeContaAzulFinancialInstallment(item, "receivable"))
    .filter((item) => item.id);
}

async function resolveContaAzulInstallmentForLovableReceipt(contaAzulSettings, source = {}) {
  const directInstallmentId = readFirstText(source, [
    "installmentId",
    "parcelaId",
    "contaAzulInstallmentId",
    "id_parcela",
    "payment.installmentId",
    "payment.parcelaId",
    "receipt.installmentId",
    "receipt.parcelaId",
  ]);
  if (directInstallmentId) return { id: directInstallmentId, source: "payload" };

  const amountCents = readLovableAmountCents(source);
  const dueDate =
    readFirstText(source, ["dueDate", "dataVencimento", "payment.dueDate", "receipt.dueDate"], 10) ||
    readFirstText(source, ["paidAt", "paymentDate", "dataPagamento", "payment.paidAt", "receipt.paidAt"], 10);
  const eventId = readFirstText(source, [
    "eventId",
    "financialEventId",
    "contaAzulEventId",
    "id_evento",
    "payment.eventId",
    "receipt.eventId",
  ]);
  if (eventId) {
    const installments = await fetchContaAzulInstallmentsByEventId(contaAzulSettings, eventId);
    const selected = selectContaAzulInstallment(installments, { amountCents, dueDate });
    if (selected?.id) return { ...selected, source: "event_installments" };
  }

  if (!dueDate && !amountCents) return null;
  const endpointPath = buildContaAzulFinancialEventsSearchPath({
    type: "receivable",
    from: dueDate || new Date().toISOString().slice(0, 10),
    to: dueDate || new Date().toISOString().slice(0, 10),
    pageSize: 100,
    financialAccountId: contaAzulSettings.fpaExport.defaultFinancialAccountId,
    amountCents,
  });
  const result = await fetchContaAzulJson(contaAzulSettings, endpointPath);
  const candidates = normalizeContaAzulListItems(result.parsed.json)
    .map((item) => normalizeContaAzulFinancialInstallment(item, "receivable"))
    .filter((item) => item.id);
  const selected = selectContaAzulInstallment(candidates, { amountCents, dueDate });
  return selected?.id ? { ...selected, source: "receivable_search" } : null;
}

function collectMissingRequiredFields(records) {
  return Array.from(new Set((Array.isArray(records) ? records : []).flatMap((record) => record.missingRequiredFields || [])));
}

async function buildFpaContaAzulReconciliationContext(source = {}) {
  const exportContext = await buildFpaContaAzulExportContext(source);
  if (!exportContext.payload.records.length) {
    return {
      ...exportContext,
      contaAzulSettings: exportContext.contaAzulSettings,
      reconciliation: reconcileContaAzulFinancialRecords([], []),
      contaAzulRecords: [],
      range: { from: null, to: null },
    };
  }

  const contaAzulSettings = await ensureContaAzulAccessToken(exportContext.settings, { allowRefresh: true });
  const payload = buildContaAzulFpaExportPayload({ settings: contaAzulSettings, transactions: exportContext.transactions });
  const range = resolveContaAzulReconciliationRange(payload.records);
  if (!range.from || !range.to) {
    return {
      ...exportContext,
      contaAzulSettings,
      payload,
      reconciliation: reconcileContaAzulFinancialRecords(payload.records, []),
      contaAzulRecords: [],
      range,
    };
  }

  const typesToFetch = Array.from(new Set(payload.records.map((record) => record.type)));
  const fetchedGroups = await Promise.all(
    typesToFetch.map((type) => fetchContaAzulFinancialInstallments(contaAzulSettings, { type, from: range.from, to: range.to }))
  );
  const contaAzulRecords = fetchedGroups.flatMap((group) => group.items);

  return {
    ...exportContext,
    contaAzulSettings,
    payload,
    range,
    contaAzulRecords,
    contaAzulEndpoints: fetchedGroups.map((group) => ({ endpoint: group.endpoint, responseCode: group.responseCode, count: group.items.length })),
    reconciliation: reconcileContaAzulFinancialRecords(payload.records, contaAzulRecords),
  };
}

const app = express();
const statementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single("statement");

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(STATIC_DIR, { index: false }));

app.get("/healthz", (req, res) => {
  res.json({ ok: true, service: "analista-fpa" });
});

app.get(
  "/api/conta-azul/oauth/callback",
  asyncHandler(async (req, res) => {
    const currentSettingsWrapper = await getSettings();
    const contaAzulSettings = getContaAzulSettings(currentSettingsWrapper);
    const startedAt = nowIso();
    const stateParam = String(req.query?.state || "").trim();
    const codeParam = String(req.query?.code || "").trim();
    const errorParam = String(req.query?.error || "").trim();
    const errorDescription = String(req.query?.error_description || "").trim();

    if (errorParam) {
      const message = errorDescription || `Conta Azul retornou o erro ${errorParam}.`;
      await updateSettings({
        contaAzul: {
          status: {
            lastConnectionCheckAt: nowIso(),
            lastConnectionOk: false,
            oauthState: null,
            oauthStateIssuedAt: null,
            lastError: message,
          },
        },
      });
      await recordContaAzulSync(
        {
          kind: "oauth",
          direction: "outbound",
          resource: "oauth",
          status: "error",
          endpoint: contaAzulSettings.authorizationUrl,
          recordCount: 0,
          summary: "Autorização do Conta Azul rejeitada.",
          errorMessage: message,
          startedAt,
          finishedAt: nowIso(),
        },
        { lastConnectionCheckAt: nowIso(), lastConnectionOk: false, lastError: message }
      );
      res.status(400).send(`<html lang="pt-BR"><body><h1>Falha na autorização</h1><p>${message}</p></body></html>`);
      return;
    }

    if (!codeParam) {
      res.status(400).send("<html lang=\"pt-BR\"><body><h1>Callback sem código OAuth</h1><p>O Conta Azul não retornou o parâmetro code.</p></body></html>");
      return;
    }
    if (contaAzulSettings.status.oauthState && stateParam !== contaAzulSettings.status.oauthState) {
      throw createHttpError(400, "O estado de segurança do OAuth do Conta Azul não confere.");
    }

    const tokenResult = await requestContaAzulToken({ contaAzulSettings, grantType: "authorization_code", code: codeParam });

    // Attempt account verification but do not block token persistence on failure.
    let connectedAccount = normalizeContaAzulConnectedAccount({});
    let accountEndpoint = contaAzulSettings.tokenUrl;
    let accountResponseCode = tokenResult.response.status;
    try {
      const accountResult = await fetchContaAzulConnectedAccount(tokenResult.nextSettings);
      connectedAccount = accountResult.connectedAccount;
      accountEndpoint = accountResult.endpoint;
      accountResponseCode = accountResult.response.status;
    } catch {
      // Non-fatal: token is saved regardless.
    }

    await persistContaAzulOAuthSuccess({
      currentSettings: contaAzulSettings,
      nextSettings: tokenResult.nextSettings,
      connectedAccount,
      kind: "oauth_authorize",
      endpoint: accountEndpoint,
      responseCode: accountResponseCode,
      summary: "Conta Azul autorizada com sucesso.",
    });

    res.send("<html lang=\"pt-BR\"><body><h1>Conta Azul conectada</h1><p>A autenticação foi concluída com sucesso. Pode fechar esta aba.</p></body></html>");
  })
);

async function syncLovableContractToContaAzul(source = {}, { dryRun = false, force = false } = {}) {
  const currentSettings = await getSettings();
  const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
  if (!contaAzulSettings.enabled || !contaAzulSettings.allowOutbound) {
    throw createHttpError(400, "Ative a integração Conta Azul antes de receber contratos do Lovable.");
  }

  const contractNumberFromSource = readFirstValue(source || {}, ["contractNumber", "number", "numero", "contract.contractNumber", "contract.termos.numero"]);
  const [nextContractNumber, financePaymentLinks] = await Promise.all([
    contractNumberFromSource || fetchContaAzulNextContractNumber(contaAzulSettings),
    listFinancePaymentLinks(),
  ]);
  const record = buildContaAzulContractRecord({
    settings: contaAzulSettings,
    source: source || {},
    nextContractNumber,
    financePaymentLinks,
  });
  if (!record.externalId) throw createHttpError(400, "Informe externalId, contractId ou id do contrato Lovable.");

  const existing = await findLovableContractSync(record.externalId);
  if (existing?.status === "success" && !force) {
    return { statusCode: 200, body: { ok: true, idempotent: true, contract: existing } };
  }

  if (record.missingRequiredFields.length) {
    await upsertLovableContractSync({
      externalId: record.externalId,
      amountCents: record.amountCents,
      status: "error",
      errorMessage: `Campos obrigatórios ausentes: ${record.missingRequiredFields.join(", ")}`,
      requestPayload: record.payload,
    });
    throw createHttpError(400, `Campos obrigatórios ausentes para criar contrato no Conta Azul: ${record.missingRequiredFields.join(", ")}.`);
  }

  if (dryRun) {
    return { statusCode: 200, body: { ok: true, dryRun: true, record } };
  }

  const startedAt = nowIso();
  const result = await postContaAzulJson(contaAzulSettings, record.endpointPath, record.payload);
  const contractResponse = normalizeContaAzulContractResponse(result.parsed.json);
  const errorMessage = result.response.ok ? null : result.parsed.preview || `HTTP ${result.response.status}`;
  const savedContract = await upsertLovableContractSync({
    externalId: record.externalId,
    amountCents: record.amountCents,
    contractNumber: record.payload?.termos?.numero,
    status: result.response.ok ? "success" : "error",
    contaAzulContractId: contractResponse.id,
    contaAzulSaleId: contractResponse.saleId,
    contaAzulLegacyId: contractResponse.legacyId,
    endpoint: result.endpoint,
    responseCode: result.response.status,
    responsePreview: result.parsed.preview,
    errorMessage,
    requestPayload: record.payload,
    responsePayload: result.parsed.json,
    syncedAt: result.response.ok ? nowIso() : null,
  });

  await recordContaAzulSync(
    {
      kind: "push",
      direction: "outbound",
      resource: CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE,
      status: result.response.ok ? "success" : "error",
      endpoint: result.endpoint,
      recordCount: result.response.ok ? 1 : 0,
      responseCode: result.response.status,
      summary: result.response.ok
        ? `Contrato Lovable ${record.externalId} criado no Conta Azul.`
        : `Falha ao criar contrato Lovable ${record.externalId} no Conta Azul.`,
      errorMessage,
      startedAt,
      finishedAt: nowIso(),
    },
    {
      lastPushAt: nowIso(),
      lastPushResource: CONTA_AZUL_LOVABLE_CONTRACTS_RESOURCE,
      lastPushStatus: result.response.ok ? "success" : "error",
      lastError: errorMessage,
    }
  );

  if (!result.response.ok) {
    return {
      statusCode: result.response.status === 401 ? 401 : 400,
      body: {
        ok: false,
        error: `Conta Azul recusou o contrato Lovable. ${errorMessage}`,
        contract: savedContract,
        responsePreview: result.parsed.preview,
      },
    };
  }

  return { statusCode: 201, body: { ok: true, contract: savedContract, contaAzul: contractResponse } };
}

async function syncLovableReceiptToContaAzul(source = {}, { dryRun = false, force = false } = {}) {
  const externalId = readFirstText(source || {}, ["externalId", "paymentId", "receiptId", "id", "payment.id", "receipt.id"]);
  if (!externalId) throw createHttpError(400, "Informe externalId, paymentId, receiptId ou id do recebimento Lovable.");

  const existing = await findLovableReceiptSync(externalId);
  if (existing?.status === "success" && !force) {
    return { statusCode: 200, body: { ok: true, idempotent: true, receipt: existing } };
  }

  const currentSettings = await getSettings();
  const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
  if (!contaAzulSettings.enabled || !contaAzulSettings.allowOutbound) {
    throw createHttpError(400, "Ative a integração Conta Azul antes de receber baixas do Lovable.");
  }

  const resolvedInstallment = await resolveContaAzulInstallmentForLovableReceipt(contaAzulSettings, source || {});
  const record = buildContaAzulAcquittanceRecord({
    settings: contaAzulSettings,
    source: source || {},
    installmentId: resolvedInstallment?.id,
  });

  if (record.missingRequiredFields.length) {
    await upsertLovableReceiptSync({
      externalId: record.externalId || externalId,
      externalContractId: readFirstText(source || {}, ["contractId", "externalContractId", "contract.id"]),
      amountCents: record.amountCents,
      paymentDate: record.paymentDate,
      status: "error",
      contaAzulInstallmentId: record.installmentId,
      errorMessage: `Campos obrigatórios ausentes: ${record.missingRequiredFields.join(", ")}`,
      requestPayload: record.payload,
    });
    throw createHttpError(400, `Campos obrigatórios ausentes para dar baixa no Conta Azul: ${record.missingRequiredFields.join(", ")}.`);
  }

  if (dryRun) {
    return { statusCode: 200, body: { ok: true, dryRun: true, resolvedInstallment, record } };
  }

  const startedAt = nowIso();
  const result = await postContaAzulJson(contaAzulSettings, record.endpointPath, record.payload);
  const acquittanceResponse = normalizeContaAzulAcquittanceResponse(result.parsed.json);
  const errorMessage = result.response.ok ? null : result.parsed.preview || `HTTP ${result.response.status}`;
  const savedReceipt = await upsertLovableReceiptSync({
    externalId: record.externalId || externalId,
    externalContractId: readFirstText(source || {}, ["contractId", "externalContractId", "contract.id"]),
    amountCents: record.amountCents,
    paymentDate: record.paymentDate,
    status: result.response.ok ? "success" : "error",
    contaAzulInstallmentId: record.installmentId,
    contaAzulAcquittanceId: acquittanceResponse.id,
    endpoint: result.endpoint,
    responseCode: result.response.status,
    responsePreview: result.parsed.preview,
    errorMessage,
    requestPayload: record.payload,
    responsePayload: result.parsed.json,
    syncedAt: result.response.ok ? nowIso() : null,
  });

  await recordContaAzulSync(
    {
      kind: "push",
      direction: "outbound",
      resource: CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE,
      status: result.response.ok ? "success" : "error",
      endpoint: result.endpoint,
      recordCount: result.response.ok ? 1 : 0,
      responseCode: result.response.status,
      summary: result.response.ok
        ? `Recebimento Lovable ${record.externalId} baixado no Conta Azul.`
        : `Falha ao baixar recebimento Lovable ${record.externalId} no Conta Azul.`,
      errorMessage,
      startedAt,
      finishedAt: nowIso(),
    },
    {
      lastPushAt: nowIso(),
      lastPushResource: CONTA_AZUL_LOVABLE_RECEIPTS_RESOURCE,
      lastPushStatus: result.response.ok ? "success" : "error",
      lastError: errorMessage,
    }
  );

  if (!result.response.ok) {
    return {
      statusCode: result.response.status === 401 ? 401 : 400,
      body: {
        ok: false,
        error: `Conta Azul recusou a baixa do Lovable. ${errorMessage}`,
        receipt: savedReceipt,
        responsePreview: result.parsed.preview,
      },
    };
  }

  return { statusCode: 201, body: { ok: true, receipt: savedReceipt, contaAzul: acquittanceResponse } };
}

function getBusinessDate(value = null) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.RECEIVABLES_TIMEZONE || "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function readCollectionPayload(source, keys) {
  if (Array.isArray(source)) return source;
  const safeSource = source && typeof source === "object" ? source : {};
  const collections = [];
  for (const key of keys) {
    const value = readNestedValue(safeSource, key);
    if (Array.isArray(value)) collections.push(...value);
  }
  return collections.length ? collections : null;
}

function extractFinanceResponseItems(body, keys) {
  const items = readCollectionPayload(body, keys);
  return Array.isArray(items) ? items : [];
}

function normalizeFinanceProduct(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const id = truncateText(String(o.id ?? o.product_id ?? o.productId ?? o.uuid ?? o.code ?? "").trim(), 120);
  const name = truncateText(String(o.name ?? o.title ?? o.nome ?? o.description ?? o.descricao ?? "").trim(), 200);
  const kind = truncateText(String(o.kind ?? o.type ?? o.tipo ?? o.category ?? "").trim(), 80);
  const label = [name || id || "Produto", kind || null].filter(Boolean).join(" · ");
  return {
    id: id || null,
    name: name || null,
    kind: kind || null,
    label: label || id || null,
  };
}

function readFinanceBearerToken() {
  return readFirstEnvValue(["COLLI_FINANCE_API_TOKEN", "FINANCE_API_TOKEN", "LOVABLE_API_TOKEN"]);
}

const FINANCE_RESOURCES = {
  contracts: {
    key: "contracts",
    title: "Contratos",
    resourceLabel: "contratos novos",
    envKeys: ["COLLI_FINANCE_CONTRACTS_URL", "FINANCE_CONTRACTS_URL"],
    bodyKeys: ["contracts", "newContracts", "data.contracts"],
    responseKeys: ["contracts", "newContracts", "data.contracts", "data", "items", "records"],
    queryForDate: (businessDate) => ({ businessDate, date: businessDate, status: "new" }),
  },
  billingCards: {
    key: "billingCards",
    title: "Cards de cobrança",
    resourceLabel: "cards de cobrança vencidos ou do dia",
    envKeys: ["COLLI_FINANCE_BILLING_CARDS_URL", "FINANCE_BILLING_CARDS_URL", "FINANCE_WALLET_ITEMS_URL"],
    bodyKeys: ["billingCards", "cards", "walletItems", "due_today", "overdue", "data.cards", "data.due_today", "data.overdue"],
    responseKeys: [
      "billingCards",
      "cards",
      "walletItems",
      "due_today",
      "overdue",
      "data.billingCards",
      "data.cards",
      "data.due_today",
      "data.overdue",
      "data",
      "items",
      "records",
    ],
    queryForDate: (businessDate) => ({ businessDate, dueTo: businessDate, overdue: "true", status: "pending" }),
  },
  payments: {
    key: "payments",
    title: "Pagamentos",
    resourceLabel: "pagamentos confirmados",
    envKeys: ["COLLI_FINANCE_PAYMENTS_URL", "FINANCE_PAYMENTS_URL", "FINANCE_RECEIPTS_URL"],
    bodyKeys: ["payments", "receipts", "paidCards", "data.payments"],
    responseKeys: ["payments", "receipts", "paidCards", "data.payments", "data.receipts", "data", "items", "records"],
    queryForDate: (businessDate) => ({ businessDate, paymentDate: businessDate, status: "paid" }),
  },
  products: {
    key: "products",
    title: "Produtos",
    resourceLabel: "produtos cadastrados no Finance",
    envKeys: ["COLLI_FINANCE_PRODUCTS_URL", "FINANCE_PRODUCTS_URL"],
    bodyKeys: ["products", "data.products", "produtos", "items"],
    responseKeys: ["products", "data.products", "produtos", "items", "records", "data", "results"],
    queryForDate: () => ({}),
  },
};

function buildFinanceUrl(rawUrl, params = {}) {
  const url = new URL(rawUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  return url;
}

function sanitizeFinanceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function describeFinanceJsonShape(json, responseKeys = []) {
  const items = extractFinanceResponseItems(json, responseKeys);
  const matchedKeys = responseKeys.filter((key) => Array.isArray(readNestedValue(json, key)));
  const firstItem = items.find((item) => item && typeof item === "object" && !Array.isArray(item)) || null;
  return {
    rootType: Array.isArray(json) ? "array" : typeof json,
    rootKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).slice(0, 16) : [],
    matchedKey: matchedKeys[0] || (Array.isArray(json) ? "root" : null),
    matchedKeys,
    itemCount: items.length,
    firstItemKeys: firstItem ? Object.keys(firstItem).slice(0, 24) : [],
  };
}

function readFinanceErrorMessage(json) {
  if (!json || typeof json !== "object") return "";
  return String(json.error || json.message || json.detail || json.details || "").trim().slice(0, 300);
}

function summarizeFinancePreviewItem(resource, item = {}) {
  if (!item || typeof item !== "object") return null;

  if (resource.key === "contracts") {
    const contractNumber = readFirstText(item, ["contract_number", "contractNumber", "id"], 120);
    const status = readFirstText(item, ["status"], 80);
    const firstChargeDate = readFirstText(item, ["first_charge_date", "firstDueDate", "contract_start_date"], 40);
    const paymentMethod = readFirstText(item, ["payment_method"], 60);
    const clientName = readFirstText(item, [
      "client_name",
      "clientName",
      "billing_clients.nome",
      "billing_clients.name",
      "billing_clients.razao_social",
      "billing_client.nome",
      "billing_client.name",
      "billing_client.razao_social",
      "client.nome",
      "client.name",
      "client.razao_social",
      "company_name",
      "companyName",
      "seller_name",
      "product_description",
    ], 120);
    const clientDocument = readFirstText(item, [
      "cnpj",
      "cpf_cnpj",
      "documento",
      "document",
      "billing_clients.cnpj_cpf",
      "billing_clients.cnpj",
      "billing_clients.documento",
      "billing_client.cnpj_cpf",
      "billing_client.cnpj",
      "billing_client.documento",
      "client.cnpj_cpf",
      "client.cnpj",
      "client.documento",
    ], 60);
    return {
      primary: contractNumber || "Contrato sem identificador",
      secondary: [
        clientName,
        status,
      ].filter(Boolean).join(" · "),
      tertiary: [
        clientDocument,
        firstChargeDate,
        paymentMethod,
      ].filter(Boolean).join(" · "),
      contractNumber,
      status,
      firstChargeDate,
      paymentMethod,
      clientName,
      clientDocument,
    };
  }

  if (resource.key === "billingCards") {
    const cardId = readFirstText(item, ["card_id", "cardId", "id", "contract_number"], 120);
    const status = readFirstText(item, ["status"], 80);
    const dueDate = readFirstText(item, ["due_date", "dueDate", "date"], 40);
    const paymentMethod = readFirstText(item, ["payment_method"], 60);
    const clientName = readFirstText(item, [
      "client_name",
      "clientName",
      "billing_clients.nome",
      "billing_clients.name",
      "billing_clients.razao_social",
      "billing_client.nome",
      "billing_client.name",
      "billing_client.razao_social",
      "client.nome",
      "client.name",
      "client.razao_social",
      "company_name",
      "companyName",
      "seller_name",
    ], 120);
    const clientDocument = readFirstText(item, [
      "cnpj",
      "cpf_cnpj",
      "documento",
      "document",
      "billing_clients.cnpj_cpf",
      "billing_clients.cnpj",
      "billing_clients.documento",
      "billing_client.cnpj_cpf",
      "billing_client.cnpj",
      "billing_client.documento",
      "client.cnpj_cpf",
      "client.cnpj",
      "client.documento",
    ], 60);
    return {
      primary: cardId || "Card sem identificador",
      secondary: [
        clientName,
        status,
      ].filter(Boolean).join(" · "),
      tertiary: [
        clientDocument,
        dueDate,
        paymentMethod,
      ].filter(Boolean).join(" · "),
      cardId,
      status,
      dueDate,
      paymentMethod,
      clientName,
      clientDocument,
    };
  }

  if (resource.key === "payments") {
    return {
      primary: readFirstText(item, ["wallet_item_id", "walletItemId", "id", "reference"], 120) || "Pagamento sem identificador",
      secondary: [
        readFirstText(item, ["payment_method"], 60),
        readFirstText(item, ["payment_date", "paymentDate", "created_at"], 40),
      ].filter(Boolean).join(" · "),
      tertiary: readFirstText(item, ["notes", "reference"], 160) || "",
    };
  }

  return {
    primary: readFirstText(item, ["id", "name"], 120) || "Registro",
    secondary: "",
    tertiary: "",
  };
}

function buildFinancePreviewItems(resource, items = [], limit = 5) {
  return items
    .slice(0, limit)
    .map((item) => summarizeFinancePreviewItem(resource, item))
    .filter(Boolean);
}

async function fetchFinanceCollection({ body, bodyKeys, envKeys, responseKeys, query = {}, resourceLabel }) {
  const manualItems = readCollectionPayload(body, bodyKeys);
  if (Array.isArray(manualItems)) {
    return {
      configured: true,
      source: "manual",
      items: manualItems,
      message: `${manualItems.length} registro(s) recebido(s) manualmente para ${resourceLabel}.`,
    };
  }

  const envEntry = readFirstEnvEntry(envKeys);
  if (!envEntry.value) {
    return {
      configured: false,
      configuredEnvKey: null,
      expectedEnvKey: envKeys[0],
      source: "not_configured",
      items: [],
      message: `Configure ${envKeys[0]} para o FP&A puxar ${resourceLabel} automaticamente do Colli Finance.`,
    };
  }

  const url = buildFinanceUrl(envEntry.value, query);
  const headers = { accept: "application/json" };
  const token = readFinanceBearerToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(response.status, `Colli Finance recusou a busca de ${resourceLabel}. ${json.error || json.message || `HTTP ${response.status}`}`);
  }

  const items = extractFinanceResponseItems(json, responseKeys);
  return {
    configured: true,
    configuredEnvKey: envEntry.key,
    expectedEnvKey: envKeys[0],
    source: sanitizeFinanceUrl(envEntry.value) || envEntry.key,
    items,
    message: `${items.length} registro(s) puxado(s) do Colli Finance para ${resourceLabel}.`,
  };
}

async function diagnoseFinanceResource(resource, businessDate) {
  const envEntry = readFirstEnvEntry(resource.envKeys);
  const expectedEnvKey = resource.envKeys[0];
  const query = resource.queryForDate(businessDate);
  const base = {
    key: resource.key,
    title: resource.title,
    resourceLabel: resource.resourceLabel,
    expectedEnvKey,
    configuredEnvKey: envEntry.value ? envEntry.key : null,
    configured: Boolean(envEntry.value),
    sanitizedUrl: envEntry.value ? sanitizeFinanceUrl(envEntry.value) : "",
    query,
  };

  if (!envEntry.value) {
    return {
      ...base,
      ok: false,
      status: "missing_config",
      message: `Configure ${expectedEnvKey} no serviço principal do Render para ler ${resource.resourceLabel}.`,
    };
  }

  let url;
  try {
    url = buildFinanceUrl(envEntry.value, query);
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: "invalid_url",
      message: `A variável ${envEntry.key} não contém uma URL válida: ${error.message}`,
    };
  }

  const headers = { accept: "application/json" };
  const token = readFinanceBearerToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const startedAt = Date.now();
  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = null;
    }

    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ...base,
        ok: false,
        status: "http_error",
        httpStatus: response.status,
        durationMs,
        message: `O Colli Finance respondeu HTTP ${response.status}${readFinanceErrorMessage(json) ? `: ${readFinanceErrorMessage(json)}` : "."}`,
      };
    }

    if (!json || typeof json !== "object") {
      return {
        ...base,
        ok: false,
        status: "invalid_json",
        httpStatus: response.status,
        durationMs,
        message: "O endpoint respondeu, mas não retornou JSON válido.",
      };
    }

    const items = extractFinanceResponseItems(json, resource.responseKeys);
    const shape = describeFinanceJsonShape(json, resource.responseKeys);
    return {
      ...base,
      ok: true,
      status: "success",
      httpStatus: response.status,
      durationMs,
      itemCount: items.length,
      detectedKey: shape.matchedKey,
      shape,
      previewItems: buildFinancePreviewItems(resource, items),
      message: `${items.length} registro(s) encontrado(s) em ${resource.resourceLabel}.`,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: "request_error",
      message: `Não foi possível chamar o endpoint do Finance: ${error.message}`,
    };
  }
}

async function buildFinanceDiagnostics(businessDate = getBusinessDate()) {
  const resources = await Promise.all(Object.values(FINANCE_RESOURCES).map((resource) => diagnoseFinanceResource(resource, businessDate)));
  return {
    businessDate,
    hasFinanceToken: Boolean(readFinanceBearerToken()),
    checkedAt: nowIso(),
    resources,
  };
}

function getCobrancaServiceBaseUrl() {
  return resolveProxyBaseUrl({
    internalEnvKeys: ["COBRANCAS_INTERNAL_URL", "BOT_COBRANCA_INTERNAL_URL"],
    externalEnvKeys: ["COBRANCAS_URL", "BOT_COBRANCA_URL"],
    defaultExternalUrl: DEFAULT_COBRANCAS_URL,
  });
}

function buildServiceJsonHeaders() {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const authorization = buildInternalModuleAuthorizationHeader();
  if (authorization) headers.authorization = authorization;
  return headers;
}

function buildCobrancaUrl(pathname, params = {}) {
  const baseUrl = getCobrancaServiceBaseUrl();
  if (!baseUrl) throw createHttpError(503, "Bot de cobrança não configurado.");
  const url = new URL(pathname, `${baseUrl}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  });
  return url;
}

async function requestCobrancaJson(pathname, { method = "GET", params = {}, body = null } = {}) {
  const maxAttempts = method === "GET" ? 2 : 3;
  const retryableStatuses = new Set([502, 503, 504]);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(buildCobrancaUrl(pathname, params), {
      method,
      headers: buildServiceJsonHeaders(),
      body: body == null ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok) return json;

    lastError = createHttpError(response.status, json.error || json.message || `Bot de cobrança respondeu HTTP ${response.status}.`);
    if (!retryableStatuses.has(response.status) || attempt === maxAttempts) {
      throw lastError;
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 600));
  }

  throw lastError || createHttpError(502, "Bot de cobrança indisponível.");
}

function extractFinanceExternalId(item = {}) {
  return readFirstText(item, [
    "externalId",
    "cardId",
    "card_id",
    "walletItemId",
    "wallet_item_id",
    "billingCardId",
    "billing_card_id",
    "id",
    "data.externalId",
    "data.cardId",
    "data.card_id",
    "data.id",
    "payment.cardId",
    "receipt.cardId",
  ]);
}

function extractPaymentExternalId(payment = {}) {
  return readFirstText(payment, [
    "cardId",
    "card_id",
    "walletItemId",
    "wallet_item_id",
    "billingCardId",
    "billing_card_id",
    "externalContractId",
    "contractId",
    "invoiceExternalId",
    "payment.cardId",
    "receipt.cardId",
    "payment.contractId",
    "receipt.contractId",
  ]);
}

function pickSendableInvoices(invoices, businessDate) {
  return (Array.isArray(invoices) ? invoices : [])
    .filter((invoice) => ["pending", "failed"].includes(String(invoice.status || "pending")))
    .filter((invoice) => String(invoice.dueDate || "") <= businessDate)
    .filter((invoice) => String(invoice.paymentLink || "").trim())
    .map((invoice) => invoice.id)
    .filter(Boolean);
}

function trimReceivablesPayloadItems(items, limit = 500) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

async function saveReceivablesRun(run, patch = {}) {
  return upsertReceivablesOrchestratorRun({
    ...run,
    ...patch,
    updatedAt: nowIso(),
  });
}

async function appendReceivablesStep(run, step) {
  const nextStep = {
    key: step.key,
    title: step.title,
    status: step.status || "success",
    summary: step.summary || "",
    details: step.details || null,
    at: nowIso(),
  };
  return saveReceivablesRun(run, {
    steps: [...(run.steps || []), nextStep].slice(-80),
  });
}

async function createReceivablesRun({ businessDate, title = "Ciclo diário de contas a receber" } = {}) {
  const startedAt = nowIso();
  return upsertReceivablesOrchestratorRun({
    businessDate: getBusinessDate(businessDate),
    status: "running",
    phase: "starting",
    title,
    summary: {
      contractsPulled: 0,
      contractsSynced: 0,
      billingCardsPulled: 0,
      invoicesCreated: 0,
      invoicesUpdated: 0,
      missingPaymentLinks: 0,
      invoicesQueuedToSend: 0,
      paymentsPulled: 0,
      paymentsSynced: 0,
    },
    steps: [],
    missingPaymentLinks: [],
    invoicesToSend: [],
    financePayload: {},
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
}

async function syncContractsForReceivablesRun(run, contracts) {
  const summary = { total: contracts.length, success: 0, idempotent: 0, failed: 0, errors: [], results: [] };
  for (const contract of contracts) {
    const externalId = readFirstText(contract, ["externalId", "contractId", "id"]);
    const contractNumber = readFirstText(contract, ["contractNumber", "contract_number", "number", "numero"]);
    try {
      const result = await syncLovableContractToContaAzul(contract, { force: false });
      if (result.body?.idempotent) {
        summary.idempotent += 1;
        summary.results.push({
          externalId,
          contractNumber: result.body?.contract?.contractNumber || contractNumber || null,
          status: "idempotent",
          contaAzulContractId: result.body?.contract?.contaAzulContractId || result.body?.contract?.id || null,
        });
      } else if (result.body?.ok) {
        summary.success += 1;
        summary.results.push({
          externalId,
          contractNumber: result.body?.contract?.contractNumber || contractNumber || null,
          status: "success",
          contaAzulContractId: result.body?.contract?.contaAzulContractId || result.body?.contract?.id || null,
        });
      } else {
        summary.failed += 1;
        summary.results.push({
          externalId,
          contractNumber,
          status: "failed",
          error: result.body?.error || "Falha ao cadastrar contrato no Conta Azul.",
        });
      }
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({
        externalId,
        error: error?.message || "Falha ao cadastrar contrato no Conta Azul.",
      });
      summary.results.push({
        externalId,
        contractNumber,
        status: "failed",
        error: error?.message || "Falha ao cadastrar contrato no Conta Azul.",
      });
    }
  }
  return saveReceivablesRun(run, {
    summary: {
      ...(run.summary || {}),
      contractsPulled: contracts.length,
      contractsSynced: summary.success + summary.idempotent,
      contractSyncFailures: summary.failed,
    },
  }).then((saved) => appendReceivablesStep(saved, {
    key: "contracts_to_conta_azul",
    title: "Contratos no Conta Azul",
    status: summary.failed ? "warning" : "success",
    summary: `${summary.success + summary.idempotent}/${summary.total} contrato(s) sincronizado(s).`,
    details: summary,
  }));
}

async function syncBillingCardsWithCobranca(run, billingCards) {
  if (!billingCards.length) {
    return appendReceivablesStep(run, {
      key: "billing_cards_to_cobranca",
      title: "Cards de cobrança",
      status: "success",
      summary: "Nenhum card novo recebido para criar cobranças.",
    });
  }

  const batchSize = Math.max(1, Math.trunc(Number(process.env.RECEIVABLES_BILLING_BATCH_SIZE) || 20));
  const batches = [];
  for (let index = 0; index < billingCards.length; index += batchSize) {
    batches.push(billingCards.slice(index, index + batchSize));
  }

  const aggregate = {
    total: billingCards.length,
    processed: 0,
    created: 0,
    updated: 0,
    ignored: 0,
    failed: 0,
    results: [],
    errors: [],
    batches: [],
  };

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    try {
      const result = await requestCobrancaJson("/api/orchestrator/wallet-items", {
        method: "POST",
        body: { items: batch },
      });
      aggregate.processed += result.processed || 0;
      aggregate.created += result.created || 0;
      aggregate.updated += result.updated || 0;
      aggregate.ignored += result.ignored || 0;
      aggregate.failed += result.failed || 0;
      aggregate.results.push(...(Array.isArray(result.results) ? result.results : []));
      aggregate.errors.push(...(Array.isArray(result.errors) ? result.errors : []));
      aggregate.batches.push({
        index: index + 1,
        total: batches.length,
        size: batch.length,
        created: result.created || 0,
        updated: result.updated || 0,
        ignored: result.ignored || 0,
        failed: result.failed || 0,
        ok: result.failed === 0,
      });
    } catch (error) {
      aggregate.failed += batch.length;
      aggregate.errors.push({
        batch: index + 1,
        batchSize: batch.length,
        cardIds: batch.map((item) => extractFinanceExternalId(item)).filter(Boolean),
        error: error?.message || "Falha ao sincronizar lote de cobranças com o bot.",
      });
      aggregate.batches.push({
        index: index + 1,
        total: batches.length,
        size: batch.length,
        created: 0,
        updated: 0,
        ignored: 0,
        failed: batch.length,
        ok: false,
        error: error?.message || "Falha ao sincronizar lote de cobranças com o bot.",
      });
    }
  }

  return saveReceivablesRun(run, {
    summary: {
      ...(run.summary || {}),
      billingCardsPulled: billingCards.length,
      invoicesCreated: aggregate.created || 0,
      invoicesUpdated: aggregate.updated || 0,
      invoiceSyncFailures: aggregate.failed || 0,
    },
  }).then((saved) => appendReceivablesStep(saved, {
    key: "billing_cards_to_cobranca",
    title: "Cobranças no bot",
    status: aggregate.failed ? "warning" : "success",
    summary: `${aggregate.created || 0} criada(s), ${aggregate.updated || 0} atualizada(s), ${aggregate.ignored || 0} ignorada(s).`,
    details: aggregate,
  }));
}

async function auditAndMaybeSendReceivables(run, { cardIds, startSending = true } = {}) {
  const uniqueCardIds = Array.from(new Set((cardIds || []).filter(Boolean)));
  const audit = await requestCobrancaJson("/api/orchestrator/payment-link-audit", {
    params: { dueTo: run.businessDate, cardIds: uniqueCardIds },
  });
  const invoicesResult = await requestCobrancaJson("/api/orchestrator/invoices", {
    params: { dueTo: run.businessDate, cardIds: uniqueCardIds },
  });
  const invoiceIds = pickSendableInvoices(invoicesResult.invoices, run.businessDate);

  run = await saveReceivablesRun(run, {
    missingPaymentLinks: audit.missingPaymentLinks || [],
    invoicesToSend: invoiceIds,
    summary: {
      ...(run.summary || {}),
      missingPaymentLinks: audit.missingCount || 0,
      invoicesQueuedToSend: invoiceIds.length,
    },
  });

  if (audit.missingCount) {
    return appendReceivablesStep(run, {
      key: "payment_link_audit",
      title: "Links de pagamento",
      status: "waiting",
      summary: `${audit.missingCount} cobrança(s) sem link de pagamento. Inclua manualmente e retome o ciclo.`,
      details: audit,
    }).then((saved) => saveReceivablesRun(saved, {
      status: "waiting_payment_links",
      phase: "waiting_payment_links",
    }));
  }

  run = await appendReceivablesStep(run, {
    key: "payment_link_audit",
    title: "Links de pagamento",
    status: "success",
    summary: "Todas as cobranças elegíveis têm link de pagamento.",
    details: audit,
  });

  if (!startSending || !invoiceIds.length) {
    return saveReceivablesRun(run, {
      status: "completed",
      phase: "no_charges_to_send",
      finishedAt: nowIso(),
    });
  }

  const batch = await requestCobrancaJson("/api/invoices/send-batch", {
    method: "POST",
    body: {
      invoiceIds,
      delayMs: Number(process.env.RECEIVABLES_SEND_DELAY_MS || 15000),
    },
  });

  return appendReceivablesStep(run, {
    key: "send_charges",
    title: "Envio de cobranças",
    status: batch.started ? "running" : "success",
    summary: batch.message || `${invoiceIds.length} cobrança(s) encaminhada(s) ao bot de cobrança.`,
    details: batch,
  }).then((saved) => saveReceivablesRun(saved, {
    status: batch.started ? "billing_started" : "completed",
    phase: batch.started ? "monitoring_charges" : "no_charges_to_send",
    batchSend: batch.batchSend || null,
    finishedAt: batch.started ? null : nowIso(),
  }));
}

async function runReceivablesOrchestrator({ businessDate, body = {}, startSending = true } = {}) {
  let run = await createReceivablesRun({ businessDate });
  try {
    run = await appendReceivablesStep(run, {
      key: "start",
      title: "Início do ciclo",
      status: "running",
      summary: `Ciclo iniciado para ${run.businessDate}.`,
    });

    const missingFinanceResources = [];
    const contractsResource = FINANCE_RESOURCES.contracts;
    const contractsPull = await fetchFinanceCollection({
      body,
      bodyKeys: contractsResource.bodyKeys,
      envKeys: contractsResource.envKeys,
      responseKeys: contractsResource.responseKeys,
      query: contractsResource.queryForDate(run.businessDate),
      resourceLabel: contractsResource.resourceLabel,
    });
    run = await saveReceivablesRun(run, {
      financePayload: {
        ...(run.financePayload || {}),
        contracts: trimReceivablesPayloadItems(contractsPull.items),
      },
    });
    run = await appendReceivablesStep(run, {
      key: "pull_contracts",
      title: "Buscar contratos no Finance",
      status: contractsPull.configured ? "success" : "warning",
      summary: contractsPull.message,
      details: { source: contractsPull.source, count: contractsPull.items.length, envKey: contractsPull.configuredEnvKey || contractsPull.expectedEnvKey },
    });
    if (contractsPull.configured) {
      run = await syncContractsForReceivablesRun(run, contractsPull.items);
    } else {
      missingFinanceResources.push({
        key: contractsResource.key,
        title: contractsResource.title,
        expectedEnvKey: contractsPull.expectedEnvKey,
        message: contractsPull.message,
      });
    }

    const cardsResource = FINANCE_RESOURCES.billingCards;
    const cardsPull = await fetchFinanceCollection({
      body,
      bodyKeys: cardsResource.bodyKeys,
      envKeys: cardsResource.envKeys,
      responseKeys: cardsResource.responseKeys,
      query: cardsResource.queryForDate(run.businessDate),
      resourceLabel: cardsResource.resourceLabel,
    });
    run = await saveReceivablesRun(run, {
      financePayload: {
        ...(run.financePayload || {}),
        billingCards: trimReceivablesPayloadItems(cardsPull.items),
      },
    });
    run = await appendReceivablesStep(run, {
      key: "pull_billing_cards",
      title: "Buscar cards de cobrança",
      status: cardsPull.configured ? "success" : "warning",
      summary: cardsPull.message,
      details: { source: cardsPull.source, count: cardsPull.items.length, envKey: cardsPull.configuredEnvKey || cardsPull.expectedEnvKey },
    });
    if (cardsPull.configured) {
      run = await syncBillingCardsWithCobranca(run, cardsPull.items);
    } else {
      missingFinanceResources.push({
        key: cardsResource.key,
        title: cardsResource.title,
        expectedEnvKey: cardsPull.expectedEnvKey,
        message: cardsPull.message,
      });
    }

    if (missingFinanceResources.length) {
      const missingNames = missingFinanceResources.map((item) => item.expectedEnvKey).join(", ");
      run = await appendReceivablesStep(run, {
        key: "finance_connection",
        title: "Conexão com Finance",
        status: "warning",
        summary: `Configure ${missingNames} no Render antes de concluir o ciclo diário.`,
        details: { missingResources: missingFinanceResources },
      });
      return saveReceivablesRun(run, {
        status: "waiting_finance_connection",
        phase: "waiting_finance_connection",
        lastError: `Conexão com Colli Finance pendente: ${missingNames}.`,
        financePayload: {
          ...(run.financePayload || {}),
          missingResources: missingFinanceResources,
        },
        summary: {
          ...(run.summary || {}),
          missingFinanceConnections: missingFinanceResources.length,
        },
        finishedAt: null,
      });
    }

    const cardIds = cardsPull.items.map(extractFinanceExternalId).filter(Boolean);
    run = await auditAndMaybeSendReceivables(run, { cardIds, startSending });
    return run;
  } catch (error) {
    return saveReceivablesRun(run, {
      status: "failed",
      phase: "failed",
      lastError: error?.message || "Falha no orquestrador de contas a receber.",
      finishedAt: nowIso(),
    });
  }
}

async function refreshReceivablesMonitoring(run) {
  if (!run) return null;
  const [batchSend, messages] = await Promise.all([
    requestCobrancaJson("/api/invoices/send-batch/status").catch((error) => ({ status: "unavailable", error: error.message })),
    requestCobrancaJson("/api/messages", { params: { limit: 80 } }).catch(() => []),
  ]);
  return saveReceivablesRun(run, {
    batchSend,
    summary: {
      ...(run.summary || {}),
      inboundMessagesTracked: Array.isArray(messages) ? messages.filter((message) => message.direction === "in").length : 0,
    },
  });
}

async function closeReceivablesDay({ businessDate, body = {} } = {}) {
  let run = (await getLatestReceivablesOrchestratorRun()) || (await createReceivablesRun({ businessDate, title: "Fechamento de pagamentos" }));
  run = await saveReceivablesRun(run, {
    businessDate: getBusinessDate(businessDate || run.businessDate),
    status: "running",
    phase: "closing_day",
    finishedAt: null,
  });

  try {
    const paymentsResource = FINANCE_RESOURCES.payments;
    const paymentsPull = await fetchFinanceCollection({
      body,
      bodyKeys: paymentsResource.bodyKeys,
      envKeys: paymentsResource.envKeys,
      responseKeys: paymentsResource.responseKeys,
      query: paymentsResource.queryForDate(run.businessDate),
      resourceLabel: paymentsResource.resourceLabel,
    });
    run = await saveReceivablesRun(run, {
      financePayload: {
        ...(run.financePayload || {}),
        payments: trimReceivablesPayloadItems(paymentsPull.items),
      },
    });
    run = await appendReceivablesStep(run, {
      key: "pull_payments",
      title: "Atualizar pagamentos",
      status: paymentsPull.configured ? "success" : "warning",
      summary: paymentsPull.message,
      details: { source: paymentsPull.source, count: paymentsPull.items.length, envKey: paymentsPull.configuredEnvKey || paymentsPull.expectedEnvKey },
    });

    if (!paymentsPull.configured) {
      return saveReceivablesRun(run, {
        status: "waiting_finance_connection",
        phase: "waiting_finance_connection",
        lastError: `Conexão com Colli Finance pendente: ${paymentsPull.expectedEnvKey}.`,
        financePayload: {
          ...(run.financePayload || {}),
          missingResources: [{
            key: paymentsResource.key,
            title: paymentsResource.title,
            expectedEnvKey: paymentsPull.expectedEnvKey,
            message: paymentsPull.message,
          }],
        },
        summary: {
          ...(run.summary || {}),
          missingFinanceConnections: 1,
        },
        finishedAt: null,
      });
    }

    const externalIds = paymentsPull.items.map(extractPaymentExternalId).filter(Boolean);
    const invoicesResult = externalIds.length
      ? await requestCobrancaJson("/api/orchestrator/invoices", { params: { cardIds: externalIds } })
      : { invoices: [] };
    const invoicesByExternalId = new Map((invoicesResult.invoices || []).map((invoice) => [invoice.integration?.externalId, invoice]));
    const summary = { total: paymentsPull.items.length, markedPaid: 0, contaAzulSynced: 0, failed: 0, errors: [] };

    for (const payment of paymentsPull.items) {
      const externalId = extractPaymentExternalId(payment);
      const invoice = externalId ? invoicesByExternalId.get(externalId) : null;
      try {
        if (invoice && invoice.status !== "paid") {
          await requestCobrancaJson(`/api/invoices/${encodeURIComponent(invoice.id)}/mark-paid`, { method: "POST", body: {} });
          summary.markedPaid += 1;
        }
        const receiptPayload = {
          ...payment,
          externalId: readFirstText(payment, ["externalId", "paymentId", "receiptId", "id"]) || `payment_${externalId || Date.now()}`,
          externalContractId: readFirstText(payment, ["externalContractId", "contractId"]) || externalId,
          amountCents: readFirstValue(payment, ["amountCents", "paidAmountCents", "valueCents"]) || invoice?.valueCents,
          paymentDate: readFirstText(payment, ["paymentDate", "paidAt", "dataPagamento", "data_pagamento"], 10) || run.businessDate,
        };
        const result = await syncLovableReceiptToContaAzul(receiptPayload, { force: false });
        if (result.body?.ok) summary.contaAzulSynced += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ externalId, error: error?.message || "Falha ao baixar pagamento." });
      }
    }

    run = await appendReceivablesStep(run, {
      key: "payments_to_conta_azul",
      title: "Baixas no Conta Azul",
      status: summary.failed ? "warning" : "success",
      summary: `${summary.markedPaid} cobrança(s) marcada(s) como paga(s); ${summary.contaAzulSynced} baixa(s) enviada(s) ao Conta Azul.`,
      details: summary,
    });

    return saveReceivablesRun(run, {
      status: summary.failed ? "completed_with_warnings" : "completed",
      phase: "day_closed",
      summary: {
        ...(run.summary || {}),
        paymentsPulled: paymentsPull.items.length,
        paymentsMarkedPaid: summary.markedPaid,
        paymentsSynced: summary.contaAzulSynced,
        paymentSyncFailures: summary.failed,
      },
      finishedAt: nowIso(),
    });
  } catch (error) {
    return saveReceivablesRun(run, {
      status: "failed",
      phase: "closing_failed",
      lastError: error?.message || "Falha no fechamento de pagamentos.",
      finishedAt: nowIso(),
    });
  }
}

app.post(
  "/api/integrations/lovable/contracts",
  requireLovableWebhookAuth,
  asyncHandler(async (req, res) => {
    const dryRun = req.body?.dryRun === true || req.query?.dryRun === "true";
    const force = req.body?.force === true || req.query?.force === "true";
    const result = await syncLovableContractToContaAzul(req.body || {}, { dryRun, force });
    res.status(result.statusCode).json(result.body);
  })
);

app.post(
  "/api/integrations/lovable/receipts",
  requireLovableWebhookAuth,
  asyncHandler(async (req, res) => {
    const dryRun = req.body?.dryRun === true || req.query?.dryRun === "true";
    const force = req.body?.force === true || req.query?.force === "true";
    const result = await syncLovableReceiptToContaAzul(req.body || {}, { dryRun, force });
    res.status(result.statusCode).json(result.body);
  })
);

const adminAuthMiddleware = createBasicAuthMiddleware({
  ...getAdminCredentialsFromEnv(),
  realm: "Analista FP&A",
});
app.use(adminAuthMiddleware);

function sendHomePage(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(HOME_INDEX);
}

function sendAppPage(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(FPA_INDEX);
}

function sendReceivablesAnalysisPage(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(RECEIVABLES_ANALYSIS_INDEX);
}

function sendContaAzulVinculosPage(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(CONTA_AZUL_VINCULOS_INDEX);
}
app.get("/", sendHomePage);
app.get("/fpa", sendAppPage);
app.get("/fpa/receivables-analysis", sendReceivablesAnalysisPage);
app.get("/fpa/conta-azul-vinculos", sendContaAzulVinculosPage);
app.use("/cobrancas", asyncHandler(proxyCobrancasModule));
app.use("/extrator", asyncHandler(proxyExtratorModule));

app.get(
  "/api/settings",
  asyncHandler(async (req, res) => {
    res.json(sanitizeSettingsForClient(await getSettings()));
  })
);

app.get(
  "/api/integrations/lovable/syncs",
  asyncHandler(async (req, res) => {
    const limit = readLargeLimit(req.query?.limit, 100);
    const [contracts, receipts] = await Promise.all([
      listLovableContractSyncs({ limit }),
      listLovableReceiptSyncs({ limit }),
    ]);
    res.json({ ok: true, contracts, receipts });
  })
);

app.get(
  "/api/fpa/finance-payment-links",
  asyncHandler(async (req, res) => {
    const links = await listFinancePaymentLinks();
    res.json({ ok: true, links });
  })
);

app.post(
  "/api/fpa/finance-payment-links",
  asyncHandler(async (req, res) => {
    const link = await upsertFinancePaymentLink(req.body || {});
    res.status(201).json({ ok: true, link });
  })
);

app.delete(
  "/api/fpa/finance-payment-links/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteFinancePaymentLink(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: "Vínculo não encontrado." });
    res.json({ ok: true });
  })
);

app.get(
  "/api/fpa/finance-payment-links/lookup",
  asyncHandler(async (req, res) => {
    const method = String(req.query?.paymentMethod || "").trim();
    const category = String(req.query?.category || "").trim();
    const [linkByMethod, linkByCategory] = await Promise.all([
      method ? findFinancePaymentLinkByMethod(method) : null,
      category ? findFinancePaymentLinkByCategory(category) : null,
    ]);
    res.json({ ok: true, linkByMethod, linkByCategory });
  })
);

app.get(
  "/api/fpa/receivables-orchestrator",
  asyncHandler(async (req, res) => {
    const [latestRun, runs] = await Promise.all([
      getLatestReceivablesOrchestratorRun(),
      listReceivablesOrchestratorRuns({ limit: readLargeLimit(req.query?.limit, 10) }),
    ]);
    res.json({
      ok: true,
      latestRun,
      runs,
      config: {
        businessDate: getBusinessDate(),
        hasContractsPullUrl: Boolean(readFirstEnvValue(FINANCE_RESOURCES.contracts.envKeys)),
        hasBillingCardsPullUrl: Boolean(readFirstEnvValue(FINANCE_RESOURCES.billingCards.envKeys)),
        hasPaymentsPullUrl: Boolean(readFirstEnvValue(FINANCE_RESOURCES.payments.envKeys)),
        hasFinanceToken: Boolean(readFinanceBearerToken()),
        cobrancaUrl: getCobrancaServiceBaseUrl(),
        requiredFinanceEnvVars: Object.values(FINANCE_RESOURCES).map((resource) => ({
          key: resource.key,
          title: resource.title,
          envKey: resource.envKeys[0],
          configured: Boolean(readFirstEnvValue(resource.envKeys)),
        })),
      },
    });
  })
);

app.get(
  "/api/fpa/receivables-orchestrator/finance-diagnostics",
  asyncHandler(async (req, res) => {
    const businessDate = getBusinessDate(req.query?.businessDate);
    const diagnostics = await buildFinanceDiagnostics(businessDate);
    res.json({ ok: diagnostics.resources.every((resource) => resource.ok), diagnostics });
  })
);

app.post(
  "/api/fpa/receivables-orchestrator/run",
  asyncHandler(async (req, res) => {
    if (receivablesOrchestratorPromise) {
      throw createHttpError(409, "Já existe um ciclo de contas a receber em execução.");
    }

    receivablesOrchestratorPromise = runReceivablesOrchestrator({
      businessDate: req.body?.businessDate,
      body: req.body || {},
      startSending: req.body?.startSending !== false,
    }).finally(() => {
      receivablesOrchestratorPromise = null;
    });
    const run = await receivablesOrchestratorPromise;
    res.json({ ok: run.status !== "failed", run });
  })
);

app.post(
  "/api/fpa/receivables-orchestrator/resume",
  asyncHandler(async (req, res) => {
    const run = await getLatestReceivablesOrchestratorRun();
    if (!run) throw createHttpError(404, "Nenhum ciclo de contas a receber encontrado.");
    if (receivablesOrchestratorPromise) throw createHttpError(409, "Já existe um ciclo de contas a receber em execução.");

    receivablesOrchestratorPromise = auditAndMaybeSendReceivables(run, {
      cardIds: Array.isArray(req.body?.cardIds) ? req.body.cardIds : [],
      startSending: req.body?.startSending !== false,
    }).finally(() => {
      receivablesOrchestratorPromise = null;
    });
    const updatedRun = await receivablesOrchestratorPromise;
    res.json({ ok: true, run: updatedRun });
  })
);

app.post(
  "/api/fpa/receivables-orchestrator/refresh",
  asyncHandler(async (req, res) => {
    const run = await getLatestReceivablesOrchestratorRun();
    if (!run) throw createHttpError(404, "Nenhum ciclo de contas a receber encontrado.");
    const updatedRun = await refreshReceivablesMonitoring(run);
    res.json({ ok: true, run: updatedRun });
  })
);

app.post(
  "/api/fpa/receivables-orchestrator/close-day",
  asyncHandler(async (req, res) => {
    if (receivablesOrchestratorPromise) {
      throw createHttpError(409, "Já existe um ciclo de contas a receber em execução.");
    }

    receivablesOrchestratorPromise = closeReceivablesDay({
      businessDate: req.body?.businessDate,
      body: req.body || {},
    }).finally(() => {
      receivablesOrchestratorPromise = null;
    });
    const run = await receivablesOrchestratorPromise;
    res.json({ ok: run.status !== "failed", run });
  })
);

app.post(
  "/api/integrations/lovable/settings",
  asyncHandler(async (req, res) => {
    const lovablePatch = req.body?.lovable && typeof req.body.lovable === "object" ? req.body.lovable : req.body || {};
    const settings = await updateSettings({
      lovable: {
        enabled: lovablePatch.enabled,
        webhookSecret: lovablePatch.webhookSecret,
        clearWebhookSecret: lovablePatch.clearWebhookSecret === true,
      },
    });
    res.json({ ok: true, lovable: sanitizeSettingsForClient(settings).lovable });
  })
);

app.post(
  "/api/settings",
  asyncHandler(async (req, res) => {
    const patch = {};
    if (req.body?.contaAzul && typeof req.body.contaAzul === "object") {
      patch.contaAzul = { ...req.body.contaAzul };
    }
    if (req.body?.lovable && typeof req.body.lovable === "object") {
      patch.lovable = { ...req.body.lovable };
    }
    const settings = await updateSettings(patch);
    res.json(sanitizeSettingsForClient(settings));
  })
);

app.get(
  "/api/fpa/bootstrap",
  asyncHandler(async (req, res) => {
    const from = String(req.query?.from || "").trim() || null;
    const to = String(req.query?.to || "").trim() || null;
    const prompt = String(req.query?.prompt || "visão geral de caixa").trim();
    const months = readFpaMonths(req.query?.months);
    const accountName = readFpaAccountName(req.query?.accountName);
    const [imports, allTransactions, dreAccounts, categoryRules, settings] = await Promise.all([
      listFpaImports(),
      listFpaTransactions({ limit: 5000 }),
      listFpaDreAccounts(),
      listFpaCategoryRules({ limit: 20 }),
      getSettings(),
    ]);
    const recentTransactions = filterTransactions(allTransactions, { from, to, months, accountName }).slice(0, readLargeLimit(req.query?.limit, 120));
    const availableCategories = buildAvailableCategories(allTransactions, dreAccounts);
    const overview = buildFpaOverview(allTransactions, { from, to, months, accountName });
    const report = buildRequestedFpaReport({ transactions: allTransactions, prompt, from, to, months, accountName, dreAccounts });

    res.json({
      categories: availableCategories.length ? availableCategories : CATEGORY_OPTIONS,
      imports: imports.slice(0, 30),
      availableAccounts: buildAvailableAccounts(allTransactions),
      availableMonths: buildAvailableMonths(allTransactions),
      dreTypeOptions: DRE_TYPE_OPTIONS,
      dreAccounts,
      dreReconciliation: buildDreReconciliation({ dreAccounts, categories: availableCategories, transactions: allTransactions }),
      dreSuggestions: buildSuggestedDreAccounts(availableCategories),
      categoryLearning: { rulesCount: categoryRules.length, recentRules: categoryRules.slice(0, 8) },
      contaAzul: sanitizeSettingsForClient(settings).contaAzul,
      lovable: sanitizeSettingsForClient(settings).lovable,
      storage: getStorageStatus(),
      overview,
      report,
      transactions: recentTransactions,
    });
  })
);

app.get(
  "/api/fpa/imports",
  asyncHandler(async (req, res) => res.json(await listFpaImports()))
);

app.post(
  "/api/fpa/imports",
  statementUpload,
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer?.length) throw createHttpError(400, "Anexe um arquivo de extrato para importar.");
    const accountName = truncateText(req.body?.accountName, 120) || null;
    const parsedStatement = parseStatementFile({
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      accountName,
    });
    const createdImport = await createFpaImport({
      sourceType: parsedStatement.sourceType,
      originalFilename: parsedStatement.originalFilename,
      accountName: parsedStatement.accountName,
      transactions: parsedStatement.transactions,
    });
    const allTransactions = await listFpaTransactions({ limit: 5000 });
    res.status(201).json({
      ok: true,
      import: createdImport.importRecord,
      importedCount: createdImport.importedTransactions.length,
      duplicateCount: createdImport.duplicateCount,
      overview: buildFpaOverview(allTransactions),
    });
  })
);

app.get(
  "/api/fpa/transactions",
  asyncHandler(async (req, res) => {
    const from = String(req.query?.from || "").trim() || null;
    const to = String(req.query?.to || "").trim() || null;
    const months = readFpaMonths(req.query?.months);
    const accountName = readFpaAccountName(req.query?.accountName);
    const transactions = await listFpaTransactions({ limit: 5000 });
    res.json(filterTransactions(transactions, { from, to, months, accountName }).slice(0, readLargeLimit(req.query?.limit, 200)));
  })
);

app.post(
  "/api/fpa/report",
  asyncHandler(async (req, res) => {
    const prompt = truncateText(req.body?.prompt, 280) || "visão geral de caixa";
    const from = String(req.body?.from || "").trim() || null;
    const to = String(req.body?.to || "").trim() || null;
    const months = readFpaMonths(req.body?.months);
    const accountName = readFpaAccountName(req.body?.accountName);
    const [transactions, dreAccounts] = await Promise.all([listFpaTransactions({ limit: 5000 }), listFpaDreAccounts()]);
    res.json(buildRequestedFpaReport({ transactions, prompt, from, to, months, accountName, dreAccounts }));
  })
);

app.get(
  "/api/fpa/dre-accounts",
  asyncHandler(async (req, res) => {
    const [dreAccounts, transactions] = await Promise.all([listFpaDreAccounts(), listFpaTransactions({ limit: 5000 })]);
    const availableCategories = buildAvailableCategories(transactions, dreAccounts);
    res.json({
      typeOptions: DRE_TYPE_OPTIONS,
      categories: availableCategories,
      accounts: dreAccounts,
      reconciliation: buildDreReconciliation({ dreAccounts, categories: availableCategories, transactions }),
      suggestions: buildSuggestedDreAccounts(availableCategories),
    });
  })
);

app.post(
  "/api/fpa/dre-accounts",
  asyncHandler(async (req, res) => {
    const created = await createFpaDreAccount({
      name: truncateText(req.body?.name, 120),
      type: req.body?.type,
      categories: Array.isArray(req.body?.categories) ? req.body.categories : [],
      orderIndex: req.body?.orderIndex,
      notes: truncateText(req.body?.notes, 2000),
    });
    res.status(201).json(created);
  })
);

app.post(
  "/api/fpa/dre-accounts/seed",
  asyncHandler(async (req, res) => {
    const transactions = await listFpaTransactions({ limit: 5000 });
    const categories = buildAvailableCategories(transactions, []);
    const seeded = await seedFpaDreAccounts(buildSuggestedDreAccounts(categories));
    res.status(201).json({ ok: true, createdCount: seeded.length, accounts: seeded });
  })
);

app.put(
  "/api/fpa/dre-accounts/:id",
  asyncHandler(async (req, res) => {
    const updated = await updateFpaDreAccount(req.params.id, {
      name: truncateText(req.body?.name, 120),
      type: req.body?.type,
      categories: Array.isArray(req.body?.categories) ? req.body.categories : [],
      orderIndex: req.body?.orderIndex,
      notes: truncateText(req.body?.notes, 2000),
    });
    if (!updated) throw createHttpError(404, "Conta DRE não encontrada.");
    res.json(updated);
  })
);

app.delete(
  "/api/fpa/dre-accounts/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteFpaDreAccount(req.params.id);
    if (!deleted) throw createHttpError(404, "Conta DRE não encontrada.");
    res.json({ ok: true, deleted });
  })
);

app.delete(
  "/api/fpa/accounts",
  asyncHandler(async (req, res) => {
    const accountName = readFpaAccountName(req.body?.accountName || req.query?.accountName);
    if (!accountName) throw createHttpError(400, "Informe a conta que deve ser excluída.");
    const deleted = await deleteFpaAccount(accountName);
    if (!deleted) throw createHttpError(404, "Conta financeira não encontrada.");
    const allTransactions = await listFpaTransactions({ limit: 5000 });
    res.json({ ok: true, ...deleted, overview: buildFpaOverview(allTransactions) });
  })
);

app.put(
  "/api/fpa/transactions/batch",
  asyncHandler(async (req, res) => {
    const updates = Array.isArray(req.body?.updates)
      ? req.body.updates.map((entry) => ({
          id: String(entry?.id || "").trim(),
          category: entry?.category,
          subcategory: entry?.subcategory,
          reportSection: entry?.reportSection,
          notes: entry?.notes,
          isInternalTransfer: entry?.isInternalTransfer === true,
        }))
      : [];
    if (!updates.length) throw createHttpError(400, "Informe pelo menos uma alteração para o salvamento em massa.");
    const updated = await updateFpaTransactionsBatch(updates);
    res.json({ ok: true, updatedCount: updated.length, updated });
  })
);

app.put(
  "/api/fpa/transactions/:id",
  asyncHandler(async (req, res) => {
    const updated = await updateFpaTransaction(req.params.id, {
      category: req.body?.category,
      subcategory: req.body?.subcategory,
      reportSection: req.body?.reportSection,
      notes: req.body?.notes,
      isInternalTransfer: req.body?.isInternalTransfer === true,
    });
    if (!updated) throw createHttpError(404, "Lançamento financeiro não encontrado.");
    res.json(updated);
  })
);

app.delete(
  "/api/fpa/transactions/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteFpaTransaction(req.params.id);
    if (!deleted) throw createHttpError(404, "Lançamento financeiro não encontrado.");
    const allTransactions = await listFpaTransactions({ limit: 5000 });
    res.json({ ok: true, ...deleted, overview: buildFpaOverview(allTransactions) });
  })
);

app.post(
  "/api/fpa/conta-azul/settings",
  asyncHandler(async (req, res) => {
    const contaAzulPatch = req.body?.contaAzul && typeof req.body.contaAzul === "object" ? req.body.contaAzul : {};
    const fpaExport = req.body?.fpaExport && typeof req.body.fpaExport === "object" ? req.body.fpaExport : null;
    const lovableContracts = req.body?.lovableContracts && typeof req.body.lovableContracts === "object" ? req.body.lovableContracts : null;
    const settings = await updateSettings({
      contaAzul: {
        ...contaAzulPatch,
        ...(fpaExport ? { fpaExport } : {}),
        ...(lovableContracts ? { lovableContracts } : {}),
      },
    });
    res.json({ ok: true, contaAzul: sanitizeSettingsForClient(settings).contaAzul });
  })
);

app.post(
  "/api/fpa/conta-azul/preview",
  asyncHandler(async (req, res) => {
    const context = await buildFpaContaAzulExportContext(req.body || {});
    res.json({
      ok: true,
      filters: context.filters,
      totalTransactions: context.transactions.length,
      total: context.payload.records.length,
      payload: context.payload,
    });
  })
);

app.post(
  "/api/fpa/conta-azul/reconciliation",
  asyncHandler(async (req, res) => {
    const context = await buildFpaContaAzulReconciliationContext(req.body || {});
    if (!context.contaAzulSettings.enabled || !context.contaAzulSettings.allowOutbound || !context.contaAzulSettings.fpaExport.enabled) {
      throw createHttpError(400, "Ative a exportação FP&A do Conta Azul antes de cruzar os lançamentos.");
    }

    res.json({
      ok: true,
      filters: context.filters,
      range: context.range,
      totalTransactions: context.transactions.length,
      total: context.payload.records.length,
      payload: context.payload,
      reconciliation: context.reconciliation,
      contaAzulRecords: context.contaAzulRecords,
      contaAzulEndpoints: context.contaAzulEndpoints || [],
    });
  })
);

app.post(
  "/api/fpa/conta-azul/push",
  asyncHandler(async (req, res) => {
    const onlyMissing = req.body?.onlyMissing !== false;
    const context = onlyMissing
      ? await buildFpaContaAzulReconciliationContext(req.body || {})
      : await buildFpaContaAzulExportContext(req.body || {});
    if (!context.contaAzulSettings.enabled || !context.contaAzulSettings.allowOutbound || !context.contaAzulSettings.fpaExport.enabled) {
      throw createHttpError(400, "Ative a exportação FP&A do Conta Azul antes de enviar lançamentos.");
    }
    if (!context.payload.records.length) throw createHttpError(400, "Nenhum lançamento financeiro atende aos filtros atuais para exportação.");
    const contaAzulSettings = onlyMissing ? context.contaAzulSettings : await ensureContaAzulAccessToken(context.settings, { allowRefresh: true });
    const fullPayload = onlyMissing ? context.payload : buildContaAzulFpaExportPayload({ settings: contaAzulSettings, transactions: context.transactions });
    const payload = onlyMissing
      ? { ...fullPayload, records: context.reconciliation.recordsToCreate, missingRequiredFields: collectMissingRequiredFields(context.reconciliation.recordsToCreate) }
      : fullPayload;

    if (!payload.records.length) {
      throw createHttpError(400, "Nenhum lançamento novo foi encontrado após o cruzamento com o Conta Azul.");
    }
    if (payload.missingRequiredFields.length) {
      throw createHttpError(400, `Configure os campos obrigatórios do Conta Azul antes do envio: ${payload.missingRequiredFields.join(", ")}.`);
    }
    const startedAt = nowIso();
    const results = [];

    for (const record of payload.records) {
      const endpoint = resolveContaAzulEndpointUrl(contaAzulSettings.baseUrl, record.endpointPath);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: buildContaAzulHeaders(contaAzulSettings),
        body: JSON.stringify(record.payload),
        signal: AbortSignal.timeout(15000),
      });
      const parsedResponse = await readContaAzulResponse(response);
      const eventId = parsedResponse.json?.id || parsedResponse.json?.uuid || parsedResponse.json?.evento?.id || parsedResponse.json?.id_evento || null;
      const contaAzulMeta = {
        status: response.ok ? "success" : "error",
        eventId,
        endpoint,
        responseCode: response.status,
        exportedAt: nowIso(),
        errorMessage: response.ok ? null : parsedResponse.preview || `HTTP ${response.status}`,
      };
      if (record.localId) await updateFpaTransaction(record.localId, { integration: { contaAzul: contaAzulMeta } });
      results.push({ localId: record.localId, ok: response.ok, endpoint, responseCode: response.status, eventId, responsePreview: parsedResponse.preview });
    }

    const exportedCount = results.filter((entry) => entry.ok).length;
    const failedCount = results.length - exportedCount;
    await recordContaAzulSync(
      {
        kind: "push",
        direction: "outbound",
        resource: "fpa_transactions",
        status: failedCount ? "error" : "success",
        endpoint: contaAzulSettings.baseUrl,
        recordCount: exportedCount,
        responseCode: failedCount ? null : 200,
        summary: failedCount
          ? `Exportação FP&A finalizada com ${failedCount} falha(s).`
          : onlyMissing
            ? `Exportação FP&A concluída para ${exportedCount} lançamento(s) faltante(s) após cruzamento.`
            : `Exportação FP&A concluída para ${exportedCount} lançamento(s).`,
        errorMessage: failedCount ? results.find((entry) => !entry.ok)?.responsePreview || "Falha parcial na exportação FP&A." : null,
        startedAt,
        finishedAt: nowIso(),
      },
      { lastPushAt: nowIso(), lastPushResource: "fpa_transactions", lastPushStatus: failedCount ? "error" : "success" }
    );

    res.status(failedCount ? 207 : 200).json({
      ok: failedCount === 0,
      exportedCount,
      failedCount,
      results,
      reconciliation: onlyMissing ? context.reconciliation : null,
    });
  })
);

app.get(
  "/api/conta-azul/people",
  asyncHandler(async (req, res) => {
    const currentSettings = await getSettings();
    const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
    const endpointPath = buildContaAzulPeoplePath({
      profileType: req.query?.profileType || req.query?.tipo_perfil,
      search: req.query?.search || req.query?.busca,
      page: req.query?.page || req.query?.pagina,
      pageSize: req.query?.pageSize || req.query?.tamanho_pagina,
    });
    const result = await fetchContaAzulJson(contaAzulSettings, endpointPath);
    const items = normalizeContaAzulListItems(result.parsed.json).map(normalizeContaAzulPerson).filter((item) => item.id);

    res.json({
      ok: true,
      endpoint: result.endpoint,
      responseCode: result.response.status,
      profileType: req.query?.profileType || req.query?.tipo_perfil || "",
      search: req.query?.search || req.query?.busca || "",
      total: Number(result.parsed.json?.total_itens || result.parsed.json?.totalItems || items.length) || items.length,
      items,
    });
  })
);

app.get(
  "/api/conta-azul/people/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) throw createHttpError(400, "Informe o UUID da pessoa.");
    const currentSettings = await getSettings();
    const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
    const result = await fetchContaAzulJson(contaAzulSettings, `/v1/pessoas/${encodeURIComponent(id)}`);

    res.json({
      ok: true,
      endpoint: result.endpoint,
      responseCode: result.response.status,
      person: normalizeContaAzulPerson(result.parsed.json),
      details: result.parsed.json,
    });
  })
);

app.get(
  "/api/conta-azul/financial-accounts",
  asyncHandler(async (req, res) => {
    const currentSettings = await getSettings();
    const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
    const endpointPath = buildContaAzulFinancialAccountsPath({
      search: req.query?.search || req.query?.name || req.query?.nome,
      page: req.query?.page || req.query?.pagina,
      pageSize: req.query?.pageSize || req.query?.tamanho_pagina,
    });
    const result = await fetchContaAzulJson(contaAzulSettings, endpointPath);
    const items = normalizeContaAzulListItems(result.parsed.json).map(normalizeContaAzulFinancialAccount).filter((item) => item.id);

    res.json({
      ok: true,
      endpoint: result.endpoint,
      responseCode: result.response.status,
      search: req.query?.search || req.query?.name || req.query?.nome || "",
      total: Number(result.parsed.json?.total_itens || result.parsed.json?.totalItems || items.length) || items.length,
      items,
    });
  })
);

app.get(
  "/api/conta-azul/financial-categories",
  asyncHandler(async (req, res) => {
    const currentSettings = await getSettings();
    const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
    const endpointPath = buildContaAzulFinancialCategoriesPath({
      search: req.query?.search || req.query?.busca || req.query?.name || req.query?.nome,
      type: req.query?.type || req.query?.tipo,
      page: req.query?.page || req.query?.pagina,
      pageSize: req.query?.pageSize || req.query?.tamanho_pagina,
      onlyChildren: req.query?.onlyChildren !== "false" && req.query?.apenas_filhos !== "false",
    });
    const result = await fetchContaAzulJson(contaAzulSettings, endpointPath);
    const items = normalizeContaAzulListItems(result.parsed.json).map(normalizeContaAzulFinancialCategory).filter((item) => item.id);

    res.json({
      ok: true,
      endpoint: result.endpoint,
      responseCode: result.response.status,
      search: req.query?.search || req.query?.busca || req.query?.name || req.query?.nome || "",
      type: req.query?.type || req.query?.tipo || "",
      total: Number(result.parsed.json?.itens_totais || result.parsed.json?.total_itens || result.parsed.json?.totalItems || items.length) || items.length,
      items,
    });
  })
);

app.get(
  "/api/conta-azul/products",
  asyncHandler(async (req, res) => {
    const currentSettings = await getSettings();
    const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
    const statusRaw = req.query?.status;
    const status = statusRaw === undefined || statusRaw === "" ? undefined : String(statusRaw).trim();
    const search = req.query?.search || req.query?.busca || "";
    const explicitPage = req.query?.page || req.query?.pagina;
    const pageSize = req.query?.pageSize || req.query?.tamanho_pagina;
    const wantAllPages = !explicitPage && String(req.query?.allPages ?? "true").toLowerCase() !== "false";

    if (wantAllPages) {
      const aggregated = await fetchContaAzulProductsAggregated(contaAzulSettings, { search, status, pageSize });
      res.json({
        ok: true,
        endpoint: aggregated.endpoint,
        responseCode: 200,
        search,
        allPages: true,
        total: aggregated.total,
        items: aggregated.items,
      });
      return;
    }

    const endpointPath = buildContaAzulProductsPath({
      search,
      page: explicitPage,
      pageSize,
      status,
    });
    const result = await fetchContaAzulJson(contaAzulSettings, endpointPath);
    const items = normalizeContaAzulListItems(result.parsed.json).map(normalizeContaAzulProduct).filter((item) => item.id);

    res.json({
      ok: true,
      endpoint: result.endpoint,
      responseCode: result.response.status,
      search,
      allPages: false,
      total: Number(result.parsed.json?.total_itens || result.parsed.json?.totalItems || items.length) || items.length,
      items,
    });
  })
);

app.get(
  "/api/finance/products",
  asyncHandler(async (req, res) => {
    const resource = FINANCE_RESOURCES.products;
    const search = String(req.query?.search || req.query?.q || "").trim();
    const query = { ...resource.queryForDate(getBusinessDate()) };
    if (search) {
      query.search = search;
      query.q = search;
      query.busca = search;
    }
    const pull = await fetchFinanceCollection({
      body: {},
      bodyKeys: resource.bodyKeys,
      envKeys: resource.envKeys,
      responseKeys: resource.responseKeys,
      query,
      resourceLabel: resource.resourceLabel,
    });
    const items = pull.items.map(normalizeFinanceProduct).filter((item) => item.id);
    res.json({
      ok: true,
      configured: pull.configured,
      source: pull.source,
      configuredEnvKey: pull.configuredEnvKey || null,
      expectedEnvKey: pull.expectedEnvKey,
      message: pull.message,
      search,
      items,
    });
  })
);

app.post(
  "/api/conta-azul/test-financial-event",
  asyncHandler(async (req, res) => {
    const currentSettings = await getSettings();
    const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
    if (!contaAzulSettings.enabled || !contaAzulSettings.allowOutbound) {
      throw createHttpError(400, "Ative a integração Conta Azul antes de criar lançamentos teste.");
    }

    const record = buildContaAzulTestFinancialEventRecord({
      settings: contaAzulSettings,
      type: req.body?.type,
      description: req.body?.description,
      amountCents: readMoneyAmountCents(req.body?.amount),
      competenceDate: req.body?.competenceDate,
      dueDate: req.body?.dueDate,
      contactId: req.body?.contactId,
      financialAccountId: req.body?.financialAccountId,
      categoryId: req.body?.categoryId || req.body?.financialCategoryId,
      notes: req.body?.notes,
    });
    if (record.missingRequiredFields.length) {
      throw createHttpError(
        400,
        `Preencha os campos obrigatórios do lançamento teste: ${record.missingRequiredFields.join(", ")}.`
      );
    }

    const endpoint = resolveContaAzulEndpointUrl(contaAzulSettings.baseUrl, record.endpointPath);
    if (!endpoint) throw createHttpError(400, "Configure a URL base da API do Conta Azul antes de criar o lançamento teste.");

    const startedAt = nowIso();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: buildContaAzulHeaders(contaAzulSettings),
      body: JSON.stringify(record.payload),
      signal: AbortSignal.timeout(15000),
    });
    const parsedResponse = await readContaAzulResponse(response);
    const eventId = parsedResponse.json?.id || parsedResponse.json?.uuid || parsedResponse.json?.evento?.id || parsedResponse.json?.id_evento || null;
    const eventLabel = record.type === "receivable" ? "contas a receber" : "contas a pagar";
    const errorMessage = response.ok ? null : parsedResponse.preview || `HTTP ${response.status}`;

    await recordContaAzulSync(
      {
        kind: "push",
        direction: "outbound",
        resource: "fpa_transactions",
        status: response.ok ? "success" : "error",
        endpoint,
        recordCount: response.ok ? 1 : 0,
        responseCode: response.status,
        summary: response.ok
          ? `Lançamento teste de ${eventLabel} criado no Conta Azul.`
          : `Falha ao criar lançamento teste de ${eventLabel}.`,
        errorMessage,
        startedAt,
        finishedAt: nowIso(),
      },
      {
        lastPushAt: nowIso(),
        lastPushResource: "fpa_transactions",
        lastPushStatus: response.ok ? "success" : "error",
        lastError: errorMessage,
      }
    );

    const result = {
      ok: response.ok,
      type: record.type,
      endpoint,
      endpointPath: record.endpointPath,
      responseCode: response.status,
      eventId,
      record,
      responsePreview: parsedResponse.preview,
    };

    if (!response.ok) {
      return res.status(response.status === 401 ? 401 : 400).json({
        ...result,
        error: `Conta Azul recusou o lançamento teste. ${errorMessage}`,
      });
    }

    res.status(201).json(result);
  })
);

app.post(
  "/api/conta-azul/oauth/authorize-url",
  asyncHandler(async (req, res) => {
    const currentSettingsWrapper = await getSettings();
    const contaAzulSettings = getContaAzulSettings(currentSettingsWrapper);
    ensureContaAzulOAuthClientSettings(contaAzulSettings, { requireClientSecret: false });
    const stateToken = createContaAzulOAuthState();
    const authorizeUrl = buildContaAzulAuthorizationUrl(contaAzulSettings, stateToken);
    await updateSettings({
      contaAzul: {
        status: { ...contaAzulSettings.status, oauthState: stateToken, oauthStateIssuedAt: nowIso(), lastError: null },
      },
    });
    res.json({ ok: true, authorizeUrl, redirectUri: contaAzulSettings.redirectUri || buildContaAzulSuggestedRedirectUri(req), state: stateToken });
  })
);

app.post(
  "/api/conta-azul/oauth/exchange-code",
  asyncHandler(async (req, res) => {
    const currentSettingsWrapper = await getSettings();
    const contaAzulSettings = getContaAzulSettings(currentSettingsWrapper);
    const startedAt = nowIso();
    const code = normalizeContaAzulAuthorizationCode(req.body?.code);
    const tokenResult = await requestContaAzulToken({ contaAzulSettings, grantType: "authorization_code", code });

    // Attempt account verification but do not block token persistence on failure.
    let connectedAccount = normalizeContaAzulConnectedAccount({});
    let accountEndpoint = contaAzulSettings.tokenUrl;
    let accountResponseCode = tokenResult.response.status;
    try {
      const accountResult = await fetchContaAzulConnectedAccount(tokenResult.nextSettings);
      connectedAccount = accountResult.connectedAccount;
      accountEndpoint = accountResult.endpoint;
      accountResponseCode = accountResult.response.status;
    } catch {
      // Non-fatal: token is saved regardless.
    }

    await persistContaAzulOAuthSuccess({
      currentSettings: contaAzulSettings,
      nextSettings: tokenResult.nextSettings,
      connectedAccount,
      kind: "oauth_authorize",
      endpoint: accountEndpoint,
      responseCode: accountResponseCode,
      summary: "Código OAuth do Conta Azul trocado por tokens com sucesso.",
    });
    res.json({
      ok: true,
      connectedAccount,
      accessTokenExpiresAt: tokenResult.nextSettings.accessTokenExpiresAt,
      responsePreview: tokenResult.parsed.preview,
      startedAt,
      finishedAt: nowIso(),
    });
  })
);

app.post(
  "/api/conta-azul/oauth/refresh",
  asyncHandler(async (req, res) => {
    const currentSettingsWrapper = await getSettings();
    const contaAzulSettings = getContaAzulSettings(currentSettingsWrapper);
    const tokenResult = await requestContaAzulToken({ contaAzulSettings, grantType: "refresh_token" });

    // Attempt account verification but do not block token persistence on failure.
    let connectedAccount = normalizeContaAzulConnectedAccount({});
    let accountEndpoint = contaAzulSettings.tokenUrl;
    let accountResponseCode = tokenResult.response.status;
    try {
      const accountResult = await fetchContaAzulConnectedAccount(tokenResult.nextSettings);
      connectedAccount = accountResult.connectedAccount;
      accountEndpoint = accountResult.endpoint;
      accountResponseCode = accountResult.response.status;
    } catch {
      // Non-fatal: token is saved regardless.
    }

    await persistContaAzulOAuthSuccess({
      currentSettings: contaAzulSettings,
      nextSettings: tokenResult.nextSettings,
      connectedAccount,
      kind: "oauth_refresh",
      endpoint: accountEndpoint,
      responseCode: accountResponseCode,
      summary: "Refresh token do Conta Azul executado com sucesso.",
    });
    res.json({ ok: true, connectedAccount, accessTokenExpiresAt: tokenResult.nextSettings.accessTokenExpiresAt });
  })
);

app.post(
  "/api/conta-azul/test-connection",
  asyncHandler(async (req, res) => {
    const currentSettings = await getSettings();
    const contaAzulSettings = await ensureContaAzulAccessToken(currentSettings, { allowRefresh: true });
    const accountResult = await fetchContaAzulConnectedAccount(contaAzulSettings);
    await updateSettings({
      contaAzul: {
        connectedAccount: accountResult.connectedAccount,
        status: { lastConnectionCheckAt: nowIso(), lastConnectionOk: true, lastError: null },
      },
    });
    res.json({ ok: true, endpoint: accountResult.endpoint, status: accountResult.response.status, connectedAccount: accountResult.connectedAccount });
  })
);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Erro interno do servidor." });
});

app.listen(PORT, () => {
  console.log(`Analista FP&A: http://localhost:${PORT}`);
});
