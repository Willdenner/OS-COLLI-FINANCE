const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPasswordCandidates, createEmailService, maskEmail, normalizeConfig } = require("../src/lib/email");

test("mascara o e-mail do Gmail para exibição no painel", () => {
  assert.equal(maskEmail("financeiro@empresa.com"), "fi***@empresa.com");
  assert.equal(maskEmail("ab@empresa.com"), "a*@empresa.com");
  assert.equal(maskEmail(""), null);
});

test("expõe o status da integração Gmail a partir das variáveis de ambiente", () => {
  const previousUser = process.env.GMAIL_USER;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  const previousFromName = process.env.GMAIL_FROM_NAME;

  process.env.GMAIL_USER = "financeiro@empresa.com";
  process.env.GMAIL_APP_PASSWORD = "abcdefghijklmnop";
  process.env.GMAIL_FROM_NAME = "Financeiro V4";

  const emailService = createEmailService({ uploadsDir: process.cwd() });
  const status = emailService.getStatus();

  assert.equal(status.provider, "gmail");
  assert.equal(status.configured, true);
  assert.equal(status.fromEmail, "financeiro@empresa.com");
  assert.equal(status.fromName, "Financeiro V4");
  assert.equal(status.maskedEmail, "fi***@empresa.com");

  if (previousUser === undefined) {
    delete process.env.GMAIL_USER;
  } else {
    process.env.GMAIL_USER = previousUser;
  }
  if (previousPassword === undefined) {
    delete process.env.GMAIL_APP_PASSWORD;
  } else {
    process.env.GMAIL_APP_PASSWORD = previousPassword;
  }
  if (previousFromName === undefined) {
    delete process.env.GMAIL_FROM_NAME;
  } else {
    process.env.GMAIL_FROM_NAME = previousFromName;
  }
});

test("aceita senhas curtas para validar no Gmail sem bloquear por tamanho", () => {
  const config = normalizeConfig({
    user: "financeiro@empresa.com",
    appPassword: "12345678",
    fromName: "Financeiro V4",
  });

  assert.equal(config.appPassword, "12345678");
  assert.equal(config.hasCredentials, true);
  assert.equal(config.configured, false);
});

test("gera candidatos de autenticação preservando a senha original e uma versão sem espaços", () => {
  assert.deepEqual(buildPasswordCandidates(" abcd efgh ijkl mnop "), ["abcd efgh ijkl mnop", "abcdefghijklmnop"]);
  assert.deepEqual(buildPasswordCandidates("12345678"), ["12345678"]);
});
