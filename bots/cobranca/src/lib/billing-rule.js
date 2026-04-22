const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizeRuleOffsetDays(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(-365, Math.min(365, Math.trunc(numeric)));
}

function startOfLocalDay(date = new Date()) {
  const normalized = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function parseIsoDateToLocalDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function getInvoiceAgingDays(invoice, now = new Date()) {
  const dueDate = parseIsoDateToLocalDate(invoice?.dueDate);
  if (!dueDate) return null;
  return Math.round((startOfLocalDay(now).getTime() - startOfLocalDay(dueDate).getTime()) / MS_PER_DAY);
}

function describeRuleOffsetDays(offsetDays) {
  const normalized = normalizeRuleOffsetDays(offsetDays);
  if (normalized == null) return "Fora da régua";
  if (normalized === 0) return "No vencimento";
  if (normalized < 0) return `${Math.abs(normalized)} dia(s) antes`;
  return `${normalized} dia(s) após`;
}

function describeAgingDays(agingDays) {
  if (!Number.isInteger(agingDays)) return "Sem vencimento";
  if (agingDays === 0) return "Vence hoje";
  if (agingDays < 0) return `${Math.abs(agingDays)} dia(s) para vencer`;
  return `${agingDays} dia(s) em atraso`;
}

function listRuleTemplates(templates) {
  return (Array.isArray(templates) ? templates : [])
    .filter((template) => Number.isInteger(template?.ruleOffsetDays))
    .slice()
    .sort((a, b) => {
      const offsetCompare = a.ruleOffsetDays - b.ruleOffsetDays;
      if (offsetCompare !== 0) return offsetCompare;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
}

function sortDispatchesByLatest(dispatches) {
  return (Array.isArray(dispatches) ? dispatches : [])
    .slice()
    .sort((a, b) => {
      const aStamp = new Date(a.sentAt || a.attemptedAt || 0).getTime();
      const bStamp = new Date(b.sentAt || b.attemptedAt || 0).getTime();
      return bStamp - aStamp;
    });
}

function mapRuleStatusToInvoiceStatus(sendStatus, fallbackStatus) {
  if (sendStatus === "ready") return "pending";
  if (sendStatus === "failed") return "failed";
  if (sendStatus === "sending") return "sending";
  if (sendStatus === "sent") return "sent";
  if (sendStatus === "scheduled") return "scheduled";
  return fallbackStatus || "pending";
}

function computeInvoiceRuleState({ invoice, templates, now = new Date() }) {
  if (invoice?.status === "paid") {
    const agingDays = getInvoiceAgingDays(invoice, now);
    return {
      enabled: false,
      agingDays,
      agingLabel: describeAgingDays(agingDays),
      currentTemplate: null,
      currentTemplateId: null,
      currentTemplateName: null,
      currentRuleOffsetDays: null,
      currentRuleLabel: null,
      nextTemplateId: null,
      nextTemplateName: null,
      nextRuleOffsetDays: null,
      nextRuleLabel: null,
      sendStatus: null,
      readyToSend: false,
      renderedFromRule: false,
      hasPendingStage: false,
      lastDispatch: null,
    };
  }

  const agingDays = getInvoiceAgingDays(invoice, now);
  const ruleTemplates = listRuleTemplates(templates);
  const dispatches = sortDispatchesByLatest(invoice?.ruleDispatches);

  const fallback = {
    enabled: ruleTemplates.length > 0,
    agingDays,
    agingLabel: describeAgingDays(agingDays),
    currentTemplate: null,
    currentTemplateId: null,
    currentTemplateName: null,
    currentRuleOffsetDays: null,
    currentRuleLabel: null,
    nextTemplateId: null,
    nextTemplateName: null,
    nextRuleOffsetDays: null,
    nextRuleLabel: null,
    sendStatus: "scheduled",
    readyToSend: false,
    renderedFromRule: false,
    hasPendingStage: false,
    lastDispatch: dispatches[0] || null,
  };

  if (!ruleTemplates.length || !Number.isInteger(agingDays)) {
    return {
      ...fallback,
      enabled: ruleTemplates.length > 0,
      sendStatus: null,
    };
  }

  let currentTemplate = null;
  let nextTemplate = null;

  for (const template of ruleTemplates) {
    if (template.ruleOffsetDays <= agingDays) {
      currentTemplate = template;
      continue;
    }

    nextTemplate = template;
    break;
  }

  if (!currentTemplate) {
    return {
      ...fallback,
      nextTemplateId: nextTemplate?.id || null,
      nextTemplateName: nextTemplate?.name || null,
      nextRuleOffsetDays: nextTemplate?.ruleOffsetDays ?? null,
      nextRuleLabel: nextTemplate ? describeRuleOffsetDays(nextTemplate.ruleOffsetDays) : null,
      sendStatus: "scheduled",
    };
  }

  const currentDispatches = dispatches.filter((dispatch) => dispatch.templateId === currentTemplate.id);
  const lastDispatch = currentDispatches[0] || null;
  const lastSuccess = currentDispatches.find((dispatch) => dispatch.status === "sent") || null;

  let sendStatus = "ready";
  if (lastDispatch?.status === "sending") {
    sendStatus = "sending";
  } else if (lastSuccess) {
    sendStatus = "sent";
  } else if (lastDispatch?.status === "failed") {
    sendStatus = "failed";
  }

  return {
    ...fallback,
    currentTemplate,
    currentTemplateId: currentTemplate.id,
    currentTemplateName: currentTemplate.name,
    currentRuleOffsetDays: currentTemplate.ruleOffsetDays,
    currentRuleLabel: describeRuleOffsetDays(currentTemplate.ruleOffsetDays),
    nextTemplateId: nextTemplate?.id || null,
    nextTemplateName: nextTemplate?.name || null,
    nextRuleOffsetDays: nextTemplate?.ruleOffsetDays ?? null,
    nextRuleLabel: nextTemplate ? describeRuleOffsetDays(nextTemplate.ruleOffsetDays) : null,
    sendStatus,
    readyToSend: sendStatus === "ready" || sendStatus === "failed",
    renderedFromRule: true,
    hasPendingStage: sendStatus === "ready" || sendStatus === "failed" || sendStatus === "sending",
    lastDispatch: lastDispatch || dispatches[0] || null,
  };
}

module.exports = {
  computeInvoiceRuleState,
  describeAgingDays,
  describeRuleOffsetDays,
  getInvoiceAgingDays,
  listRuleTemplates,
  mapRuleStatusToInvoiceStatus,
  normalizeRuleOffsetDays,
};
