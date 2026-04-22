const crypto = require("node:crypto");

const DEFAULT_REALM = "Painel V4";

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

    if (isAuthorized) {
      req.auth = { username: credentials.username };
      return next();
    }

    res.setHeader("WWW-Authenticate", buildBasicAuthChallenge(realm));
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
  DEFAULT_REALM,
  buildBasicAuthChallenge,
  createBasicAuthMiddleware,
  getAdminCredentialsFromEnv,
  parseBasicAuthHeader,
  timingSafeEqual,
};
