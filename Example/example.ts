import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidNewsletter,
  isJidBroadcast,
  WAMessage,
  Browsers,
} from "../src"

import NodeCache from "node-cache"
import pino from "pino"
import { Boom } from "@hapi/boom"
import * as path from "path"

import { startServer, setSocket, updateStatus, updateQR } from "../server"

import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const AUTH_DIR = path.join(__dirname, "..", "baileys_auth_info")

const logger = pino({ level: "info" })

let serverBooted = false
let isReconnecting = false

function bootServerOnce() {
  if (serverBooted) return
  serverBooted = true
  startServer()
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

  const sock = makeWASocket({
    version,
    logger,
    browser: Browsers.macOS("Chrome"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  })

  logger.info(
    { registered: state.creds.registered },
    "REGISTERED CHECK"
  )

  logger.info(
    { hasRequestPairingCode: typeof (sock as any).requestPairingCode },
    "PAIRING METHOD"
  )

  // Gera código de pareamento
  if (!state.creds.registered) {
    try {
      const phoneNumber = "5535999428114"

      logger.info({ phoneNumber }, "REQUESTING PAIRING CODE")

      const code = await (sock as any).requestPairingCode(phoneNumber)

      logger.info({ code }, "PAIRING CODE")

      logger.info(
        "No celular: WhatsApp > Dispositivos conectados > Conectar dispositivo > Conectar com número/código"
      )
    } catch (e) {
      logger.error(e, "PAIRING CODE FAILED")
    }
  }

  bootServerOnce()

  setSocket(sock)

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (connection === "open") {
      updateStatus("connected")
      updateQR("")
      isReconnecting = false

      logger.info("✅ Conectado!")

      return
    }

    if (connection === "connecting") {
      logger.info("⏳ Conectando...")
      return
    }

    if (qr) {
      updateStatus("awaiting_scan")
      updateQR(qr)
      return
    }

    if (connection === "close") {
      updateStatus("disconnected")

      const statusCode =
        (lastDisconnect?.error as Boom | undefined)?.output?.statusCode

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      logger.warn(
        { connection, statusCode, shouldReconnect },
        "connection.update: close"
      )

      if (!shouldReconnect) {
        logger.error(
          "Logged out. Apague a pasta de auth e conecte novamente."
        )
        return
      }

      if (isReconnecting) {
        logger.warn("Reconexão já em andamento.")
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
  })

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

      if (text) {
        console.log("\n----- NOVA MSG -----")
        console.log("fromMe:", fromMe)
        console.log("pushName:", pushName)
        console.log("jid:", jid)
        console.log("id:", id)
        console.log("text:", text)
      }
    }
  })

  const shutdown = async () => {
    try {
      logger.info("Encerrando...")
      await sock.logout()
    } catch {}

    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

start().catch((err) => logger.error(err, "fatal error"))
