import { WebSocketServer, WebSocket } from 'ws'
import { ClientMsg, WsEvent } from '../types'

type WsHubHandlers = {
  onConnect?: (client: WebSocket) => void
  onClose?: (client: WebSocket, code: number, reason: string) => void
  onMessage?: (client: WebSocket, msg: ClientMsg) => void
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

function isClientMsg(value: unknown): value is ClientMsg {
  return Boolean(value && typeof value === 'object' && 'op' in value)
}

export class WsHub {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private handlers: WsHubHandlers

  constructor({ host, port, handlers }: { host: string; port: number; handlers: WsHubHandlers }) {
    this.wss = new WebSocketServer({ host, port })
    this.handlers = handlers

    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      this.handlers.onConnect?.(ws)

      ws.on('message', (buf) => {
        const msg = safeJsonParse(buf.toString('utf8'))
        if (!isClientMsg(msg)) return
        this.handlers.onMessage?.(ws, msg)
      })

      ws.on('close', (code, reason) => {
        this.clients.delete(ws)
        this.handlers.onClose?.(ws, code, reason.toString('utf8'))
      })
    })
  }

  get size() {
    return this.clients.size
  }

  send(client: WebSocket, msg: WsEvent): boolean {
    if (client.readyState !== client.OPEN) return false
    client.send(JSON.stringify(msg))
    return true
  }

  broadcast(msg: WsEvent): number {
    const payload = JSON.stringify(msg)
    let delivered = 0
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload)
        delivered += 1
      }
    }
    return delivered
  }
}
