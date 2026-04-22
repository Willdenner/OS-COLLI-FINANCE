const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTH_COOKIE_NAME,
  buildBasicAuthChallenge,
  createBasicAuthMiddleware,
  getAdminCredentialsFromEnv,
  parseBasicAuthHeader,
  timingSafeEqual,
} = require("../src/lib/basic-auth");

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    contentType: null,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    json(value) {
      this.payload = value;
      this.contentType = "application/json";
      return this;
    },
    send(value) {
      this.payload = value;
      return this;
    },
  };
}

test("parseia o header Authorization Basic preservando senha com dois pontos", () => {
  const encoded = Buffer.from("admin:segredo:123", "utf8").toString("base64");
  assert.deepEqual(parseBasicAuthHeader(`Basic ${encoded}`), {
    username: "admin",
    password: "segredo:123",
  });
});

test("gera o challenge HTTP Basic com realm em UTF-8", () => {
  assert.equal(buildBasicAuthChallenge("Painel Seguro"), 'Basic realm="Painel Seguro", charset="UTF-8"');
});

test("compara credenciais com timingSafeEqual apenas quando os valores batem", () => {
  assert.equal(timingSafeEqual("admin", "admin"), true);
  assert.equal(timingSafeEqual("admin", "Admin"), false);
  assert.equal(timingSafeEqual("admin", "admin123"), false);
});

test("bloqueia requisição da API sem credenciais e responde com 401 json", () => {
  const middleware = createBasicAuthMiddleware({
    username: "admin",
    password: "segredo-forte",
    realm: "Painel V4",
  });

  const req = {
    path: "/api/dashboard",
    headers: {},
  };
  const res = createMockResponse();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["WWW-Authenticate"], undefined);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.payload, { error: "Autenticação obrigatória." });
});

test("permite acesso quando o header Basic contém as credenciais corretas", () => {
  const middleware = createBasicAuthMiddleware({
    username: "admin",
    password: "segredo-forte",
  });

  const req = {
    path: "/",
    headers: {
      authorization: `Basic ${Buffer.from("admin:segredo-forte", "utf8").toString("base64")}`,
    },
  };
  const res = createMockResponse();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.auth, { username: "admin" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Set-Cookie"], new RegExp(`^${AUTH_COOKIE_NAME}=`));
  assert.match(res.headers["Set-Cookie"], /HttpOnly/);
  assert.match(res.headers["Set-Cookie"], /SameSite=Lax/);
});

test("permite chamadas da API com cookie de sessao emitido pelo Basic Auth", () => {
  const middleware = createBasicAuthMiddleware({
    username: "admin",
    password: "segredo-forte",
  });

  const loginReq = {
    path: "/",
    headers: {
      authorization: `Basic ${Buffer.from("admin:segredo-forte", "utf8").toString("base64")}`,
    },
  };
  const loginRes = createMockResponse();
  middleware(loginReq, loginRes, () => {});
  const sessionCookie = loginRes.headers["Set-Cookie"].split(";", 1)[0];

  const apiReq = {
    path: "/api/conta-azul/oauth/exchange-code",
    headers: {
      cookie: sessionCookie,
    },
  };
  const apiRes = createMockResponse();
  let nextCalled = false;

  middleware(apiReq, apiRes, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(apiReq.auth, { username: "admin" });
  assert.equal(apiRes.statusCode, 200);
});

test("exige ADMIN_USER e ADMIN_PASSWORD no ambiente para subir o middleware", () => {
  assert.throws(
    () => getAdminCredentialsFromEnv({ ADMIN_USER: "admin" }),
    /ADMIN_USER e ADMIN_PASSWORD/
  );

  assert.deepEqual(getAdminCredentialsFromEnv({ ADMIN_USER: "admin", ADMIN_PASSWORD: "segredo" }), {
    username: "admin",
    password: "segredo",
  });
});
