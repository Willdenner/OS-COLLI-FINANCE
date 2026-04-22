const crypto = require("node:crypto");

const DEFAULT_REALM = "Painel V4";
const AUTH_COOKIE_NAME = "analista_fpa_auth";
const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function buildBasicAuthChallenge(realm = DEFAULT_REALM) {
  const safeRealm = String(realm || DEFAULT_REALM).replaceAll('"', "");
  return `Basic realm="${safeRealm}", charset="UTF-8"`;
}

function parseBasicAuthHeader(headerValue) {
  const rawValue = String(headerValue || "").trim();
  if (!rawValue) return null;

  const [scheme, encodedValue] = rawValue.split(/\s+/, 2);
  if (!scheme || !encodedValue || scheme.toLowerCase() !== "basic") return null;

  let decodedValue = "";
  try {
    decodedValue = Buffer.from(encodedValue, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decodedValue.indexOf(":");
  if (separatorIndex < 0) return null;

  return {
    username: decodedValue.slice(0, separatorIndex),
    password: decodedValue.slice(separatorIndex + 1),
  };
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signAuthCookiePayload(payload, password) {
  return crypto.createHmac("sha256", String(password ?? "")).update(payload).digest("base64url");
}

function createAuthCookieValue({ username, password, issuedAt = Math.floor(Date.now() / 1000) }) {
  const payload = Buffer.from(JSON.stringify({ u: String(username || ""), iat: issuedAt }), "utf8").toString("base64url");
  return `${payload}.${signAuthCookiePayload(payload, password)}`;
}

function readCookieValue(cookieHeader, name) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function isAuthCookieValueValid(cookieValue, { username, password, now = Math.floor(Date.now() / 1000), maxAgeSeconds = AUTH_COOKIE_MAX_AGE_SECONDS }) {
  const [payload, signature] = String(cookieValue || "").split(".", 2);
  if (!payload || !signature) return false;

  const expectedSignature = signAuthCookiePayload(payload, password);
  if (!timingSafeEqual(signature, expectedSignature)) return false;

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  const issuedAt = Number(parsedPayload?.iat);
  if (parsedPayload?.u !== username || !Number.isFinite(issuedAt)) return false;
  if (issuedAt > now + 60) return false;
  return now - issuedAt <= maxAgeSeconds;
}

function shouldUseSecureCookie(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return Boolean(req?.secure || forwardedProto === "https");
}

function setAuthSessionCookie(req, res, { username, password }) {
  const cookieValue = createAuthCookieValue({ username, password });
  const cookieParts = [
    `${AUTH_COOKIE_NAME}=${cookieValue}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (shouldUseSecureCookie(req)) cookieParts.push("Secure");

  const cookieHeader = cookieParts.join("; ");
  if (typeof res.append === "function") {
    res.append("Set-Cookie", cookieHeader);
  } else {
    res.setHeader("Set-Cookie", cookieHeader);
  }
}

function buildUnauthorizedBody(req) {
  if (String(req?.path || "").startsWith("/api/")) {
    return {
      kind: "json",
      body: { error: "Autenticação obrigatória." },
    };
  }

  return {
    kind: "text",
    body: "Autenticação obrigatória.",
  };
}

function createBasicAuthMiddleware({ username, password, realm = DEFAULT_REALM }) {
  if (!username || !password) {
    throw new Error("Defina ADMIN_USER e ADMIN_PASSWORD para proteger o painel e a API.");
  }

  return (req, res, next) => {
    const credentials = parseBasicAuthHeader(req.headers?.authorization);
    const isAuthorized =
      credentials &&
      timingSafeEqual(credentials.username, username) &&
      timingSafeEqual(credentials.password, password);
    const sessionCookie = readCookieValue(req.headers?.cookie, AUTH_COOKIE_NAME);
    const hasValidSessionCookie = isAuthCookieValueValid(sessionCookie, { username, password });

    if (isAuthorized) {
      req.auth = { username: credentials.username };
      setAuthSessionCookie(req, res, { username, password });
      return next();
    }

    if (hasValidSessionCookie) {
      req.auth = { username };
      return next();
    }

    // Only trigger the browser's native auth dialog for page requests, not API calls.
    // Sending WWW-Authenticate on /api/* routes causes the browser to pop the dialog
    // on every failed background fetch (e.g. after a server restart on Render).
    if (!String(req?.path || "").startsWith("/api/")) {
      res.setHeader("WWW-Authenticate", buildBasicAuthChallenge(realm));
    }
    res.setHeader("Cache-Control", "no-store");

    const unauthorized = buildUnauthorizedBody(req);
    if (unauthorized.kind === "json") {
      return res.status(401).json(unauthorized.body);
    }

    return res.status(401).type("text/plain; charset=utf-8").send(unauthorized.body);
  };
}

function getAdminCredentialsFromEnv(env = process.env) {
  const username = String(env.ADMIN_USER ?? "").trim();
  const password = env.ADMIN_PASSWORD == null ? "" : String(env.ADMIN_PASSWORD);

  if (!username || !password) {
    throw new Error("Defina ADMIN_USER e ADMIN_PASSWORD para iniciar o servidor com proteção HTTP Basic Auth.");
  }

  return { username, password };
}

module.exports = {
  AUTH_COOKIE_NAME,
  DEFAULT_REALM,
  buildBasicAuthChallenge,
  createBasicAuthMiddleware,
  getAdminCredentialsFromEnv,
  parseBasicAuthHeader,
  timingSafeEqual,
};
