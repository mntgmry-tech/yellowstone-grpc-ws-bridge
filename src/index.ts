import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc'
import bs58 from 'bs58'
import { WebSocketServer, WebSocket } from 'ws'
import { env } from './env'

type CommitmentLabel = 'processed' | 'confirmed'

type ClientMsg =
  | { op: 'setAccounts'; accounts: string[] }
  | { op: 'addAccounts'; accounts: string[] }
  | { op: 'removeAccounts'; accounts: string[] }
  | { op: 'setMints'; mints: string[] }
  | { op: 'addMints'; mints: string[] }
  | { op: 'removeMints'; mints: string[] }
  | { op: 'getState' }
  | { op: 'ping' }

type WsEvent =
  | {
      type: 'status'
      now: string
      grpcConnected: boolean
      processedHeadSlot?: number
      confirmedHeadSlot?: number
      watchedAccounts: number
      watchedMints: number
    }
  | {
      type: 'transaction'
      commitment: CommitmentLabel
      slot: number
      signature: string
      isVote: boolean
      index: number
      err: unknown
      accounts: string[]
      tokenBalanceChanges: TokenBalanceChange[]
      logs?: string[]
      computeUnitsConsumed?: number
    }

type TokenBalanceChange = {
  account: string
  mint: string
  owner?: string
  decimals: number
  preAmount: string
  postAmount: string
  delta: string // signed, base units
}

const WS_BIND = env.wsBind
const WS_PORT = env.wsPort
const GRPC_ENDPOINT = env.grpcEndpoint
const X_TOKEN = env.xToken

const grpcOptions = {
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
  'grpc.max_send_message_length': 64 * 1024 * 1024,
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 5_000
}

const client = new Client(GRPC_ENDPOINT, X_TOKEN, grpcOptions)

const wss = new WebSocketServer({ host: WS_BIND, port: WS_PORT })

const clients = new Set<WebSocket>()
const watchedAccounts = new Set<string>()
const watchedMints = new Set<string>()

let processedStream: any | undefined
let confirmedStream: any | undefined

let processedHeadSlot: number | undefined
let confirmedHeadSlot: number | undefined

let pingId = 1

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

function send(ws: WebSocket, msg: WsEvent) {
  if (ws.readyState !== ws.OPEN) return
  ws.send(JSON.stringify(msg))
}

function broadcast(msg: WsEvent) {
  const payload = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function normalizePubkeyMaybe(b58: string): string | undefined {
  try {
    const bytes = bs58.decode(b58)
    return bs58.encode(bytes)
  } catch {
    return undefined
  }
}

function bigIntSub(a: string, b: string): string {
  try {
    return (BigInt(a) - BigInt(b)).toString()
  } catch {
    return '0'
  }
}

function extractTokenBalanceChanges(updateTxInfo: any): TokenBalanceChange[] {
  const meta = updateTxInfo?.meta ?? updateTxInfo?.transaction?.meta
  const tx = updateTxInfo?.transaction?.transaction ?? updateTxInfo?.transaction?.transaction?.transaction
  const message = tx?.message

  const accountKeysBytes: Uint8Array[] = message?.accountKeys ?? message?.account_keys ?? []
  const accountKeys: string[] = Array.isArray(accountKeysBytes)
    ? accountKeysBytes
        .map((b: any) => {
          try {
            return bs58.encode(b)
          } catch {
            return ''
          }
        })
        .filter(Boolean)
    : []

  const pre = meta?.preTokenBalances ?? meta?.pre_token_balances ?? []
  const post = meta?.postTokenBalances ?? meta?.post_token_balances ?? []

  const byIndexMint = new Map<string, any>()
  for (const p of pre) {
    const key = `${p.accountIndex ?? p.account_index}:${p.mint}`
    byIndexMint.set(key, { pre: p, post: undefined })
  }
  for (const p of post) {
    const key = `${p.accountIndex ?? p.account_index}:${p.mint}`
    const existing = byIndexMint.get(key) ?? { pre: undefined, post: undefined }
    existing.post = p
    byIndexMint.set(key, existing)
  }

  const changes: TokenBalanceChange[] = []
  for (const [, v] of byIndexMint) {
    const preAmt = v.pre?.uiTokenAmount?.amount ?? v.pre?.ui_token_amount?.amount ?? '0'
    const postAmt = v.post?.uiTokenAmount?.amount ?? v.post?.ui_token_amount?.amount ?? '0'
    const decimals =
      v.post?.uiTokenAmount?.decimals ??
      v.post?.ui_token_amount?.decimals ??
      v.pre?.uiTokenAmount?.decimals ??
      v.pre?.ui_token_amount?.decimals ??
      0

    if (String(preAmt) === String(postAmt)) continue

    const accountIndex =
      v.post?.accountIndex ?? v.post?.account_index ?? v.pre?.accountIndex ?? v.pre?.account_index ?? undefined
    const account =
      typeof accountIndex === 'number' && accountIndex >= 0 && accountIndex < accountKeys.length
        ? accountKeys[accountIndex]
        : ''
    const mint = v.post?.mint ?? v.pre?.mint ?? ''
    const owner = v.post?.owner ?? v.pre?.owner ?? undefined

    const watched = (account && watchedAccounts.has(account)) || (mint && watchedMints.has(mint))
    if (!watched) continue

    const preStr = String(preAmt)
    const postStr = String(postAmt)

    changes.push({
      account,
      mint,
      owner,
      decimals: Number(decimals) || 0,
      preAmount: preStr,
      postAmount: postStr,
      delta: bigIntSub(postStr, preStr)
    })
  }

  return changes
}

function extractAccounts(updateTxInfo: any): string[] {
  const tx = updateTxInfo?.transaction?.transaction ?? updateTxInfo?.transaction?.transaction?.transaction
  const message = tx?.message
  const keys: any[] = message?.accountKeys ?? message?.account_keys ?? []
  if (!Array.isArray(keys)) return []
  return keys
    .map((b: any) => {
      try {
        return bs58.encode(b)
      } catch {
        return ''
      }
    })
    .filter(Boolean)
}

function currentReq(commitment: CommitmentLevel): SubscribeRequest {
  const include = [...watchedAccounts, ...watchedMints]
  return {
    accounts: {},
    slots: { head: {} },
    transactions: include.length
      ? {
          watched: {
            vote: false,
            failed: false,
            signature: undefined,
            accountInclude: include,
            accountExclude: [],
            accountRequired: []
          }
        }
      : {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ping: undefined,
    commitment
  }
}

let pendingWrite = false
function scheduleResubscribe() {
  if (pendingWrite) return
  pendingWrite = true
  setTimeout(async () => {
    pendingWrite = false
    await writeSubscriptionSafely()
  }, 200)
}

async function writeSubscriptionSafely() {
  const writes: Array<Promise<void>> = []

  if (processedStream) {
    const req = currentReq(CommitmentLevel.PROCESSED)
    writes.push(
      new Promise<void>((resolve, reject) => {
        processedStream.write(req, (err: any) => (err ? reject(err) : resolve()))
      })
    )
  }

  if (confirmedStream) {
    const req = currentReq(CommitmentLevel.CONFIRMED)
    writes.push(
      new Promise<void>((resolve, reject) => {
        confirmedStream.write(req, (err: any) => (err ? reject(err) : resolve()))
      })
    )
  }

  if (writes.length) {
    try {
      await Promise.all(writes)
      broadcast({
        type: 'status',
        now: nowIso(),
        grpcConnected: true,
        processedHeadSlot,
        confirmedHeadSlot,
        watchedAccounts: watchedAccounts.size,
        watchedMints: watchedMints.size
      })
    } catch (e) {
      broadcast({
        type: 'status',
        now: nowIso(),
        grpcConnected: false,
        processedHeadSlot,
        confirmedHeadSlot,
        watchedAccounts: watchedAccounts.size,
        watchedMints: watchedMints.size
      })
      console.error('[grpc] failed to write subscription:', e)
    }
  }
}

async function connectStream(commitment: CommitmentLevel): Promise<any> {
  const stream = await client.subscribe()

  stream.on('data', (data: any) => {
    if (data?.slot?.slot !== undefined) {
      const s = Number(data.slot.slot)
      if (commitment === CommitmentLevel.PROCESSED) processedHeadSlot = s
      if (commitment === CommitmentLevel.CONFIRMED) confirmedHeadSlot = s
      return
    }

    const txInfo = data?.transaction?.transaction
    if (!txInfo) return

    const signatureBytes = txInfo.signature
    const signature = signatureBytes ? bs58.encode(signatureBytes) : ''

    const meta = txInfo.meta ?? txInfo.transaction?.meta
    const err = meta?.err ?? null

    const logs: string[] | undefined = meta?.logMessages ?? meta?.log_messages ?? undefined
    const computeUnitsConsumed = meta?.computeUnitsConsumed ?? meta?.compute_units_consumed ?? undefined

    const tokenBalanceChanges = extractTokenBalanceChanges(txInfo)
    const accounts = extractAccounts(txInfo)

    const ev: WsEvent = {
      type: 'transaction',
      commitment: commitment === CommitmentLevel.PROCESSED ? 'processed' : 'confirmed',
      slot: Number(data.transaction.slot ?? 0),
      signature,
      isVote: Boolean(txInfo.isVote ?? txInfo.is_vote ?? false),
      index: Number(txInfo.index ?? 0),
      err,
      accounts,
      tokenBalanceChanges,
      logs,
      computeUnitsConsumed: computeUnitsConsumed !== undefined ? Number(computeUnitsConsumed) : undefined
    }

    broadcast(ev)
  })

  stream.on('error', (err: any) => {
    console.error('[grpc] stream error:', err)
    stream.end()
  })

  stream.on('end', () => console.error('[grpc] stream ended'))
  stream.on('close', () => console.error('[grpc] stream closed'))

  await new Promise<void>((resolve, reject) => {
    stream.write(currentReq(commitment), (err: any) => (err ? reject(err) : resolve()))
  })

  return stream
}

async function startGrpcLoops() {
  ;(async () => {
    while (true) {
      try {
        console.log(`[grpc] connecting processed -> ${GRPC_ENDPOINT}`)
        processedStream = await connectStream(CommitmentLevel.PROCESSED)
        broadcast({
          type: 'status',
          now: nowIso(),
          grpcConnected: true,
          processedHeadSlot,
          confirmedHeadSlot,
          watchedAccounts: watchedAccounts.size,
          watchedMints: watchedMints.size
        })

        await new Promise<void>((resolve) => {
          processedStream.on('end', resolve)
          processedStream.on('close', resolve)
        })
      } catch (e) {
        console.error('[grpc] processed loop error:', e)
      } finally {
        processedStream = undefined
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  })().catch(console.error)
  ;(async () => {
    while (true) {
      try {
        console.log(`[grpc] connecting confirmed -> ${GRPC_ENDPOINT}`)
        confirmedStream = await connectStream(CommitmentLevel.CONFIRMED)
        broadcast({
          type: 'status',
          now: nowIso(),
          grpcConnected: true,
          processedHeadSlot,
          confirmedHeadSlot,
          watchedAccounts: watchedAccounts.size,
          watchedMints: watchedMints.size
        })

        await new Promise<void>((resolve) => {
          confirmedStream.on('end', resolve)
          confirmedStream.on('close', resolve)
        })
      } catch (e) {
        console.error('[grpc] confirmed loop error:', e)
      } finally {
        confirmedStream = undefined
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  })().catch(console.error)

  setInterval(() => {
    const id = pingId++
    const req = { ping: { id } }
    try {
      processedStream?.write(req, () => undefined)
      confirmedStream?.write(req, () => undefined)
    } catch {
      // ignore
    }
  }, 10_000)
}

wss.on('connection', (ws) => {
  clients.add(ws)

  send(ws, {
    type: 'status',
    now: nowIso(),
    grpcConnected: Boolean(processedStream || confirmedStream),
    processedHeadSlot,
    confirmedHeadSlot,
    watchedAccounts: watchedAccounts.size,
    watchedMints: watchedMints.size
  })

  ws.on('message', (buf) => {
    const msg = safeJsonParse(buf.toString('utf8')) as ClientMsg | undefined
    if (!msg || typeof msg !== 'object' || !('op' in msg)) return

    if (msg.op === 'ping' || msg.op === 'getState') {
      send(ws, {
        type: 'status',
        now: nowIso(),
        grpcConnected: Boolean(processedStream || confirmedStream),
        processedHeadSlot,
        confirmedHeadSlot,
        watchedAccounts: watchedAccounts.size,
        watchedMints: watchedMints.size
      })
      return
    }

    const applyList = (set: Set<string>, list: string[], mode: 'set' | 'add' | 'remove') => {
      const normalized = list.map(normalizePubkeyMaybe).filter((x): x is string => Boolean(x))
      if (mode === 'set') {
        set.clear()
        for (const a of normalized) set.add(a)
      } else if (mode === 'add') {
        for (const a of normalized) set.add(a)
      } else {
        for (const a of normalized) set.delete(a)
      }
    }

    switch (msg.op) {
      case 'setAccounts':
        applyList(watchedAccounts, msg.accounts ?? [], 'set')
        scheduleResubscribe()
        break
      case 'addAccounts':
        applyList(watchedAccounts, msg.accounts ?? [], 'add')
        scheduleResubscribe()
        break
      case 'removeAccounts':
        applyList(watchedAccounts, msg.accounts ?? [], 'remove')
        scheduleResubscribe()
        break
      case 'setMints':
        applyList(watchedMints, msg.mints ?? [], 'set')
        scheduleResubscribe()
        break
      case 'addMints':
        applyList(watchedMints, msg.mints ?? [], 'add')
        scheduleResubscribe()
        break
      case 'removeMints':
        applyList(watchedMints, msg.mints ?? [], 'remove')
        scheduleResubscribe()
        break
      default:
        break
    }

    send(ws, {
      type: 'status',
      now: nowIso(),
      grpcConnected: Boolean(processedStream || confirmedStream),
      processedHeadSlot,
      confirmedHeadSlot,
      watchedAccounts: watchedAccounts.size,
      watchedMints: watchedMints.size
    })
  })

  ws.on('close', () => {
    clients.delete(ws)
  })
})

console.log(`[ws] listening on ws://${WS_BIND}:${WS_PORT}`)
console.log(`[grpc] endpoint: ${GRPC_ENDPOINT} (x-token ${X_TOKEN ? 'set' : 'not set'})`)

startGrpcLoops().catch((e) => {
  console.error('[fatal] grpc loops failed:', e)
  process.exitCode = 1
})
