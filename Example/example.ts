// Example/example.ts
import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidNewsletter,
  isJidBroadcast,
  WAMessage,
  Browsers,
} from "../src" // ✅ dentro do repo, use ../src

import NodeCache from "node-cache"
import pino from "pino"
import { Boom } from "@hapi/boom"
import * as path from "path"

// ✅ servidor HTTP + status/qr + socket atual
import { startServer, setSocket, updateStatus, updateQR } from "../server"

import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// pasta fixa: /Baileys/baileys_auth_info
const AUTH_DIR = path.join(__dirname, "..", "baileys_auth_info")

const logger = pino({ level: "info" })

let serverBooted = false
let isReconnecting = false

// ✅ Controle de pareamento
// PAIR_MODE=code -> pairing code
// PAIR_MODE=qr   -> qr code
const PAIR_MODE = (process.env.PAIR_MODE || "code").toLowerCase() as "code" | "qr"
const PAIR_PHONE = (process.env.PAIR_PHONE || "").replace(/\D/g, "") // só números

let pairingRequested = false // evita chamar requestPairingCode em loop

function bootServerOnce() {
  if (serverBooted) return
  serverBooted = true
  startServer()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function getTextFromMessage(msg: WAMessage): string {
  const m = msg.message
  if (!m) return ""

  const conversation = (m as any).conversation
  if (conversation) return conversation

  const extended = (m as any).extendedTextMessage?.text
  if (extended) return extended

  const imageCaption = (m as any).imageMessage?.caption
  if (imageCaption) return imageCaption

  const videoCaption = (m as any).videoMessage?.caption
  if (videoCaption) return videoCaption

  const docCaption = (m as any).documentMessage?.caption
  if (docCaption) return docCaption

  const btn = (m as any).buttonsResponseMessage?.selectedDisplayText
  if (btn) return btn

  const list = (m as any).listResponseMessage?.title
  if (list) return list

  return ""
}

function getBestJid(msg: WAMessage): string {
  const key: any = msg.key || {}
  return key.remoteJidAlt || key.remoteJid || ""
}

async function start() {
  const msgRetryCounterCache = new NodeCache()
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const { version, isLatest } = await fetchLatestBaileysVersion()
  logger.info({ version, isLatest }, "Using WA version")

  pairingRequested = false // reset a cada start()

  const sock = makeWASocket({
    version,
    logger,

    // ⚠️ printQRInTerminal foi deprecated; vamos usar connection.update -> qr
    // printQRInTerminal: true,

    // Browser fingerprint: às vezes Windows ajuda em VM
    // browser: Browsers.macOS("Chrome"),
    browser: ["Windows", "Chrome", "123.0"] as any,

    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },

    msgRetryCounterCache,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  })

  bootServerOnce()
  setSocket(sock)

  sock.ev.on("creds.update", saveCreds)

  logger.info(
    {
      PAIR_MODE,
      registered: state.creds.registered,
      hasRequestPairingCode: typeof (sock as any).requestPairingCode,
      AUTH_DIR,
    },
    "BOOT CONFIG"
  )

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    // ✅ 1) OPEN
    if (connection === "open") {
      updateStatus("connected")
      updateQR("")
      isReconnecting = false
      pairingRequested = false
      logger.info("✅ Conectado!")
      return
    }

    // ✅ 2) CLOSE (antes do QR, para não engolir reconexão)
    if (connection === "close") {
      updateStatus("disconnected")

      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      logger.warn({ connection, statusCode, shouldReconnect }, "connection.update: close")

      if (!shouldReconnect) {
        logger.error("Logged out. Apague a pasta de auth e conecte de novo.")
        return
      }

      if (isReconnecting) {
        logger.warn("Reconexão já em andamento, ignorando close duplicado.")
        return
      }

      isReconnecting = true

      setTimeout(() => {
        start().catch((e) => {
          isReconnecting = false
          logger.error(e, "reconnect failed")
        })
      }, 1200)

      return
    }

    // ✅ 3) CONNECTING
    if (connection === "connecting") {
      updateStatus("connecting")
      logger.info("⏳ Conectando...")
      // continua para possível pairing code
    }

    // ✅ 4) QR (somente se modo QR)
    if (qr) {
      if (PAIR_MODE === "qr") {
        updateStatus("awaiting_scan")
        updateQR(qr)
      } else {
        // Se estiver em modo code, não precisamos expor QR
        updateStatus("pairing_code")
        updateQR("")
      }
      // continua para possível pairing code
    }

    // ✅ 5) PAIRING CODE (somente se modo CODE e ainda não registrado)
    // Chamamos aqui (no connection.update) para evitar 428 "Connection Closed" por chamar cedo demais.
    if (
      PAIR_MODE === "code" &&
      !state.creds.registered &&
      !pairingRequested &&
      typeof (sock as any).requestPairingCode === "function"
    ) {
      // Só tenta quando já entrou no fluxo de conexão (connecting ou qr recebido)
      const inFlow = connection === "connecting" || !!qr
      if (!inFlow) return

      if (!PAIR_PHONE) {
        logger.error(
          "PAIR_MODE=code mas PAIR_PHONE não foi informado. Ex: PAIR_PHONE=5535999428114"
        )
        return
      }

      pairingRequested = true

      try {
        updateStatus("pairing_code")
        updateQR("")

        // Pequeno delay ajuda MUITO em VM (evita 428)
        await sleep(1200)

        logger.info({ phone: PAIR_PHONE }, "REQUESTING PAIRING CODE...")
        const code = await (sock as any).requestPairingCode(PAIR_PHONE)

        logger.info({ code }, "PAIRING CODE")
        logger.info(
          "No celular: WhatsApp > Dispositivos conectados > Conectar dispositivo > Conectar com número/código"
        )
      } catch (e) {
        // Permite tentar novamente após reconectar
        pairingRequested = false
        logger.error(e, "PAIRING CODE FAILED")
      }
    }
  })

  /**
   * ✅ Escuta mensagens, MAS NÃO RESPONDE NADA.
   */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return

    for (const msg of messages) {
      if (!msg.message) continue

      const jid = getBestJid(msg)
      if (!jid) continue

      if (isJidBroadcast(jid) || isJidNewsletter(jid)) continue

      const fromMe = !!msg.key?.fromMe
      const pushName = (msg as any).pushName || ""
      const text = getTextFromMessage(msg)
      const id = msg.key?.id || ""
      const tsRaw = (msg as any).messageTimestamp
      const ts = typeof tsRaw === "number" ? tsRaw : Number(tsRaw)

      if (text) {
        console.log("\n----- NOVA MSG -----")
        console.log("fromMe:", fromMe)
        console.log("pushName:", pushName)
        console.log("jid:", jid)
        console.log("id:", id)
        console.log("timestamp:", ts)
        console.log("text:", text)
      } else {
        console.log("\n----- NOVA MSG (sem texto) -----")
        console.log("fromMe:", fromMe)
        console.log("pushName:", pushName)
        console.log("jid:", jid)
        console.log("id:", id)
        console.log("timestamp:", ts)
        console.log("tipo:", Object.keys(msg.message || {}))
      }
    }
  })

  const shutdown = async () => {
    try {
      logger.info("Encerrando...")
      await sock.logout()
    } catch {
      // ignore
    } finally {
      process.exit(0)
    }
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

start().catch((err) => logger.error(err, "fatal error"))
