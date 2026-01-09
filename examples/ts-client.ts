import dotenv from 'dotenv'
import { WebSocket } from 'ws'

dotenv.config()

const WS_URL = process.env.BRIDGE_WS_URL ?? 'ws://127.0.0.1:8787'
const CLIENT_ID = process.env.BRIDGE_CLIENT_ID ?? ''
const API_KEY = process.env.BRIDGE_API_KEY ?? ''
const MAX_PAYLOAD = 64 * 1024 * 1024
const EVENT_FORMAT = process.env.BRIDGE_EVENT_FORMAT ?? 'enhanced' //'raw'
const FILTER_TOKEN_BALANCES = (process.env.BRIDGE_FILTER_TOKEN_BALANCES ?? '').toLowerCase() === 'false' //'false'

const INCLUDE_ACCOUNTS = true
const INCLUDE_TOKEN_BALANCE_CHANGES = true
const INCLUDE_LOGS = false
const INCLUDE_INSTRUCTIONS = (process.env.BRIDGE_INCLUDE_INSTRUCTIONS ?? '').toLowerCase() === 'true'

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
      includeInstructions?: boolean
      eventFormat?: 'raw' | 'enhanced'
      filterTokenBalances?: boolean
    }
  | { op: 'getState' }
  | { op: 'ping' }

type StatusEvent = {
  type: 'status'
  clientId?: string
  now: string
  grpcConnected: boolean
  nodeHealthy: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
  watchedAccounts: number
  watchedMints: number
}

type NativeTransfer = {
  fromUserAccount: string
  toUserAccount: string
  amount: number
}

type TokenTransfer = {
  fromTokenAccount: string
  toTokenAccount: string
  fromUserAccount: string
  toUserAccount: string
  tokenAmount: number
  mint: string
  tokenStandard: string
}

type RawTokenBalanceChange = {
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

type RawTokenAmount = {
  tokenAmount: string
  decimals: number
}

type AccountTokenBalanceChange = {
  userAccount: string
  tokenAccount: string
  rawTokenAmount: RawTokenAmount
  mint: string
}

type AccountData = {
  account: string
  nativeBalanceChange: number
  tokenBalanceChanges: AccountTokenBalanceChange[]
}

type InnerInstruction = {
  programId: string
  accounts: string[]
  data: string
}

type Instruction = {
  programId: string
  accounts: string[]
  data: string
  innerInstructions: InnerInstruction[]
}

type TransactionEvent = {
  type: 'transaction'
  commitment: 'processed' | 'confirmed'
  slot: number
  signature: string
  timestamp: number | null
  isVote: boolean
  index: number
  err: object | null
  fee: number
  feePayer: string
  accounts?: string[]
  nativeTransfers: NativeTransfer[]
  tokenTransfers: TokenTransfer[]
  accountData: AccountData[]
  instructions?: Instruction[]
  logs?: string[]
  computeUnitsConsumed: number
}

type RawTransactionEvent = {
  type: 'transaction'
  commitment: 'processed' | 'confirmed'
  slot: number
  signature: string
  isVote: boolean
  index: number
  err: object | null
  accounts?: string[]
  tokenBalanceChanges?: RawTokenBalanceChange[]
  logs?: string[]
  computeUnitsConsumed: number
}

type EnhancedTransactionEvent = TransactionEvent

type WsEvent = StatusEvent | RawTransactionEvent | EnhancedTransactionEvent

function send(ws: WebSocket, msg: ClientMsg) {
  ws.send(JSON.stringify(msg))
}

let lastClientId: string | undefined

const normalizedFormat = EVENT_FORMAT.toLowerCase()
const eventFormat =
  normalizedFormat === 'raw' || normalizedFormat === 'enhanced' ? normalizedFormat : undefined

let wsUrl = WS_URL
let clientIdInUrl = false
if (eventFormat) {
  try {
    const parsed = new URL(WS_URL)
    parsed.searchParams.set('format', eventFormat)
    if (CLIENT_ID) {
      parsed.searchParams.set('clientId', CLIENT_ID)
      clientIdInUrl = true
    }
    wsUrl = parsed.toString()
  } catch {
    wsUrl = WS_URL
  }
} else if (CLIENT_ID) {
  try {
    const parsed = new URL(WS_URL)
    parsed.searchParams.set('clientId', CLIENT_ID)
    clientIdInUrl = true
    wsUrl = parsed.toString()
  } catch {
    wsUrl = WS_URL
  }
}

const normalizedApiKey = API_KEY.trim().replace(/^Bearer\\s+/i, '')
const headers = normalizedApiKey ? { Authorization: `Bearer ${normalizedApiKey}` } : undefined
const ws = new WebSocket(wsUrl, { maxPayload: MAX_PAYLOAD, headers })

ws.on('open', () => {
  if (CLIENT_ID && !clientIdInUrl) send(ws, { op: 'resume', clientId: CLIENT_ID })
  send(ws, {
    op: 'setOptions',
    includeAccounts: INCLUDE_ACCOUNTS,
    includeTokenBalanceChanges: INCLUDE_TOKEN_BALANCE_CHANGES,
    includeLogs: INCLUDE_LOGS,
    includeInstructions: INCLUDE_INSTRUCTIONS,
    eventFormat,
    filterTokenBalances: FILTER_TOKEN_BALANCES
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
