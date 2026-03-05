// server.ts — contrato Lovable + endpoint de grupos
import express from "express"
import cors from "cors"

let serverStarted = false
let currentSock: any = null

export type ConnStatus = "connected" | "disconnected" | "awaiting_scan" | "connecting" | "pairing_code"
let connectionStatus: ConnStatus = "disconnected"
let qrCode = ""

const app = express()
app.use(cors())
app.use(express.json())

export function updateStatus(status: ConnStatus) {
  connectionStatus = status
}

export function updateQR(qr: string) {
  qrCode = qr
}

export function setSocket(sock: any) {
  currentSock = sock
}

// ✅ Rotas base
app.get("/health", (_req, res) => res.send("ok"))

app.get("/status", (_req, res) => {
  res.json({ status: connectionStatus })
})

app.get("/qr", (_req, res) => {
  res.json({ qr_code: qrCode })
})

// ✅ NOVO: endpoint para o Lovable buscar nome real do grupo
// GET /groups/:jid  -> { subject: "Nome do Grupo" }
app.get("/groups/:jid", async (req, res) => {
  try {
    const jidParam = String(req.params.jid || "").trim()

    if (!jidParam) {
      return res.status(400).json({ error: "jid obrigatório" })
    }

    // o Lovable pode mandar URL-encoded
    const jid = decodeURIComponent(jidParam)

    if (!jid.endsWith("@g.us")) {
      return res.status(400).json({ error: "jid não parece ser grupo (@g.us)" })
    }

    if (connectionStatus !== "connected") {
      return res.status(503).json({
        error: `whatsapp não está conectado (status=${connectionStatus})`,
      })
    }

    if (!currentSock || typeof currentSock.groupMetadata !== "function") {
      return res.status(503).json({ error: "socket ainda não está pronto" })
    }

    const meta = await currentSock.groupMetadata(jid)
    const subject = meta?.subject || ""

    return res.json({ subject })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "erro ao buscar grupo" })
  }
})

// ✅ Contrato Lovable: POST /send
app.post("/send", async (req, res) => {
  try {
    const { jid, text } = req.body ?? {}

    if (typeof jid !== "string" || typeof text !== "string" || !jid.trim() || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "jid e text devem ser strings não vazias",
      })
    }

    if (connectionStatus !== "connected") {
      return res.status(503).json({
        success: false,
        error: `whatsapp não está conectado (status=${connectionStatus})`,
      })
    }

    if (!currentSock) {
      return res.status(503).json({
        success: false,
        error: "socket ainda não está pronto",
      })
    }

    const msg = await currentSock.sendMessage(jid, { text })
    return res.json({ success: true, messageId: msg?.key?.id })
  } catch (e: any) {
    return res.status(500).json({
      success: false,
      error: e?.message || "erro ao enviar mensagem",
    })
  }
})

// (Opcional) compatibilidade antiga
app.post("/send-message", async (req, res) => {
  try {
    const { jid, text } = req.body ?? {}

    if (typeof jid !== "string" || typeof text !== "string" || !jid.trim() || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "jid e text devem ser strings não vazias",
      })
    }

    if (connectionStatus !== "connected") {
      return res.status(503).json({
        success: false,
        error: `whatsapp não está conectado (status=${connectionStatus})`,
      })
    }

    if (!currentSock) {
      return res.status(503).json({
        success: false,
        error: "socket ainda não está pronto",
      })
    }

    const msg = await currentSock.sendMessage(jid, { text })
    return res.json({ success: true, messageId: msg?.key?.id })
  } catch (e: any) {
    return res.status(500).json({
      success: false,
      error: e?.message || "erro ao enviar mensagem",
    })
  }
})

export function startServer(port = 3001) {
  if (serverStarted) return
  serverStarted = true

  app.listen(port, () => {
    console.log(`Servidor HTTP rodando na porta ${port}`)
  })
}
