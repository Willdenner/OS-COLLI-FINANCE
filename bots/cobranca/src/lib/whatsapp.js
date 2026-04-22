const path = require("node:path");
const fs = require("node:fs/promises");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const { AUTH_DIR, isBroadcastChatId, isDirectChatId, normalizePhoneToDigits, onlyDigits, truncateText } = require("./domain");

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function guessChromeExecutablePath() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function buildChromiumLaunchArgs() {
  const defaults = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-zygote",
    "--password-store=basic",
    "--use-mock-keychain",
  ];

  const extraArgs = String(process.env.WHATSAPP_CHROMIUM_ARGS || "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set([...defaults, ...extraArgs]));
}

function buildPuppeteerOptions(executablePath) {
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: buildChromiumLaunchArgs(),
  };
}

function createWhatsAppService({ uploadsDir, onInboundMessage }) {
  let client = null;
  let initPromise = null;
  let status = "idle";
  let lastQr = null;
  let clientInfo = null;
  let lastReadyAt = null;
  let reconnectTimer = null;
  let pendingSends = 0;
  let sendChain = Promise.resolve();
  let shuttingDown = false;
  const seenInboundKeys = new Map();
  const numberIdCache = new Map();

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function cleanupSeenInboundKeys() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, timestamp] of seenInboundKeys.entries()) {
      if (timestamp < cutoff) seenInboundKeys.delete(key);
    }
  }

  function rememberInboundMessage(message) {
    const externalId = message?.id?._serialized;
    const fallback = [
      String(message?.from ?? ""),
      truncateText(message?.body, 240),
      Number(message?.timestamp ?? 0),
      String(message?.type ?? ""),
    ].join("|");
    const key = externalId || fallback;
    if (!key) return false;

    cleanupSeenInboundKeys();
    if (seenInboundKeys.has(key)) return true;
    seenInboundKeys.set(key, Date.now());
    return false;
  }

  function scheduleReconnect(delayMs = 3000) {
    if (shuttingDown || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnect().catch((err) => {
        status = "reconnect_failed";
        // eslint-disable-next-line no-console
        console.error("[wa] reconnect failed:", err?.message || err);
        scheduleReconnect(8000);
      });
    }, delayMs);
  }

  async function attachListeners(instance) {
    instance.on("qr", (qr) => {
      lastQr = qr;
      status = "needs_qr";
    });

    instance.on("ready", () => {
      status = "ready";
      lastQr = null;
      lastReadyAt = new Date().toISOString();
      clearReconnectTimer();
    });

    instance.on("authenticated", () => {
      status = "authenticated";
    });

    instance.on("auth_failure", (message) => {
      status = "auth_failure";
      // eslint-disable-next-line no-console
      console.error("[wa] auth failure:", message || "sem detalhes");
    });

    instance.on("disconnected", (reason) => {
      status = "disconnected";
      clientInfo = null;
      // eslint-disable-next-line no-console
      console.warn("[wa] disconnected:", reason || "sem motivo informado");
      scheduleReconnect(2500);
    });

    async function handleInbound(message, source) {
      if (!message || message.fromMe) return;
      if (typeof onInboundMessage !== "function") return;

      const fromId = String(message.from ?? "");
      if (!fromId || !isDirectChatId(fromId) || isBroadcastChatId(fromId)) return;
      if (rememberInboundMessage(message)) return;

      let fromDigits = onlyDigits(fromId.split("@")[0]);
      let messageType = String(message.type || "chat");

      try {
        const contact = await message.getContact();
        const contactNumber = contact?.number || contact?.id?.user || "";
        const contactDigits = onlyDigits(contactNumber);
        if (contactDigits) fromDigits = contactDigits;
      } catch {
        // ignore
      }

      let body = truncateText(message.body, 4000);
      if (!body && message.hasMedia) {
        body = `[Mídia recebida: ${messageType}]`;
      }
      if (!body) return;

      const timestampMs = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();

      // eslint-disable-next-line no-console
      console.log(
        `[inbound:${source}] from=${fromDigits || fromId} type=${messageType} body=${JSON.stringify(body).slice(0, 200)}`
      );

      await onInboundMessage({
        externalId: message.id?._serialized || null,
        fromPhone: fromDigits,
        body,
        timestampMs,
        fromId,
        messageType,
      });
    }

    instance.on("message", async (message) => {
      try {
        await handleInbound(message, "message");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Inbound handler error (message):", err?.message || err);
      }
    });

    instance.on("message_create", async (message) => {
      try {
        await handleInbound(message, "message_create");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Inbound handler error (message_create):", err?.message || err);
      }
    });
  }

  async function buildClient() {
    const executablePath = await guessChromeExecutablePath();
    // eslint-disable-next-line no-console
    console.log("[wa] chrome executable:", executablePath || "default puppeteer resolution");
    const instance = new Client({
      authStrategy: new LocalAuth({
        dataPath: AUTH_DIR,
      }),
      puppeteer: buildPuppeteerOptions(executablePath),
    });

    await attachListeners(instance);
    return instance;
  }

  async function init() {
    if (initPromise) return initPromise;

    status = "initializing";
    initPromise = (async () => {
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.mkdir(AUTH_DIR, { recursive: true });
      client = await buildClient();
      await client.initialize();
    })()
      .catch((err) => {
        status = "init_failed";
        throw err;
      })
      .finally(() => {
        initPromise = null;
      });

    return initPromise;
  }

  function isDetachedFrameError(err) {
    const msg = String(err?.message || err || "");
    return (
      msg.includes("Attempted to use detached Frame") ||
      msg.includes("Execution context was destroyed") ||
      msg.includes("Target closed") ||
      msg.includes("Session closed")
    );
  }

  async function reconnect() {
    if (shuttingDown) return;
    if (initPromise) return initPromise;

    try {
      status = "reconnecting";
      clearReconnectTimer();
      // eslint-disable-next-line no-console
      console.log("[wa] reconnecting...");
      try {
        await client?.destroy();
      } catch {
        // ignore
      }
      client = null;
      clientInfo = null;
      lastQr = null;
      numberIdCache.clear();
      await init();
      // eslint-disable-next-line no-console
      console.log("[wa] reconnected");
    } catch (err) {
      status = "reconnect_failed";
      throw err;
    }
  }

  async function shutdown() {
    shuttingDown = true;
    clearReconnectTimer();
    try {
      await client?.destroy();
    } catch {
      // ignore
    } finally {
      client = null;
      status = "stopped";
    }
  }

  async function logout() {
    clearReconnectTimer();
    shuttingDown = true;

    // eslint-disable-next-line no-console
    console.log("[wa] logout: disconnecting and clearing session...");

    try {
      await client?.logout();
    } catch {
      // ignore – may fail if already disconnected
    }
    try {
      await client?.destroy();
    } catch {
      // ignore
    }

    client = null;
    clientInfo = null;
    lastQr = null;
    lastReadyAt = null;
    numberIdCache.clear();
    status = "idle";

    // Remove session files so the next init requires a fresh QR scan
    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }

    // eslint-disable-next-line no-console
    console.log("[wa] logout: session cleared, re-initializing for new QR...");
    shuttingDown = false;
    await init();
  }

  async function getStatus() {
    try {
      const info = client?.info;
      clientInfo = info ? { wid: info.wid?._serialized, pushname: info.pushname } : null;
    } catch {
      clientInfo = null;
    }

    return {
      status,
      hasQr: Boolean(lastQr),
      clientInfo,
      queueSize: pendingSends,
      lastReadyAt,
    };
  }

  async function getQrDataUrl() {
    if (!lastQr) return null;
    return QRCode.toDataURL(lastQr, { margin: 1, width: 280 });
  }

  async function resolveChatId(digits) {
    const cached = numberIdCache.get(digits);
    if (cached && cached.expiresAt > Date.now()) return cached.chatId;

    const numberId = await client.getNumberId(digits);
    if (!numberId?._serialized) return null;

    numberIdCache.set(digits, {
      chatId: numberId._serialized,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    });

    return numberId._serialized;
  }

  function normalizeOutgoingAttachments({ attachments, attachmentRelativePath, attachmentName }) {
    if (Array.isArray(attachments) && attachments.length) {
      return attachments
        .map((attachment) => {
          const filename = String(attachment?.filename || "").trim();
          if (!filename) return null;
          return {
            filename,
            originalName: String(attachment?.originalName || "").trim() || path.basename(filename),
          };
        })
        .filter(Boolean);
    }

    if (!attachmentRelativePath) return [];
    return [
      {
        filename: attachmentRelativePath,
        originalName: String(attachmentName || "").trim() || path.basename(attachmentRelativePath),
      },
    ];
  }

  async function sendMessage({ phone, text, attachments, attachmentRelativePath, attachmentName }) {
    pendingSends += 1;

    const execute = async () => {
      const defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || "55";
      const digits = normalizePhoneToDigits(phone, { defaultCountryCode });
      if (!digits) throw new Error("Telefone inválido.");

      if (status !== "ready" && status !== "authenticated") {
        throw new Error("WhatsApp não está pronto (escaneie o QR Code).");
      }

      const chatId = await resolveChatId(digits);
      if (!chatId) {
        throw new Error(
          "Número não encontrado no WhatsApp. Dica: salve com DDI+DDD (ex.: 5511999999999) e tente novamente."
        );
      }

      const trimmedText = truncateText(text, 4000) || "";
      const outgoingAttachments = normalizeOutgoingAttachments({ attachments, attachmentRelativePath, attachmentName });
      if (!trimmedText && !outgoingAttachments.length) {
        throw new Error("Informe uma mensagem ou anexe pelo menos um arquivo.");
      }

      const performSend = async () => {
        if (!outgoingAttachments.length) {
          const sentMessage = await client.sendMessage(chatId, trimmedText);
          return {
            chatId,
            messageId: sentMessage?.id?._serialized || null,
            messageIds: sentMessage?.id?._serialized ? [sentMessage.id._serialized] : [],
          };
        }

        const messageIds = [];
        for (let index = 0; index < outgoingAttachments.length; index += 1) {
          const attachment = outgoingAttachments[index];
          const absolutePath = path.join(uploadsDir, attachment.filename);
          // eslint-disable-next-line no-await-in-loop
          const exists = await fileExists(absolutePath);
          if (!exists) {
            throw new Error(`Anexo não encontrado no servidor: ${attachment.originalName || attachment.filename}`);
          }

          const media = MessageMedia.fromFilePath(absolutePath);
          // eslint-disable-next-line no-await-in-loop
          const sentMessage = await client.sendMessage(chatId, media, {
            caption: index === 0 ? trimmedText || undefined : undefined,
          });
          if (sentMessage?.id?._serialized) {
            messageIds.push(sentMessage.id._serialized);
          }
        }

        return {
          chatId,
          messageId: messageIds[0] || null,
          messageIds,
        };
      };

      try {
        return await performSend();
      } catch (err) {
        if (isDetachedFrameError(err)) {
          // eslint-disable-next-line no-console
          console.warn("[wa] detached frame detected, reconnecting before retry...");
          await reconnect();
          return performSend();
        }
        throw err;
      }
    };

    const queueStart = sendChain.catch(() => {});
    const currentRun = queueStart.then(execute);
    sendChain = currentRun.catch(() => {}).finally(() => {
      pendingSends = Math.max(0, pendingSends - 1);
    });

    return currentRun;
  }

  return { getQrDataUrl, getStatus, init, logout, sendMessage, shutdown };
}

module.exports = {
  createWhatsAppService,
  buildChromiumLaunchArgs,
  buildPuppeteerOptions,
};
