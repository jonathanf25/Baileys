// server.ts — Ajustado para o contrato do Lovable
// ✅ Mantém WhatsApp como MONITORAMENTO (nenhuma resposta automática aqui)
// ✅ Expõe: GET /status, GET /qr, POST /send
// ✅ Mantém: GET /health e POST /send-message (compatibilidade)

import express from "express"
import cors from "cors"

let serverStarted = false
let currentSock: any = null

// Incluí "connecting" porque você já viu esse status no /status.
// Isso evita inconsistência e erro de tipagem.
export type ConnStatus = "connected" | "disconnected" | "awaiting_scan" | "connecting"
let connectionStatus: ConnStatus = "disconnected"
let qrCode = ""

const app = express()
app.use(cors())
app.use(express.json())

// Funções chamadas pelo Baileys (em outro arquivo)
export function updateStatus(status: ConnStatus) {
  connectionStatus = status
}

export function updateQR(qr: string) {
  qrCode = qr
}

export function setSocket(sock: any) {
  currentSock = sock
}

// Rotas
app.get("/health", (_req, res) => res.send("ok"))

app.get("/status", (_req, res) => {
  res.json({ status: connectionStatus })
})

// Contrato Lovable: GET /qr -> { "qr_code": "..." }
// Se não tiver QR, retorna null (mais claro para o frontend).
// (Opcional) também retorna "qr" para compatibilidade com versões antigas.
app.get("/qr", (_req, res) => {
  const value = qrCode?.trim() ? qrCode : null
  return res.json({ qr_code: value, qr: value })
})

// Contrato Lovable: POST /send
// Body: { "jid": "5511...@s.whatsapp.net", "text": "mensagem" }
// Resp: { "success": true, "messageId": "..." }
app.post("/send", async (req, res) => {
  try {
    const { jid, text } = req.body ?? {}

    if (typeof jid !== "string" || typeof text !== "string" || !jid.trim() || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "jid e text devem ser strings não vazias",
      })
    }

    // Evita tentar enviar quando a sessão não está pronta
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

// Compatibilidade (rota antiga)
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
