const path = require("node:path");
const fs = require("node:fs/promises");

function loadNodemailer() {
  try {
    return require("nodemailer");
  } catch {
    throw new Error("Dependência de e-mail não encontrada. Instale 'nodemailer' para habilitar o Gmail.");
  }
}

function normalizeAppPassword(value) {
  return String(value ?? "").trim();
}

function normalizeConfig(override = null) {
  const overrideConfig = override && typeof override === "object" ? override : {};
  const hasOverride = Boolean(override && typeof override === "object");
  const envUser = String(process.env.GMAIL_USER || "").trim();
  const envAppPassword = normalizeAppPassword(process.env.GMAIL_APP_PASSWORD || "");
  const envFromName = String(process.env.GMAIL_FROM_NAME || "V4 Cobranças").trim();

  const user = String(overrideConfig.user ?? envUser).trim();
  const appPassword = normalizeAppPassword(overrideConfig.appPassword ?? envAppPassword);
  const fromName = String(overrideConfig.fromName ?? envFromName ?? "V4 Cobranças").trim();
  const verifiedAt = overrideConfig.verifiedAt ?? null;

  return {
    user,
    appPassword,
    fromName,
    verifiedAt,
    hasCredentials: Boolean(user && appPassword),
    configured: Boolean(user && appPassword && (hasOverride ? verifiedAt : true)),
  };
}

function buildPasswordCandidates(appPassword) {
  const normalized = normalizeAppPassword(appPassword);
  if (!normalized) return [];

  const compact = normalized.replace(/\s+/g, "");
  return compact && compact !== normalized ? [normalized, compact] : [normalized];
}

function maskEmail(email) {
  const normalized = String(email || "").trim();
  const [localPart, domainPart] = normalized.split("@");
  if (!localPart || !domainPart) return null;

  if (localPart.length <= 2) {
    return `${localPart[0] || "*"}*@${domainPart}`;
  }

  return `${localPart.slice(0, 2)}***@${domainPart}`;
}

function buildFromField(config) {
  return config.fromName ? `"${config.fromName}" <${config.user}>` : config.user;
}

function createEmailService({ uploadsDir }) {
  let transport = null;
  let currentTransportKey = null;

  function getStatus(configOverride) {
    const config = normalizeConfig(configOverride);
    return {
      provider: "gmail",
      configured: config.configured,
      fromEmail: config.user || null,
      fromName: config.fromName || null,
      maskedEmail: maskEmail(config.user),
    };
  }

  function ensureConfigured(configOverride) {
    const config = normalizeConfig(configOverride);
    if (!config.hasCredentials) {
      throw new Error("Configure a conta Gmail e a senha nas Configurações para habilitar envios por e-mail.");
    }
    return config;
  }

  function getTransportForPassword(config, appPassword) {
    const transportKey = `${config.user}:${appPassword}`;
    if (transport && currentTransportKey === transportKey) {
      return { transport, config, appPassword };
    }

    transport = loadNodemailer().createTransport({
      service: "gmail",
      auth: {
        user: config.user,
        pass: appPassword,
      },
    });
    currentTransportKey = transportKey;
    return { transport, config, appPassword };
  }

  function getTransport(configOverride) {
    const config = ensureConfigured(configOverride);
    return getTransportForPassword(config, config.appPassword);
  }

  async function resolveAttachments({ attachments, attachmentRelativePath, attachmentName }) {
    const source = Array.isArray(attachments) && attachments.length
      ? attachments
      : attachmentRelativePath
        ? [{ filename: attachmentRelativePath, originalName: attachmentName || path.basename(attachmentRelativePath) }]
        : [];

    const resolved = [];
    for (const attachment of source) {
      const relativePath = String(attachment?.filename || "").trim();
      if (!relativePath) continue;

      const filePath = path.join(uploadsDir, relativePath);
      // eslint-disable-next-line no-await-in-loop
      await fs.access(filePath);
      resolved.push({
        filename: String(attachment?.originalName || "").trim() || path.basename(filePath),
        path: filePath,
      });
    }

    return resolved;
  }

  async function sendMessage({ to, subject, text, html, attachments, attachmentRelativePath, attachmentName }, configOverride) {
    const normalizedTo = String(to || "").trim();
    const normalizedSubject = String(subject || "").trim();

    if (!normalizedTo) throw new Error("Destinatário de e-mail não informado.");
    if (!normalizedSubject) throw new Error("Assunto do e-mail não informado.");
    if (!String(text || "").trim() && !String(html || "").trim()) {
      throw new Error("Conteúdo do e-mail não informado.");
    }

    const { transport, config } = getTransport(configOverride);
    const resolvedAttachments = await resolveAttachments({ attachments, attachmentRelativePath, attachmentName });

    const info = await transport.sendMail({
      from: buildFromField(config),
      to: normalizedTo,
      subject: normalizedSubject,
      text: String(text || "").trim() || undefined,
      html: String(html || "").trim() || undefined,
      attachments: resolvedAttachments,
    });

    return {
      messageId: info?.messageId || null,
      accepted: Array.isArray(info?.accepted) ? info.accepted : [],
      rejected: Array.isArray(info?.rejected) ? info.rejected : [],
    };
  }

  async function verifyConnection(configOverride) {
    const config = ensureConfigured(configOverride);
    const candidates = buildPasswordCandidates(config.appPassword);
    let lastError = null;

    for (const candidate of candidates) {
      try {
        const { transport } = getTransportForPassword(config, candidate);
        await transport.verify();
        return {
          provider: "gmail",
          configured: true,
          fromEmail: config.user || null,
          fromName: config.fromName || null,
          maskedEmail: maskEmail(config.user),
          appPassword: candidate,
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Não foi possível autenticar no Gmail.");
  }

  return {
    getStatus,
    sendMessage,
    verifyConnection,
  };
}

module.exports = {
  buildPasswordCandidates,
  createEmailService,
  maskEmail,
  normalizeAppPassword,
  normalizeConfig,
};
