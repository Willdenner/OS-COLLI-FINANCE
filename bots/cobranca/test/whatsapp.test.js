const test = require("node:test");
const assert = require("node:assert/strict");

const { buildChromiumLaunchArgs, buildPuppeteerOptions } = require("../src/lib/whatsapp");

function restoreEnv(name, value) {
  if (value == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("monta argumentos enxutos do Chromium para ambiente de container", () => {
  const original = process.env.WHATSAPP_CHROMIUM_ARGS;
  delete process.env.WHATSAPP_CHROMIUM_ARGS;

  const args = buildChromiumLaunchArgs();

  assert.ok(args.includes("--no-sandbox"));
  assert.ok(args.includes("--disable-dev-shm-usage"));
  assert.ok(args.includes("--disable-gpu"));
  assert.ok(args.includes("--disable-extensions"));
  assert.ok(args.includes("--no-zygote"));

  restoreEnv("WHATSAPP_CHROMIUM_ARGS", original);
});

test("permite complementar argumentos do Chromium por variável de ambiente", () => {
  const original = process.env.WHATSAPP_CHROMIUM_ARGS;
  process.env.WHATSAPP_CHROMIUM_ARGS = "--window-size=1280,720 --lang=pt-BR";

  const args = buildChromiumLaunchArgs();

  assert.ok(args.includes("--window-size=1280,720"));
  assert.ok(args.includes("--lang=pt-BR"));

  restoreEnv("WHATSAPP_CHROMIUM_ARGS", original);
});

test("monta as opções do Puppeteer com executablePath opcional", () => {
  const original = process.env.WHATSAPP_CHROMIUM_ARGS;
  delete process.env.WHATSAPP_CHROMIUM_ARGS;

  const options = buildPuppeteerOptions("/usr/bin/chromium");

  assert.equal(options.headless, true);
  assert.equal(options.executablePath, "/usr/bin/chromium");
  assert.ok(Array.isArray(options.args));
  assert.ok(options.args.length > 5);

  restoreEnv("WHATSAPP_CHROMIUM_ARGS", original);
});
