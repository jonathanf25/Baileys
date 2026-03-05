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
  downloadMediaMessage,
} from "../src" // ✅ dentro do repo, use ../src

import NodeCache from "node-cache"
import pino from "pino"
import { Boom } from "@hapi/boom"
import * as path from "path"
import axios from "axios"

import { startServer, setSocket, updateStatus, updateQR } from "../server"
import { fileURLToPath } from "url"

// ✅ para salvar/transcrever áudio na VM
import * as fs from "fs/promises"
import * as os from "os"
import { randomUUID } from "crypto"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// pasta fixa: /Baileys/baileys_auth_info
const AUTH_DIR = path.join(__dirname, "..", "baileys_auth_info")

// ✅ Supabase ingest (Lovable)
const SUPABASE_INGEST_URL =
  "https://xfjwimdcbehviozfnpyz.supabase.co/functions/v1/wa-monitor-ingest"
const SUPABASE_API_KEY = "baileys-monitor-2026"

// ✅ Cache para não chamar groupMetadata toda mensagem
const groupCache = new NodeCache({ stdTTL: 3600 }) // 1 hora

// ✅ Config Whisper local (VM)
const WHISPER_BIN_DEFAULT = path.join(os.homedir(), "whisper.cpp", "main")
const WHISPER_MODEL_DEFAULT = path.join(os.homedir(), "whisper.cpp", "models", "ggml-small.bin")

const WHISPER_BIN = process.env.WHISPER_BIN || WHISPER_BIN_DEFAULT
const WHISPER_MODEL = process.env.WHISPER_MODEL || WHISPER_MODEL_DEFAULT
const WHISPER_LANG = process.env.WHISPER_LANG || "pt"

// ✅ evita travar o servidor transcrevendo muitos áudios ao mesmo tempo
let audioQueue: Promise<void> = Promise.resolve()

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

function isAudio(msg: WAMessage): boolean {
  const m: any = msg.message || {}
  return !!m.audioMessage
}

async function transcribeAudioBufferLocal(audioBuffer: Buffer): Promise<string | null> {
  // ✅ escreve temporário
  const tmpDir = os.tmpdir()
  const id = randomUUID()

  const inFile = path.join(tmpDir, `wa_audio_${id}.ogg`)
  const wavFile = path.join(tmpDir, `wa_audio_${id}.wav`)
  const outBase = path.join(tmpDir, `wa_audio_${id}_out`) // whisper gera outBase.txt

  try {
    await fs.writeFile(inFile, audioBuffer)

    // ✅ converte para wav 16k mono (melhor para transcrição)
    await execFileAsync("ffmpeg", ["-y", "-i", inFile, "-ar", "16000", "-ac", "1", wavFile])

    // ✅ roda whisper.cpp e gera .txt
    // flags comuns do whisper.cpp:
    // -m modelo, -f arquivo wav, -l idioma, -otxt gera txt, -of base de saída
    await execFileAsync(WHISPER_BIN, [
      "-m",
      WHISPER_MODEL,
      "-f",
      wavFile,
      "-l",
      WHISPER_LANG,
      "-otxt",
      "-of",
      outBase,
    ])

    const txtFile = `${outBase}.txt`
    const txt = await fs.readFile(txtFile, "utf-8")

    const transcript = (txt || "").trim()
    if (!transcript) return null

    return transcript
  } catch (e: any) {
    console.log("❌ Falha transcrevendo áudio local:", e?.message || e)
    return null
  } finally {
    // limpeza best-effort
    try {
      await fs.unlink(inFile)
    } catch {}
    try {
      await fs.unlink(wavFile)
    } catch {}
    try {
      await fs.unlink(`${outBase}.txt`)
    } catch {}
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    p.then((v) => {
      clearTimeout(t)
      resolve(v)
    }).catch((err) => {
      clearTimeout(t)
      reject(err)
    })
  })
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

    // Browser fingerprint: às vezes Windows ajuda em VM
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
      WHISPER_BIN,
      WHISPER_MODEL,
      WHISPER_LANG,
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

    // ✅ 2) CLOSE
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
      updateStatus("connecting" as any)
      logger.info("⏳ Conectando...")
    }

    // ✅ 4) QR (somente se modo QR)
    if (qr) {
      if (PAIR_MODE === "qr") {
        updateStatus("awaiting_scan")
        updateQR(qr)
      } else {
        updateStatus("pairing_code" as any)
        updateQR("")
      }
    }

    // ✅ 5) PAIRING CODE (somente se modo CODE e ainda não registrado)
    if (
      PAIR_MODE === "code" &&
      !state.creds.registered &&
      !pairingRequested &&
      typeof (sock as any).requestPairingCode === "function"
    ) {
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
        updateStatus("pairing_code" as any)
        updateQR("")
        await sleep(1200)

        logger.info({ phone: PAIR_PHONE }, "REQUESTING PAIRING CODE...")
        const code = await (sock as any).requestPairingCode(PAIR_PHONE)

        logger.info({ code }, "PAIRING CODE")
        logger.info(
          "No celular: WhatsApp > Dispositivos conectados > Conectar dispositivo > Conectar com número/código"
        )
      } catch (e) {
        pairingRequested = false
        logger.error(e, "PAIRING CODE FAILED")
      }
    }
  })

  /**
   * ✅ Escuta mensagens, MAS NÃO RESPONDE NADA.
   * ✅ Envia para Supabase (wa-monitor-ingest) para monitoramento.
   * ✅ Grupo: envia subject (nome do grupo).
   * ✅ Áudio: transcreve local na VM e envia transcript.
   */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return

    for (const msg of messages) {
      if (!msg.message) continue

      const jid = getBestJid(msg)
      if (!jid) continue

      if (isJidBroadcast(jid) || isJidNewsletter(jid)) continue

      const isGroup = jid.endsWith("@g.us")
      const isAudioMsg = isAudio(msg)

      const fromMe = !!msg.key?.fromMe
      const pushName = (msg as any).pushName || ""
      const text = getTextFromMessage(msg)
      const id = msg.key?.id || ""
      const tsRaw = (msg as any).messageTimestamp
      const ts = typeof tsRaw === "number" ? tsRaw : Number(tsRaw)

      // ✅ Número de quem enviou
      // - grupo: msg.key.participant -> "...@s.whatsapp.net" (às vezes pode vir LID)
      // - 1-a-1: jid
      const participantJid = (msg.key as any)?.participant || ""
      const senderPhone = isGroup
        ? String(participantJid).split("@")[0].replace(/\D/g, "")
        : String(jid).split("@")[0].replace(/\D/g, "")

      // ✅ Nome do grupo (com cache)
      let groupName = ""
      if (isGroup) {
        groupName = (groupCache.get(jid) as string) || ""
        if (!groupName) {
          try {
            const meta = await sock.groupMetadata(jid)
            groupName = meta?.subject || ""
            if (groupName) groupCache.set(jid, groupName)
          } catch {
            groupName = ""
          }
        }
      }

      // Logs (monitoramento local)
      console.log("\n----- NOVA MSG -----")
      console.log("fromMe:", fromMe)
      console.log("pushName:", pushName)
      console.log("jid:", jid)
      if (isGroup) console.log("groupName:", groupName || "(sem nome ainda)")
      console.log("senderPhone:", senderPhone || "(não encontrado)")
      console.log("id:", id)
      console.log("timestamp:", ts)

      if (isAudioMsg) {
        console.log("messageType: audio")
      } else if (text) {
        console.log("messageType: text")
        console.log("text:", text)
      } else {
        console.log("messageType: unknown")
        console.log("tipo:", Object.keys(msg.message || {}))
      }

      // ✅ transcript (somente áudio)
      let transcript: string | null = null

      if (isAudioMsg) {
        // enfileira para não travar CPU
        audioQueue = audioQueue.then(async () => {
          try {
            console.log("🎧 Baixando áudio para transcrição...")

            const media = (await downloadMediaMessage(
              msg,
              "buffer",
              {},
              {
                logger,
                reuploadRequest: sock.updateMediaMessage,
              }
            )) as Buffer

            // timeout para não travar o fluxo
            transcript = await withTimeout(transcribeAudioBufferLocal(media), 120000) // 120s

            if (transcript) {
              console.log("📝 Transcript (preview):", transcript.slice(0, 120))
            } else {
              console.log("📝 Transcript: (null)")
            }
          } catch (e: any) {
            console.log("❌ Falha no fluxo de transcrição:", e?.message || e)
            transcript = null
          }
        })

        // espera a transcrição terminar antes de enviar ingest desta mensagem
        try {
          await audioQueue
        } catch {
          // ignore
        }
      }

      // ✅ Envia para o Supabase ingest (Lovable espera esse formato)
      try {
        await axios.post(
          SUPABASE_INGEST_URL,
          {
            event: "messages.upsert",
            data: {
              jid: jid,
              sender_name: pushName,
              sender_phone: senderPhone, // ✅ obrigatório
              message_id: id,

              // ✅ Lovable: content separado / message_type separado
              content: isAudioMsg ? "" : text || "",
              message_type: isAudioMsg ? "audio" : "text",

              timestamp: new Date(ts * 1000).toISOString(),

              // ✅ Grupo: subject (nome do grupo)
              ...(isGroup && groupName ? { subject: groupName } : {}),

              // ✅ Áudio: transcript separado
              ...(isAudioMsg ? { transcript: transcript } : {}),
            },
          },
          {
            headers: {
              "Content-Type": "application/json",
              "x-api-key": SUPABASE_API_KEY,
            },
          }
        )

        console.log("✅ Ingest enviado para Supabase:", id)
      } catch (err: any) {
        console.log("❌ Erro ao enviar ingest para Supabase:", err?.message || err)
        console.log("➡️ Status:", err?.response?.status)
        console.log("➡️ Data:", err?.response?.data)
      }
    }
  })

  // ✅ SHUTDOWN ESTÁVEL: NÃO DESLOGA DO WHATSAPP
  const shutdown = async () => {
    try {
      logger.info("Encerrando (sem logout)...")
      try {
        await (sock as any)?.end?.()
      } catch {
        // ignore
      }
    } finally {
      process.exit(0)
    }
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

start().catch((err) => logger.error(err, "fatal error"))
