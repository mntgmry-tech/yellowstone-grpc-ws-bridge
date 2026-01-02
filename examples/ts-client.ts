import dotenv from 'dotenv'
import { WebSocket } from 'ws'

dotenv.config()

const WS_URL = process.env.BRIDGE_WS_URL ?? 'ws://127.0.0.1:8787'
const CLIENT_ID = process.env.BRIDGE_CLIENT_ID ?? ''
const MAX_PAYLOAD = 64 * 1024 * 1024

const INCLUDE_ACCOUNTS = true
const INCLUDE_TOKEN_BALANCE_CHANGES = true
const INCLUDE_LOGS = false

const WATCH_ACCOUNTS: string[] = [
  // 'YourAtaPubkeyHere'
]

const WATCH_MINTS: string[] = [
  // 'YourMintPubkeyHere'
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
]

type ClientMsg =
  | { op: 'resume'; clientId: string }
  | { op: 'setAccounts'; accounts: string[] }
  | { op: 'setMints'; mints: string[] }
  | {
      op: 'setOptions'
      includeAccounts?: boolean
      includeTokenBalanceChanges?: boolean
      includeLogs?: boolean
    }
  | { op: 'getState' }
  | { op: 'ping' }

type StatusEvent = {
  type: 'status'
  clientId?: string
  now: string
  grpcConnected: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
  watchedAccounts: number
  watchedMints: number
}

type TokenBalanceChange = {
  account: string
  mint: string
  owner?: string
  decimals: number
  preAmount: string
  preAmountUi: string
  postAmount: string
  postAmountUi: string
  delta: string
  deltaUi: string
}

type TransactionEvent = {
  type: 'transaction'
  commitment: 'processed' | 'confirmed'
  slot: number
  signature: string
  isVote: boolean
  index: number
  err: unknown
  accounts?: string[]
  tokenBalanceChanges?: TokenBalanceChange[]
  logs?: string[]
  computeUnitsConsumed?: number
}

type WsEvent = StatusEvent | TransactionEvent

function send(ws: WebSocket, msg: ClientMsg) {
  ws.send(JSON.stringify(msg))
}

let lastClientId: string | undefined

const ws = new WebSocket(WS_URL, { maxPayload: MAX_PAYLOAD })

ws.on('open', () => {
  if (CLIENT_ID) send(ws, { op: 'resume', clientId: CLIENT_ID })
  send(ws, {
    op: 'setOptions',
    includeAccounts: INCLUDE_ACCOUNTS,
    includeTokenBalanceChanges: INCLUDE_TOKEN_BALANCE_CHANGES,
    includeLogs: INCLUDE_LOGS
  })
  if (WATCH_ACCOUNTS.length) send(ws, { op: 'setAccounts', accounts: WATCH_ACCOUNTS })
  if (WATCH_MINTS.length) send(ws, { op: 'setMints', mints: WATCH_MINTS })
  send(ws, { op: 'getState' })
})

ws.on('message', (data) => {
  const text = typeof data === 'string' ? data : data.toString('utf8')
  const ev = JSON.parse(text) as WsEvent

  if (ev.type === 'status') {
    if (ev.clientId && ev.clientId !== lastClientId) {
      lastClientId = ev.clientId
      console.log(`CLIENT_ID: ${ev.clientId}`)
    }
    console.log(JSON.stringify(ev, null, 2))
    return
  }

  if (ev.type === 'transaction') {
    console.log(JSON.stringify(ev, null, 2))
  }
})

ws.on('close', () => {
  console.log('WebSocket closed')
})

ws.on('error', (err) => {
  console.error('WebSocket error:', err)
})
