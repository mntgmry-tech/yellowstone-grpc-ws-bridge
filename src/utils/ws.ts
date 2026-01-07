import { IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { ServerOptions } from 'ws'
import { ClientMsg, WsEvent } from '../types'

type WsHubHandlers = {
  onConnect?: (client: WebSocket, request?: IncomingMessage) => void
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

  constructor({
    host,
    port,
    handlers,
    verifyClient
  }: {
    host: string
    port: number
    handlers: WsHubHandlers
    verifyClient?: ServerOptions['verifyClient']
  }) {
    this.wss = new WebSocketServer({ host, port, verifyClient })
    this.handlers = handlers

    this.wss.on('connection', (ws, request) => {
      this.clients.add(ws)
      this.handlers.onConnect?.(ws, request)

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
