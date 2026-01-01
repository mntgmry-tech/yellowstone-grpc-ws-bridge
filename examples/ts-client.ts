import dotenv from 'dotenv'
import { WebSocket } from 'ws'

dotenv.config()

const WS_URL = process.env.BRIDGE_WS_URL ?? 'ws://127.0.0.1:8787'
const MAX_PAYLOAD = 64 * 1024 * 1024

const WATCH_ACCOUNTS: string[] = [
  // 'YourAtaPubkeyHere'
]

const WATCH_MINTS: string[] = [
  // 'YourMintPubkeyHere'
]

type ClientMsg =
  | { op: 'setAccounts'; accounts: string[] }
  | { op: 'setMints'; mints: string[] }
  | { op: 'getState' }
  | { op: 'ping' }

type StatusEvent = {
  type: 'status'
  now: string
  grpcConnected: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
  watchedAccounts: number
  watchedMints: number
}

type TransactionEvent = {
  type: 'transaction'
  commitment: 'processed' | 'confirmed'
  slot: number
  signature: string
  tokenBalanceChanges: unknown[]
}

type WsEvent = StatusEvent | TransactionEvent

function send(ws: WebSocket, msg: ClientMsg) {
  ws.send(JSON.stringify(msg))
}

const ws = new WebSocket(WS_URL, { maxPayload: MAX_PAYLOAD })

ws.on('open', () => {
  if (WATCH_ACCOUNTS.length) send(ws, { op: 'setAccounts', accounts: WATCH_ACCOUNTS })
  if (WATCH_MINTS.length) send(ws, { op: 'setMints', mints: WATCH_MINTS })
  send(ws, { op: 'getState' })
})

ws.on('message', (data) => {
  const text = typeof data === 'string' ? data : data.toString('utf8')
  const ev = JSON.parse(text) as WsEvent

  if (ev.type === 'status') {
    console.log('STATUS:', ev)
    return
  }

  if (ev.type === 'transaction') {
    console.log(
      ev.commitment,
      'slot',
      ev.slot,
      'sig',
      ev.signature,
      'tokenBalanceChanges',
      ev.tokenBalanceChanges ?? []
    )
  }
})

ws.on('close', () => {
  console.log('WebSocket closed')
})

ws.on('error', (err) => {
  console.error('WebSocket error:', err)
})
