const test = require("node:test");
const assert = require("node:assert/strict");

const { formatMoneyBRL, isIsoDate, truncateText } = require("../src/lib/domain");

test("formata valores em reais a partir de centavos", () => {
  const normalizeSpaces = (value) => value.replace(/\s/g, " ");
  assert.equal(normalizeSpaces(formatMoneyBRL(150000)), "R$ 1.500,00");
  assert.equal(normalizeSpaces(formatMoneyBRL(-25090)), "-R$ 250,90");
});

test("trunca textos longos preservando conteudo curto", () => {
  assert.equal(truncateText("  Receita Operacional  ", 30), "Receita Operacional");
  assert.equal(truncateText("abcdefghijklmnopqrstuvwxyz", 8), "abcdefg…");
});

test("valida datas ISO usadas nos filtros financeiros", () => {
  assert.equal(isIsoDate("2026-04-20"), true);
  assert.equal(isIsoDate("20/04/2026"), false);
  assert.equal(isIsoDate("2026-02-31"), false);
});
