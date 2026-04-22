const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("pagina inicial Colli Finance OS aponta para os modulos principais", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "index.html"), "utf8");

  assert.match(html, /<title>Colli Finance OS<\/title>/);
  assert.match(html, /href="\/fpa"/);
  assert.match(html, /href="\/cobrancas"/);
  assert.match(html, /href="\/extrator"/);
  assert.match(html, /href="\/fpa#lovable-integration"/);
  assert.match(html, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(html, /href="#fpsa"/);
});

test("servidor nao entrega a home estatica antes do Basic Auth", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");

  assert.match(server, /express\.static\(STATIC_DIR,\s*\{\s*index:\s*false\s*\}\)/);
});

test("servidor resolve links dos modulos web pelo Render ou por variaveis", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const renderYaml = await fs.readFile(path.join(__dirname, "..", "..", "..", "render.yaml"), "utf8");

  assert.match(server, /async function proxyCobrancasModule/);
  assert.match(server, /rewriteCobrancasHtml/);
  assert.match(server, /app\.use\("\/cobrancas",\s*asyncHandler\(proxyCobrancasModule\)\)/);
  assert.match(server, /COBRANCAS_INTERNAL_URL/);
  assert.match(server, /COBRANCAS_URL/);
  assert.match(server, /BOT_COBRANCA_URL/);
  assert.match(server, /EXTRATOR_URL/);
  assert.match(server, /BOT_EXTRATOR_URL/);
  assert.doesNotMatch(server, /bot-cobranca\.onrender\.com/);
  assert.doesNotMatch(server, /bot-extrator\.onrender\.com/);
  assert.match(renderYaml, /key: COBRANCAS_INTERNAL_URL[\s\S]*fromService:[\s\S]*name: bot-cobranca[\s\S]*property: hostport/);
  assert.match(renderYaml, /key: COBRANCAS_URL[\s\S]*fromService:[\s\S]*name: bot-cobranca[\s\S]*envVarKey: RENDER_EXTERNAL_URL/);
  assert.match(renderYaml, /key: EXTRATOR_URL[\s\S]*fromService:[\s\S]*name: bot-extrator[\s\S]*envVarKey: RENDER_EXTERNAL_URL/);
});

test("pagina FP&A nao usa aspas tipograficas em atributos HTML", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.equal(/[\u201c\u201d]/.test(html), false);
});

test("helper de API nao recarrega a pagina quando integracao retorna 401", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.equal(/response\.status\s*===\s*401[\s\S]{0,200}window\.location\.reload/.test(html), false);
});

test("helper de API envia credenciais nas chamadas internas do painel", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.match(html, /fetch\(path,\s*\{\s*credentials:\s*"same-origin",\s*\.\.\.options\s*\}\)/);
});

test("pagina Conta Azul permite buscar pessoas, contas e categorias sem digitar UUID manualmente", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.match(html, /id="btn-load-conta-azul-people"/);
  assert.match(html, /id="fpa-conta-azul-contact-select"/);
  assert.match(html, /id="btn-load-conta-azul-accounts"/);
  assert.match(html, /id="fpa-conta-azul-financial-account-select"/);
  assert.match(html, /id="btn-load-conta-azul-test-categories"/);
  assert.match(html, /id="fpa-ca-test-category-select"/);
  assert.match(html, /id="fpa-conta-azul-receivable-category-select"/);
  assert.match(html, /id="fpa-conta-azul-payable-category-select"/);
  assert.match(html, /\/api\/conta-azul\/people/);
  assert.match(html, /\/api\/conta-azul\/financial-accounts/);
  assert.match(html, /\/api\/conta-azul\/financial-categories/);
});

test("pagina FP&A organiza o trabalho em fluxo sequencial antes do envio ao Conta Azul", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.match(html, /data-workflow-step="import"/);
  assert.match(html, /data-workflow-step="analysis"/);
  assert.match(html, /data-workflow-step="crosscheck"/);
  assert.match(html, /data-workflow-step="launch"/);
  assert.match(html, /data-workflow-step="done"/);
  assert.match(html, /id="conta-azul-crosscheck"/);
  assert.match(html, /id="conta-azul-launch-review"/);
  assert.match(html, /id="workflow-conclusion"/);
  assert.match(html, /\/api\/fpa\/conta-azul\/reconciliation/);
  assert.match(html, /onlyMissing:\s*true/);
});

test("pagina FP&A exibe configuracao da integracao Lovable", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.match(html, /id="lovable-integration"/);
  assert.match(html, /id="fpa-lovable-secret"/);
  assert.match(html, /id="fpa-lovable-contracts-url"/);
  assert.match(html, /id="fpa-lovable-receipts-url"/);
  assert.match(html, /id="btn-save-lovable-settings"/);
  assert.match(html, /\/api\/integrations\/lovable\/settings/);
  assert.match(html, /\/api\/integrations\/lovable\/contracts/);
  assert.match(html, /\/api\/integrations\/lovable\/receipts/);
});

test("pagina FP&A alerta quando persistencia duravel nao esta configurada", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.match(html, /id="fpa-storage-alert"/);
  assert.match(html, /Configure DATABASE_URL/);
  assert.match(html, /Secret salvo no servidor/);
  assert.match(html, /Segredo salvo no servidor/);
});
