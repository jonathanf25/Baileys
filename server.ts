import express from "express"
import cors from "cors"

let serverStarted = false
let currentSock: any = null

type ConnStatus = "connected" | "disconnected" | "awaiting_scan"
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

// ✅ Registra rotas UMA VEZ (fora do startServer)
app.get("/health", (_req, res) => res.send("ok"))

app.get("/status", (_req, res) => {
  res.json({ status: connectionStatus })
})

app.get("/qr", (_req, res) => {
  res.json({ qr: qrCode })
})

app.post("/send-message", async (req, res) => {
  try {
    const { jid, text } = req.body ?? {}

    if (typeof jid !== "string" || typeof text !== "string" || !jid.trim() || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "jid e text devem ser strings não vazias",
      })
    }

    // ✅ evita tentar enviar quando a sessão não está pronta
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

    return res.json({
      success: true,
      messageId: msg?.key?.id,
    })
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