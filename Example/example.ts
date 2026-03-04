// Example/example.ts
import makeWASocket, {
  AnyMessageContent,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isJidNewsletter,
  isJidBroadcast,
  WAMessage,
  Browsers,
} from '../src' // se der erro aqui, troque para: from '@whiskeysockets/baileys'
import NodeCache from 'node-cache'
import pino from 'pino'
import { Boom } from '@hapi/boom'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Ajuste aqui onde quer salvar a sessão (QR/credenciais)
 */
const AUTH_DIR = path.join(process.cwd(), 'baileys_auth_info')

const logger = pino({
  level: 'info', // troque para 'debug' se quiser mais logs
})

function getTextFromMessage(msg: WAMessage): string {
  const m = msg.message
  if (!m) return ''

  // texto simples
  const conversation = (m as any).conversation
  if (conversation) return conversation

  // texto em mensagem "extendida"
  const extended = (m as any).extendedTextMessage?.text
  if (extended) return extended

  // legenda de imagem/vídeo/documento
  const imageCaption = (m as any).imageMessage?.caption
  if (imageCaption) return imageCaption

  const videoCaption = (m as any).videoMessage?.caption
  if (videoCaption) return videoCaption

  const docCaption = (m as any).documentMessage?.caption
  if (docCaption) return docCaption

  // botão/lista/respostas interativas (varia por versão)
  const btn = (m as any).buttonsResponseMessage?.selectedDisplayText
  if (btn) return btn

  const list = (m as any).listResponseMessage?.title
  if (list) return list

  return ''
}

function getBestJid(msg: WAMessage): string {
  // Alguns eventos vêm com remoteJidAlt preenchido (quando WA usa LID)
  const key: any = msg.key || {}
  return key.remoteJidAlt || key.remoteJid || ''
}

async function start() {
  // cache para retries
  const msgRetryCounterCache = new NodeCache()

  // estado de auth
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const { version, isLatest } = await fetchLatestBaileysVersion()
  logger.info({ version, isLatest }, 'Using WA version')

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    syncFullHistory: false, // geralmente não precisa puxar histórico
    generateHighQualityLinkPreview: false,
  })

  // sempre salvar creds quando mudar
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      logger.warn(
        { connection, statusCode, shouldReconnect },
        'connection.update: close'
      )

      if (shouldReconnect) {
        start().catch((e) => logger.error(e, 'reconnect failed'))
      } else {
        logger.error('Logged out. Apague a pasta de auth e conecte de novo.')
      }
    } else if (connection === 'open') {
      logger.info('✅ Conectado! Agora só vou ESCUTAR mensagens (sem responder).')
    } else if (connection === 'connecting') {
      logger.info('⏳ Conectando...')
    }
  })

  /**
   * Escuta novas mensagens.
   * IMPORTANTE: não responde nada!
   */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (!msg.message) continue

      const jid = getBestJid(msg)
      if (!jid) continue

      // ignora broadcast/newsletter (opcional)
      if (isJidBroadcast(jid) || isJidNewsletter(jid)) continue

      const fromMe = !!msg.key?.fromMe
      const pushName = (msg as any).pushName || ''
      const text = getTextFromMessage(msg)
      const id = msg.key?.id || ''
      const ts = (msg as any).messageTimestamp

      // Se quiser ignorar mensagens enviadas por você mesmo:
      // if (fromMe) continue

      if (text) {
        console.log('\n----- NOVA MSG -----')
        console.log('fromMe:', fromMe)
        console.log('pushName:', pushName)
        console.log('jid:', jid)
        console.log('id:', id)
        console.log('timestamp:', ts)
        console.log('text:', text)
      } else {
        console.log('\n----- NOVA MSG (sem texto) -----')
        console.log('fromMe:', fromMe)
        console.log('pushName:', pushName)
        console.log('jid:', jid)
        console.log('id:', id)
        console.log('timestamp:', ts)
        console.log('tipo:', Object.keys(msg.message || {}))
      }

      /**
       * ⚠️ NÃO enviar nada aqui.
       * Quando você integrar na plataforma, você vai chamar:
       * await sock.sendMessage(jid, { text: '...' })
       */
    }
  })

  /**
   * Encerramento limpo
   */
  const shutdown = async () => {
    try {
      logger.info('Encerrando...')
      await sock.logout()
    } catch (e) {
      // ignore
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start().catch((err) => logger.error(err, 'fatal error'))