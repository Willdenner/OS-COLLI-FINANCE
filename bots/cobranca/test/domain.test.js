const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPaymentTemplateContext, renderTemplate } = require("../src/lib/domain");

test("gera contexto de pagamento inteligente quando há boleto e link", () => {
  const ctx = buildPaymentTemplateContext({
    paymentLink: "https://empresa.com/pagar",
    attachments: [
      { filename: "boleto.pdf", originalName: "Boleto.pdf", kind: "boleto", label: "Boleto" },
      { filename: "nf.xml", originalName: "NF.xml", kind: "nota_fiscal", label: "Nota Fiscal" },
    ],
  });

  assert.equal(ctx.formaDePagamento, "o boleto em anexo ou o link de pagamento abaixo");
  assert.match(ctx.instrucoesDePagamento, /boleto segue em anexo/i);
  assert.match(ctx.instrucoesDePagamento, /https:\/\/empresa\.com\/pagar/);
  assert.equal(ctx.linkDoPagamento, "https://empresa.com/pagar");
  assert.equal(ctx.anexosDaCobranca, "Boleto, Nota Fiscal");
});

test("adapta templates antigos com [Link do pagamento] para boleto em anexo", () => {
  const ctx = buildPaymentTemplateContext({
    paymentLink: "",
    attachments: [{ filename: "boleto.pdf", originalName: "Boleto.pdf", kind: "boleto", label: "Boleto" }],
  });

  const rendered = renderTemplate("Para sua comodidade, segue o link de pagamento:\n[Link do pagamento]", ctx);

  assert.equal(rendered, "Para sua comodidade, o boleto segue em anexo para pagamento.");
});

test("renderiza a variável de instruções de pagamento de forma contextual", () => {
  const ctx = buildPaymentTemplateContext({
    paymentLink: "https://empresa.com/pagar",
    attachments: [],
  });

  const rendered = renderTemplate("Forma: [forma de pagamento]\n\n[instruções de pagamento]", {
    ...ctx,
    nomeDoCliente: "Ana",
    valor: "R$ 10,00",
    dataDePagamento: "20/04/2026",
  });

  assert.match(rendered, /Forma: o link de pagamento abaixo/);
  assert.match(rendered, /segue o link de pagamento/i);
  assert.match(rendered, /https:\/\/empresa\.com\/pagar/);
});
