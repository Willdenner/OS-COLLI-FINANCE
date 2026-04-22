const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(ROOT_DIR, "data");

function truncateText(text, maxLength = 4000) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatMoneyBRL(valueCents) {
  const value = (valueCents ?? 0) / 100;
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

module.exports = {
  DATA_DIR,
  ROOT_DIR,
  formatMoneyBRL,
  isIsoDate,
  truncateText,
};
