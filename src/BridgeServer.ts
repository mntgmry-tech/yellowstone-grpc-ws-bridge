import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc'
import bs58 from 'bs58'
import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import { ClientMsg, ClientOptions, CommitmentLabel, WsEvent } from './types'
import { StatsTracker } from './utils/stats'
import {
  extractAccounts,
  extractTokenBalanceChanges,
  filterTokenBalanceChanges,
  matchesWatchlist,
  normalizePubkeyMaybe
} from './utils/transforms'
import { WsHub } from './utils/ws'

type BridgeConfig = {
  wsBind: string
  wsPort: number
  wsIdleTimeoutMs: number
  grpcRetentionMs: number
  grpcEndpoint: string
  xToken: string
}

const grpcOptions = {
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
  'grpc.max_send_message_length': 64 * 1024 * 1024,
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 5_000
}

type ClientSession = {
  id: string
  ws?: WebSocket
  connected: boolean
  lastSeenAt: number
  disconnectedAt?: number
  options: ClientOptions
  watchAccounts: Set<string>
  watchMints: Set<string>
}

type BacklogItem = {
  ts: number
  event: WsEvent
}

const defaultClientOptions: ClientOptions = {
  includeAccounts: true,
  includeTokenBalanceChanges: true,
  includeLogs: false
}

export class BridgeServer {
  private grpcClient: Client
  private wsHub: WsHub
  private stats = new StatsTracker()

  private sessions = new Map<string, ClientSession>()
  private socketToSession = new Map<WebSocket, ClientSession>()
  private backlog: BacklogItem[] = []

  private subscriptionAccounts = new Set<string>()
  private subscriptionMints = new Set<string>()
  private subscriptionKey = ''
  private grpcWanted = false

  private processedStream: any | undefined
  private confirmedStream: any | undefined
  private processedHeadSlot: number | undefined
  private confirmedHeadSlot: number | undefined

  private pingId = 1
  private pendingWrite = false
  private stoppingGrpc = false
  private stopResetTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private config: BridgeConfig) {
    this.grpcClient = new Client(config.grpcEndpoint, config.xToken, grpcOptions)
    this.wsHub = new WsHub({
      host: config.wsBind,
      port: config.wsPort,
      handlers: {
        onConnect: this.handleClientConnected,
        onMessage: this.handleClientMessage,
        onClose: this.handleClientClosed
      }
    })
  }

  start() {
    console.log(`[ws] listening on ws://${this.config.wsBind}:${this.config.wsPort}`)
    console.log(`[grpc] endpoint: ${this.config.grpcEndpoint} (x-token ${this.config.xToken ? 'set' : 'not set'})`)

    this.startGrpcLoops()
    this.startClientHeartbeat()
    this.stats.start(60_000, () => this.statsContext())
  }

  private handleClientConnected = (ws: WebSocket) => {
    const session = this.createSession(ws)
    ws.on('pong', () => this.touchClient(ws))
    console.log(
      `[ws] client connected clientId=${session.id} (${this.clientLabel(ws)}) total=${this.connectedCount()}`
    )
    this.sendStatus(session)
  }

  private handleClientMessage = (ws: WebSocket, msg: ClientMsg) => {
    this.touchClient(ws)

    if (msg.op === 'resume') {
      this.resumeSession(ws, msg.clientId)
      return
    }

    const session = this.socketToSession.get(ws)
    if (!session) return

    if (msg.op === 'setOptions') {
      this.updateClientOptions(session, msg)
      this.sendStatus(session)
      return
    }

    if (msg.op === 'ping' || msg.op === 'getState') {
      this.sendStatus(session)
      return
    }

    switch (msg.op) {
      case 'setAccounts':
        this.applyList(session.watchAccounts, msg.accounts ?? [], 'set')
        this.updateSubscriptions()
        break
      case 'addAccounts':
        this.applyList(session.watchAccounts, msg.accounts ?? [], 'add')
        this.updateSubscriptions()
        break
      case 'removeAccounts':
        this.applyList(session.watchAccounts, msg.accounts ?? [], 'remove')
        this.updateSubscriptions()
        break
      case 'setMints':
        this.applyList(session.watchMints, msg.mints ?? [], 'set')
        this.updateSubscriptions()
        break
      case 'addMints':
        this.applyList(session.watchMints, msg.mints ?? [], 'add')
        this.updateSubscriptions()
        break
      case 'removeMints':
        this.applyList(session.watchMints, msg.mints ?? [], 'remove')
        this.updateSubscriptions()
        break
      default:
        break
    }

    this.sendStatus(session)
  }

  private handleClientClosed = (ws: WebSocket, code: number, reason: string) => {
    const session = this.socketToSession.get(ws)
    if (!session) return
    this.socketToSession.delete(ws)
    session.ws = undefined
    session.connected = false
    session.disconnectedAt = Date.now()
    if (this.config.grpcRetentionMs === 0) {
      this.sessions.delete(session.id)
    }
    this.updateSubscriptions()
    const reasonSuffix = reason ? ` reason="${reason}"` : ''
    console.log(
      `[ws] client disconnected clientId=${session.id} (${this.clientLabel(ws)}) code=${code}${reasonSuffix} total=${this.connectedCount()}`
    )
  }

  private createSession(ws: WebSocket): ClientSession {
    const session: ClientSession = {
      id: randomUUID(),
      ws,
      connected: true,
      lastSeenAt: Date.now(),
      options: { ...defaultClientOptions },
      watchAccounts: new Set<string>(),
      watchMints: new Set<string>()
    }
    this.sessions.set(session.id, session)
    this.socketToSession.set(ws, session)
    return session
  }

  private resumeSession(ws: WebSocket, clientId: string) {
    const target = this.sessions.get(clientId)
    const current = this.socketToSession.get(ws)
    if (!target) {
      if (current) this.sendStatus(current)
      return
    }

    if (current && current.id !== target.id) {
      this.removeSession(current)
    }

    if (target.ws && target.ws !== ws) {
      try {
        target.ws.terminate()
      } catch {
        // ignore
      }
      this.socketToSession.delete(target.ws)
    }

    const resumeFrom = target.disconnectedAt ?? target.lastSeenAt
    target.ws = ws
    target.connected = true
    target.lastSeenAt = Date.now()
    target.disconnectedAt = undefined
    this.socketToSession.set(ws, target)

    console.log(`[ws] client resumed clientId=${target.id} (${this.clientLabel(ws)}) total=${this.connectedCount()}`)
    this.sendStatus(target)
    this.replayBacklog(target, resumeFrom)
  }

  private removeSession(session: ClientSession) {
    if (session.ws) {
      this.socketToSession.delete(session.ws)
    }
    this.sessions.delete(session.id)
    this.updateSubscriptions()
  }

  private sendStatus(session: ClientSession) {
    const ws = session.ws
    if (!ws) return
    const msg = this.buildStatusEvent(session)
    const sent = this.wsHub.send(ws, msg)
    if (sent) this.stats.recordWsEvent(msg.type, 1)
  }

  private broadcastStatus(grpcConnectedOverride?: boolean) {
    let delivered = 0
    for (const session of this.sessions.values()) {
      if (!session.connected || !session.ws) continue
      const msg = this.buildStatusEvent(session, grpcConnectedOverride)
      const sent = this.wsHub.send(session.ws, msg)
      if (sent) delivered += 1
    }
    this.stats.recordWsEvent('status', delivered)
  }

  private touchClient(ws: WebSocket) {
    const session = this.socketToSession.get(ws)
    if (session) session.lastSeenAt = Date.now()
  }

  private clientLabel(ws: WebSocket) {
    const socket = (ws as unknown as { _socket?: { remoteAddress?: string; remotePort?: number } })._socket
    const addr = socket?.remoteAddress
    const port = socket?.remotePort
    if (!addr) return 'unknown'
    return port ? `${addr}:${port}` : addr
  }

  private updateClientOptions(
    session: ClientSession,
    msg: { includeAccounts?: boolean; includeTokenBalanceChanges?: boolean; includeLogs?: boolean }
  ) {
    if (typeof msg.includeAccounts === 'boolean') session.options.includeAccounts = msg.includeAccounts
    if (typeof msg.includeTokenBalanceChanges === 'boolean') {
      session.options.includeTokenBalanceChanges = msg.includeTokenBalanceChanges
    }
    if (typeof msg.includeLogs === 'boolean') session.options.includeLogs = msg.includeLogs
  }

  private buildStatusEvent(session: ClientSession, grpcConnectedOverride?: boolean): WsEvent {
    return {
      type: 'status',
      clientId: session.id,
      now: new Date().toISOString(),
      grpcConnected: grpcConnectedOverride ?? this.grpcConnected(),
      processedHeadSlot: this.processedHeadSlot,
      confirmedHeadSlot: this.confirmedHeadSlot,
      watchedAccounts: session.watchAccounts.size,
      watchedMints: session.watchMints.size
    }
  }

  private grpcConnected() {
    return Boolean(this.processedStream || this.confirmedStream)
  }

  private applyList(set: Set<string>, list: string[], mode: 'set' | 'add' | 'remove') {
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

  private prepareTransactionForSession(event: WsEvent, session: ClientSession): WsEvent | undefined {
    if (event.type !== 'transaction') return event
    const accounts = event.accounts ?? []
    const changes = event.tokenBalanceChanges ?? []
    if (!matchesWatchlist(accounts, changes, session.watchAccounts, session.watchMints)) return undefined

    const filteredChanges = filterTokenBalanceChanges(changes, session.watchAccounts, session.watchMints)
    return {
      ...event,
      accounts: session.options.includeAccounts ? accounts : undefined,
      tokenBalanceChanges: session.options.includeTokenBalanceChanges ? filteredChanges : undefined,
      logs: session.options.includeLogs ? event.logs : undefined
    }
  }

  private broadcastTransaction(event: WsEvent) {
    let delivered = 0
    for (const session of this.sessions.values()) {
      if (!session.connected || !session.ws) continue
      const payload = this.prepareTransactionForSession(event, session)
      if (!payload) continue
      const sent = this.wsHub.send(session.ws, payload)
      if (sent) delivered += 1
    }
    this.stats.recordWsEvent('transaction', delivered)
  }

  private updateSubscriptions() {
    const changed = this.updateSubscriptionUnion()
    const wantGrpc = this.subscriptionAccounts.size > 0 || this.subscriptionMints.size > 0
    const wasWanted = this.grpcWanted
    this.grpcWanted = wantGrpc

    if (!wantGrpc) {
      this.stopGrpcStreams()
      return
    }

    if (changed || !wasWanted) {
      this.scheduleResubscribe()
    }
  }

  private updateSubscriptionUnion() {
    const now = Date.now()
    const accounts = new Set<string>()
    const mints = new Set<string>()
    for (const session of this.sessions.values()) {
      if (!this.isSessionRetained(session, now)) continue
      for (const account of session.watchAccounts) accounts.add(account)
      for (const mint of session.watchMints) mints.add(mint)
    }
    const key = `${[...accounts].sort().join(',')}|${[...mints].sort().join(',')}`
    if (key === this.subscriptionKey) return false
    this.subscriptionKey = key
    this.subscriptionAccounts = accounts
    this.subscriptionMints = mints
    return true
  }

  private isSessionRetained(session: ClientSession, now: number) {
    if (session.connected) return true
    if (!session.disconnectedAt) return false
    if (this.config.grpcRetentionMs <= 0) return false
    return now - session.disconnectedAt <= this.config.grpcRetentionMs
  }

  private currentReq(commitment: CommitmentLevel, pingId?: number): SubscribeRequest {
    const include = [...this.subscriptionAccounts, ...this.subscriptionMints]
    return {
      accounts: {},
      slots: include.length ? { head: {} } : {},
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
      ping: pingId !== undefined ? { id: pingId } : undefined,
      commitment
    }
  }

  private scheduleResubscribe() {
    if (this.pendingWrite || !this.grpcWanted) return
    this.pendingWrite = true
    setTimeout(async () => {
      this.pendingWrite = false
      await this.writeSubscriptionSafely()
    }, 200)
  }

  private async writeSubscriptionSafely() {
    if (!this.grpcWanted) return
    const writes: Array<Promise<void>> = []

    if (this.processedStream) {
      const req = this.currentReq(CommitmentLevel.PROCESSED)
      writes.push(
        new Promise<void>((resolve, reject) => {
          this.processedStream.write(req, (err: any) => (err ? reject(err) : resolve()))
        })
      )
    }

    if (this.confirmedStream) {
      const req = this.currentReq(CommitmentLevel.CONFIRMED)
      writes.push(
        new Promise<void>((resolve, reject) => {
          this.confirmedStream.write(req, (err: any) => (err ? reject(err) : resolve()))
        })
      )
    }

    if (!writes.length) return

    try {
      await Promise.all(writes)
      this.broadcastStatus(true)
    } catch (e) {
      this.broadcastStatus(false)
      console.error('[grpc] failed to write subscription:', e)
    }
  }

  private async connectStream(commitment: CommitmentLevel, label: CommitmentLabel): Promise<any> {
    const stream = await this.grpcClient.subscribe()

    stream.on('data', (data: any) => {
      this.handleStreamData(label, data)
    })

    stream.on('error', (err: any) => {
      if (this.isExpectedGrpcShutdown(err)) {
        console.log(`[grpc] stream cancelled (${label})`)
        return
      }
      console.error(`[grpc] stream error (${label}):`, err)
      stream.end()
    })

    stream.on('end', () => console.error(`[grpc] stream ended (${label})`))
    stream.on('close', () => console.error(`[grpc] stream closed (${label})`))

    await new Promise<void>((resolve, reject) => {
      stream.write(this.currentReq(commitment), (err: any) => (err ? reject(err) : resolve()))
    })

    return stream
  }

  private handleStreamData(label: CommitmentLabel, data: any) {
    const pongId = data?.pong?.id
    if (pongId !== undefined) {
      this.stats.recordPong(label, Number(pongId))
      return
    }

    if (data?.slot?.slot !== undefined) {
      const s = Number(data.slot.slot)
      if (label === 'processed') this.processedHeadSlot = s
      if (label === 'confirmed') this.confirmedHeadSlot = s
      this.stats.recordSlot(label)
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
      commitment: label,
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

    this.stats.recordTx(label)
    this.maybeBufferEvent(ev)
    this.broadcastTransaction(ev)
  }

  private maybeBufferEvent(event: WsEvent) {
    if (this.config.grpcRetentionMs <= 0) return
    const now = Date.now()
    if (!this.shouldBuffer(now)) {
      if (this.backlog.length) this.backlog = []
      return
    }
    this.backlog.push({ ts: now, event })
    this.trimBacklog(now)
  }

  private shouldBuffer(now: number) {
    for (const session of this.sessions.values()) {
      if (!session.connected && session.disconnectedAt && now - session.disconnectedAt <= this.config.grpcRetentionMs) {
        return true
      }
    }
    return false
  }

  private replayBacklog(session: ClientSession, since: number) {
    if (!session.ws || this.backlog.length === 0) return
    let delivered = 0
    for (const item of this.backlog) {
      if (item.ts <= since) continue
      const payload = this.prepareTransactionForSession(item.event, session)
      if (!payload) continue
      const sent = this.wsHub.send(session.ws, payload)
      if (sent) delivered += 1
    }
    this.stats.recordWsEvent('transaction', delivered)
  }

  private trimBacklog(now: number) {
    const cutoff = now - this.config.grpcRetentionMs
    while (this.backlog.length && this.backlog[0].ts < cutoff) {
      this.backlog.shift()
    }
  }

  private stopGrpcStreams() {
    this.stoppingGrpc = true
    if (this.stopResetTimer) clearTimeout(this.stopResetTimer)
    this.stopResetTimer = setTimeout(() => {
      this.stoppingGrpc = false
    }, 1000)

    if (this.processedStream) {
      try {
        this.processedStream.end()
      } catch {
        // ignore
      }
      if (typeof this.processedStream.cancel === 'function') {
        try {
          this.processedStream.cancel()
        } catch {
          // ignore
        }
      }
      this.processedStream = undefined
    }
    if (this.confirmedStream) {
      try {
        this.confirmedStream.end()
      } catch {
        // ignore
      }
      if (typeof this.confirmedStream.cancel === 'function') {
        try {
          this.confirmedStream.cancel()
        } catch {
          // ignore
        }
      }
      this.confirmedStream = undefined
    }
  }

  private isExpectedGrpcShutdown(err: any) {
    if (this.stoppingGrpc) return true
    if (err?.code === 1) return true
    const details = typeof err?.details === 'string' ? err.details : ''
    return details.toLowerCase().includes('cancelled')
  }

  private startGrpcLoops() {
    void this.runGrpcLoop(CommitmentLevel.PROCESSED, 'processed')
    void this.runGrpcLoop(CommitmentLevel.CONFIRMED, 'confirmed')

    setInterval(() => {
      if (!this.grpcWanted) return
      const id = this.pingId++
      this.stats.recordPing(id)
      try {
        this.processedStream?.write(this.currentReq(CommitmentLevel.PROCESSED, id), () => undefined)
        this.confirmedStream?.write(this.currentReq(CommitmentLevel.CONFIRMED, id), () => undefined)
      } catch {
        // ignore
      }
    }, 10_000)
  }

  private startClientHeartbeat() {
    const intervalMs = Math.min(30_000, Math.max(5_000, Math.floor(this.config.wsIdleTimeoutMs / 2)))
    setInterval(() => {
      const now = Date.now()
      const expiredSessions: ClientSession[] = []

      for (const session of this.sessions.values()) {
        if (session.connected && session.ws) {
          if (now - session.lastSeenAt > this.config.wsIdleTimeoutMs) {
            if (session.ws.readyState === session.ws.OPEN) {
              try {
                session.ws.terminate()
              } catch {
                // ignore
              }
            }
          } else if (session.ws.readyState === session.ws.OPEN) {
            try {
              session.ws.ping()
            } catch {
              // ignore
            }
          }
        }

        if (!session.connected && session.disconnectedAt !== undefined && this.config.grpcRetentionMs === 0) {
          expiredSessions.push(session)
        } else if (
          !session.connected &&
          session.disconnectedAt !== undefined &&
          now - session.disconnectedAt > this.config.grpcRetentionMs
        ) {
          expiredSessions.push(session)
        }
      }

      if (expiredSessions.length) {
        for (const session of expiredSessions) {
          this.sessions.delete(session.id)
        }
        this.updateSubscriptions()
      }

      this.trimBacklog(now)
    }, intervalMs)
  }

  private async runGrpcLoop(commitment: CommitmentLevel, label: CommitmentLabel) {
    while (true) {
      if (!this.grpcWanted) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      try {
        console.log(`[grpc] connecting ${label} -> ${this.config.grpcEndpoint}`)
        const stream = await this.connectStream(commitment, label)
        if (label === 'processed') this.processedStream = stream
        if (label === 'confirmed') this.confirmedStream = stream
        this.broadcastStatus(true)

        await new Promise<void>((resolve) => {
          stream.on('end', resolve)
          stream.on('close', resolve)
        })
      } catch (e) {
        console.error(`[grpc] ${label} loop error:`, e)
      } finally {
        if (label === 'processed') this.processedStream = undefined
        if (label === 'confirmed') this.confirmedStream = undefined
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  private connectedCount() {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.connected) count += 1
    }
    return count
  }

  private statsContext() {
    return {
      clients: this.connectedCount(),
      watchedAccounts: this.subscriptionAccounts.size,
      watchedMints: this.subscriptionMints.size,
      processedConnected: Boolean(this.processedStream),
      confirmedConnected: Boolean(this.confirmedStream),
      processedHeadSlot: this.processedHeadSlot,
      confirmedHeadSlot: this.confirmedHeadSlot
    }
  }
}
