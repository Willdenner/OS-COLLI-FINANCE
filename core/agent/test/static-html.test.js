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
  assert.match(html, /href="\/fpa\/conta-azul-vinculos"/);
  assert.match(html, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(html, /href="#fpsa"/);
});

test("painel FP&A expõe o orquestrador diário de contas a receber", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const renderYaml = await fs.readFile(path.join(__dirname, "..", "..", "..", "render.yaml"), "utf8");

  assert.match(html, /id="receivables-orchestrator"/);
  assert.match(html, /btn-run-receivables-orchestrator/);
  assert.match(html, /btn-test-finance-connection/);
  assert.match(html, /btn-open-receivables-analysis/);
  assert.match(html, /btn-resume-receivables-orchestrator/);
  assert.match(html, /btn-close-receivables-day/);
  assert.match(html, /btn-sync-finance-clients/);
  assert.match(html, /btn-sync-finance-clients-inline/);
  assert.match(html, /Clientes Finance → Conta Azul/);
  assert.match(html, /\/api\/fpa\/receivables-orchestrator\/run/);
  assert.match(html, /\/api\/fpa\/receivables-orchestrator\/sync-clients/);
  assert.match(html, /\/api\/fpa\/receivables-orchestrator\/finance-diagnostics/);
  assert.match(html, /\/api\/fpa\/receivables-orchestrator\/close-day/);
  assert.match(html, /buildAbsoluteAppUrl\("\/fpa\/receivables-analysis"\)/);
  assert.match(server, /runReceivablesOrchestrator/);
  assert.match(server, /syncFinanceClientsToContaAzul/);
  assert.match(server, /ensureFinanceClientPresyncCompleted/);
  assert.match(server, /createdSince/);
  assert.match(server, /buildFinanceDiagnostics/);
  assert.match(server, /waiting_finance_connection/);
  assert.match(server, /due_today/);
  assert.match(server, /previewItems/);
  assert.match(server, /syncLovableContractToContaAzul/);
  assert.match(server, /syncLovableReceiptToContaAzul/);
  assert.match(server, /trimReceivablesPayloadItems/);
  assert.match(server, /\/api\/fpa\/receivables-orchestrator\/resume/);
  assert.match(renderYaml, /key: COLLI_FINANCE_CONTRACTS_URL/);
  assert.match(renderYaml, /key: COLLI_FINANCE_BILLING_CARDS_URL/);
  assert.match(renderYaml, /key: COLLI_FINANCE_PAYMENTS_URL/);
});

test("pagina de analise do orquestrador detalha payloads, exportacoes e motivos de ignorado", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "receivables-analysis.html"), "utf8");
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");

  assert.match(html, /Historico de ciclos/);
  assert.match(html, /Contratos lidos do Finance/);
  assert.match(html, /Cards lidos do Finance/);
  assert.match(html, /Integracao com o bot/);
  assert.match(html, /Pagamentos e fechamento/);
  assert.match(html, /\/api\/fpa\/receivables-orchestrator\?limit=30/);
  assert.match(html, /\/api\/fpa\/receivables-orchestrator\/finance-diagnostics/);
  assert.match(html, /translateIgnoreReason/);
  assert.match(html, /cobranca_ja_enviada_no_origem/);
  assert.match(html, /billing_cards_to_cobranca/);
  assert.match(html, /contracts_to_conta_azul/);
  assert.match(html, /Servico contratado/);
  assert.match(html, /Categoria no Finance/);
  assert.match(html, /extractFinanceCategoryInfo/);
  assert.match(html, /financeCategoriesForRun/);
  assert.match(html, /Campos recebidos do Finance/);
  assert.match(html, /summarizeFinanceContractApiFields/);
  assert.match(html, /extractContractedService/);
  assert.match(server, /enrichFinanceContractForReceivables/);
  assert.match(server, /COLLI_FINANCE_CATEGORIES_URL/);
  assert.match(server, /\/api\/finance\/categories/);
  assert.match(server, /RECEIVABLES_ANALYSIS_INDEX/);
  assert.match(server, /sendReceivablesAnalysisPage/);
  assert.match(server, /app\.get\("\/fpa\/receivables-analysis", sendReceivablesAnalysisPage\)/);
});

test("servidor nao entrega a home estatica antes do Basic Auth", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");

  assert.match(server, /express\.static\(STATIC_DIR,\s*\{\s*index:\s*false\s*\}\)/);
});

test("servidor expoe exportacao consolidada para n8n via Basic Auth", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const readme = await fs.readFile(path.join(__dirname, "..", "README.md"), "utf8");

  assert.match(server, /app\.use\(adminAuthMiddleware\)[\s\S]*\/api\/integrations\/n8n\/export/);
  assert.match(server, /listReceivablesOrchestratorRuns\(\{\s*limit\s*\}\)/);
  assert.match(server, /listLovableContractSyncs\(\{\s*limit\s*\}\)/);
  assert.match(server, /listLovableReceiptSyncs\(\{\s*limit\s*\}\)/);
  assert.match(server, /sanitizeSettingsForClient\(settings\)/);
  assert.match(readme, /GET \/api\/integrations\/n8n\/export/);
  assert.match(readme, /HTTP Basic Auth/);
});

test("servidor resolve links dos modulos web pelo Render ou por variaveis", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const renderYaml = await fs.readFile(path.join(__dirname, "..", "..", "..", "render.yaml"), "utf8");

  assert.match(renderYaml, /name: os-colli-finance/);
  assert.doesNotMatch(renderYaml, /name: analista-fpa/);
  assert.match(server, /async function proxyCobrancasModule/);
  assert.match(server, /async function proxyExtratorModule/);
  assert.match(server, /DEFAULT_COBRANCAS_URL = "https:\/\/bot-cobranca-25qf\.onrender\.com"/);
  assert.match(server, /DEFAULT_EXTRATOR_URL = "https:\/\/bot-extrator\.onrender\.com"/);
  assert.match(server, /function resolveProxyBaseUrl/);
  assert.match(server, /function buildInternalModuleAuthorizationHeader/);
  assert.match(server, /applyInternalModuleAuthorization\(buildProxyHeaders\(req\)\)/);
  assert.match(server, /rewriteCobrancasHtml/);
  assert.match(server, /rewriteExtratorHtml/);
  assert.match(server, /app\.use\("\/cobrancas",\s*asyncHandler\(proxyCobrancasModule\)\)/);
  assert.match(server, /app\.use\("\/extrator",\s*asyncHandler\(proxyExtratorModule\)\)/);
  assert.match(server, /COBRANCAS_INTERNAL_URL/);
  assert.match(server, /COBRANCAS_URL/);
  assert.match(server, /BOT_COBRANCA_URL/);
  assert.match(server, /EXTRATOR_INTERNAL_URL/);
  assert.match(server, /EXTRATOR_URL/);
  assert.match(server, /BOT_EXTRATOR_URL/);
  assert.doesNotMatch(server, /bot-cobranca\.onrender\.com/);
  assert.match(renderYaml, /key: COBRANCAS_INTERNAL_URL[\s\S]*fromService:[\s\S]*name: bot-cobranca[\s\S]*property: hostport/);
  assert.match(renderYaml, /key: COBRANCAS_URL\s*\n\s*value: https:\/\/bot-cobranca-25qf\.onrender\.com/);
  assert.match(renderYaml, /key: EXTRATOR_URL\s*\n\s*value: https:\/\/bot-extrator\.onrender\.com/);
  assert.match(renderYaml, /key: EXTRATOR_INTERNAL_URL[\s\S]*fromService:[\s\S]*name: bot-extrator[\s\S]*property: hostport/);
});

test("Blueprint do Render compartilha Basic Auth gerado entre os servicos web", async () => {
  const renderYaml = await fs.readFile(path.join(__dirname, "..", "..", "..", "render.yaml"), "utf8");

  assert.match(renderYaml, /envVarGroups:[\s\S]*name: colli-admin-auth[\s\S]*key: ADMIN_USER[\s\S]*value: admin/);
  assert.match(renderYaml, /envVarGroups:[\s\S]*name: colli-admin-auth[\s\S]*key: ADMIN_PASSWORD[\s\S]*generateValue: true/);
  assert.equal((renderYaml.match(/fromGroup: colli-admin-auth/g) || []).length, 3);
  assert.doesNotMatch(renderYaml, /key: ADMIN_PASSWORD\s*\n\s*sync: false/);
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

test("pagina FP&A permite solicitar reinicio do servidor", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");

  assert.match(html, /id="btn-restart-fpa"/);
  assert.match(html, /Reiniciar FP&amp;A/);
  assert.match(html, /\/api\/fpa\/restart/);
  assert.match(html, /window\.location\.href = `\/fpa\?deploy=\$\{Date\.now\(\)\}`/);
  assert.match(server, /app\.post\(\s*"\/api\/fpa\/restart"/);
  assert.match(server, /process\.exit\(0\)/);
});

test("pagina FP&A alerta quando persistencia duravel nao esta configurada", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.match(html, /id="fpa-storage-alert"/);
  assert.match(html, /Configure DATABASE_URL/);
  assert.match(html, /Secret salvo no servidor/);
  assert.match(html, /Segredo salvo no servidor/);
});

test("pagina dedicada de vínculos Finance Conta Azul e rota no servidor", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "conta-azul-vinculos.html"), "utf8");
  const server = await fs.readFile(path.join(__dirname, "..", "src", "server.js"), "utf8");

  assert.equal(/[\u201c\u201d]/.test(html), false);
  assert.match(html, /href="\/fpa\/conta-azul-vinculos"/);
  assert.match(html, /\/api\/fpa\/conta-azul\/settings/);
  assert.match(html, /fetch\(path,\s*\{\s*credentials:\s*"same-origin",\s*\.\.\.options\s*\}\)/);
  assert.match(server, /conta-azul-vinculos\.html/);
  assert.match(server, /\/fpa\/conta-azul-vinculos/);
  assert.match(html, /\/api\/conta-azul\/products/);
  assert.match(server, /\/api\/conta-azul\/products/);
  assert.match(html, /\/api\/finance\/products/);
  assert.match(server, /\/api\/finance\/products/);
  assert.match(html, /cazv-embed/);
  assert.match(html, /fpa-cazv-vinculos-saved/);
});

test("menu lateral FP&A aponta para página de vínculos Conta Azul", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "static", "fpa.html"), "utf8");

  assert.match(html, /href="\/fpa\/conta-azul-vinculos"/);
  assert.match(html, /Vínculos Finance → CA/);
  assert.match(html, /fpa-cazv-modal/);
  assert.match(html, /embed=1/);
});
