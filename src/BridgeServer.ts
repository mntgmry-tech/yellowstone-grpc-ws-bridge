import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc'
import bs58 from 'bs58'
import { randomUUID } from 'crypto'
import { IncomingMessage } from 'http'
import { WebSocket } from 'ws'
import type { VerifyClientCallbackAsync } from 'ws'
import type { ApiKeyAuth, ApiKeyStore } from './apiKeys'
import { BlockCacheMetrics, BlockMetadataCache } from './blockCache'
import { RawInnerInstructions, RawInstruction } from './instructionParser'
import { NodeHealthMetrics, NodeHealthMonitor, NodeHealthStatus } from './NodeHealthMonitor'
import { TokenAccountCache } from './tokenAccountCache'
import {
  AccountData,
  ClientMsg,
  ClientOptions,
  CommitmentLabel,
  EnhancedTransactionEvent,
  EventFormat,
  RawTransactionEvent,
  WsEvent,
  YellowstoneTokenBalanceChange
} from './types'
import { RawTransactionData, transformTransaction } from './transactionTransformer'
import { RateLimiter } from './utils/rateLimit'
import { RingBuffer } from './utils/ringBuffer'
import { StatsSnapshot, StatsTracker } from './utils/stats'
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
  grpcRetentionMaxEvents: number
  confirmedTxBufferMs: number
  grpcRetryBaseMs: number
  grpcRetryMaxMs: number
  wsRateLimitCount: number
  wsRateLimitWindowMs: number
  filterTokenBalances: boolean
  tokenAccountCacheMaxSize: number
  grpcRequireHealthy: boolean
  healthCheckIntervalMs: number
  healthCheckTimeoutMs: number
  healthCheckIntervalUnhealthyMs: number
  blockCacheSize: number
  grpcEndpoint: string
  solanaRpcUrl: string
  xToken: string
  healthMonitor?: NodeHealthMonitor
  apiKeyStore?: ApiKeyStore
}

const grpcOptions = {
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
  'grpc.max_send_message_length': 64 * 1024 * 1024,
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 5_000
}

const bearerPattern = /^Bearer\s+(.+)$/i
const apiKeyPattern = /^[a-f0-9]{64}$/i
const maxAuthHeaderLength = 512
const clientIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/
const maxClientIdLength = 128

type BearerTokenResult = {
  token?: string
  error?: string
}

const extractBearerToken = (request?: IncomingMessage): BearerTokenResult => {
  if (!request) return { error: 'missing_request' }
  const header = request.headers.authorization
  if (!header) return { error: 'missing_authorization' }
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return { error: 'empty_authorization' }
  if (value.length > maxAuthHeaderLength) return { error: 'authorization_too_long' }
  const match = value.match(bearerPattern)
  let token = match?.[1]?.trim()
  if (!token) return { error: 'invalid_scheme' }
  while (bearerPattern.test(token)) {
    const nested = token.match(bearerPattern)
    if (!nested?.[1]) break
    token = nested[1].trim()
  }
  if (!token) return { error: 'empty_token' }
  if (!apiKeyPattern.test(token)) return { error: 'invalid_token_format' }
  return { token }
}

type ClientSession = {
  id: string
  apiKeyId?: string
  apiUserId?: string
  apiUserName?: string
  ws?: WebSocket
  connected: boolean
  createdAt: number
  lastSeenAt: number
  disconnectedAt?: number
  remote?: string
  options: ClientOptions
  watchAccounts: Set<string>
  watchMints: Set<string>
  rateLimiter: RateLimiter
  rateLimitDrops: number
  lastRateLimitAt?: number
  sentStatus: number
  sentTransactions: number
  lastSentAt?: number
}

type BacklogItem = {
  ts: number
  event: EnhancedTransactionEvent
  tokenBalanceChanges: YellowstoneTokenBalanceChange[]
}

type PendingConfirmedItem = {
  rawTx: RawTransactionData
  tokenBalanceChanges: YellowstoneTokenBalanceChange[]
}

type PendingConfirmedSlot = {
  slot: number
  createdAt: number
  items: PendingConfirmedItem[]
  timer?: ReturnType<typeof setTimeout>
}

type StopContext = {
  reason: string
  clientIds?: string[]
}

const defaultClientOptions: ClientOptions = {
  includeAccounts: true,
  includeTokenBalanceChanges: true,
  includeLogs: false,
  includeInstructions: false,
  eventFormat: 'raw',
  filterTokenBalances: false
}

type ClientMetrics = {
  id: string
  connected: boolean
  remote?: string
  createdAt: string
  lastSeenAt: string
  disconnectedAt?: string
  options: ClientOptions
  watchlist: {
    accounts: number
    mints: number
  }
  rateLimit: {
    limit: number
    windowMs: number
    drops: number
    lastDroppedAt?: string
  }
  sent: {
    status: number
    transactions: number
    total: number
  }
  lastSentAt?: string
}

export type BridgeMetricsSnapshot = {
  server: {
    now: string
    startedAt: string
    uptimeSec: number
  }
  node: {
    endpoint?: string
    status: NodeHealthStatus
    metrics?: NodeHealthMetrics
  }
  grpc: {
    endpoint: string
    wanted: boolean
    allowed: boolean
    retry: {
      baseMs: number
      maxMs: number
    }
    processed: {
      connected: boolean
      headSlot?: number
    }
    confirmed: {
      connected: boolean
      headSlot?: number
    }
    blocksMeta: {
      lastSlot?: number
      lastBlockTime?: number | null
      lastUpdatedAt?: string
    }
    lastStop?: {
      at?: string
      reason?: string
      clientIds?: string[]
    }
  }
  websocket: {
    clients: {
      connected: number
      retained: number
      total: number
      totalSeen: number
      wsHub: number
    }
    sent: {
      status: number
      transactions: number
      total: number
    }
  }
  clients: {
    total: number
    connected: number
    retained: number
    totalSeen: number
    byId: ClientMetrics[]
  }
  caches: {
    blockMeta: BlockCacheMetrics
    tokenAccount: ReturnType<TokenAccountCache['getMetrics']>
    confirmedBuffer: {
      slots: number
      items: number
      bufferMs: number
    }
    backlog: {
      size: number
      maxSize: number
      retentionMs: number
    }
  }
  rpc: {
    healthCheck?: {
      endpoint?: string
      checks?: number
      ok?: number
      errors?: number
      avgDurationMs?: number
      lastDurationMs?: number
    }
    tokenAccountLookup: {
      endpoint?: string
      enabled: boolean
      calls: number
      errors: number
      avgDurationMs?: number
      lastDurationMs?: number
      lastError?: string
      lastFetchAt?: string
    }
  }
  subscriptions: {
    accounts: number
    mints: number
  }
  stats: StatsSnapshot
}

export class BridgeServer {
  private grpcClient: Client
  private wsHub: WsHub
  private stats = new StatsTracker()
  private startedAt = Date.now()
  private totalClients = 0
  private apiKeyStore?: ApiKeyStore
  private pendingAuth = new WeakMap<IncomingMessage, ApiKeyAuth>()

  private sessions = new Map<string, ClientSession>()
  private socketToSession = new Map<WebSocket, ClientSession>()
  private backlog: RingBuffer<BacklogItem>
  private blockCache: BlockMetadataCache
  private tokenAccountCache: TokenAccountCache

  private subscriptionAccounts = new Set<string>()
  private subscriptionMints = new Set<string>()
  private subscriptionKey = ''
  private grpcWanted = false

  private processedStream: any | undefined
  private confirmedStream: any | undefined
  private processedHeadSlot: number | undefined
  private confirmedHeadSlot: number | undefined
  private blockMetaSlot: number | undefined
  private blockMetaTime: number | null | undefined
  private blockMetaUpdatedAt: number | undefined
  private blocksMetaLogged = false
  private pendingConfirmed = new Map<number, PendingConfirmedSlot>()
  private pendingConfirmedItems = 0

  private pingId = 1
  private pendingWrite = false
  private stoppingGrpc = false
  private stopResetTimer: ReturnType<typeof setTimeout> | undefined
  private lastStopAt?: number
  private lastStopContext?: StopContext
  private nodeHealthy = true
  private healthMonitor?: NodeHealthMonitor

  constructor(private config: BridgeConfig) {
    this.grpcClient = new Client(config.grpcEndpoint, config.xToken, grpcOptions)
    this.backlog = new RingBuffer<BacklogItem>(config.grpcRetentionMaxEvents)
    this.blockCache = new BlockMetadataCache(config.blockCacheSize)
    this.tokenAccountCache = new TokenAccountCache(config.tokenAccountCacheMaxSize, config.solanaRpcUrl)
    this.apiKeyStore = config.apiKeyStore
    this.wsHub = new WsHub({
      host: config.wsBind,
      port: config.wsPort,
      verifyClient: this.verifyWsClient,
      handlers: {
        onConnect: this.handleClientConnected,
        onMessage: this.handleClientMessage,
        onClose: this.handleClientClosed
      }
    })

    if (config.healthMonitor) {
      this.healthMonitor = config.healthMonitor
      this.nodeHealthy = config.healthMonitor.isHealthy()
      config.healthMonitor.onStatus(this.handleHealthStatus)
    }
  }

  private formatAuthRemote(request?: IncomingMessage) {
    const socket = request?.socket
    const addr = socket?.remoteAddress ?? 'unknown'
    const port = socket?.remotePort ?? '-'
    return `${addr}:${port}`
  }

  private verifyWsClient: VerifyClientCallbackAsync = (info, callback) => {
    const remote = this.formatAuthRemote(info.req)
    const parsed = extractBearerToken(info.req)
    if (!parsed.token) {
      console.warn(`[ws] auth rejected reason=${parsed.error ?? 'missing_token'} remote=${remote}`)
      this.stats.recordAuthFailure()
      callback(false, 401, 'unauthorized')
      return
    }

    if (!this.apiKeyStore?.ready()) {
      console.error('[ws] api key store unavailable, rejecting connection')
      callback(false, 503, 'auth_unavailable')
      return
    }

    this.apiKeyStore
      .validate(parsed.token)
      .then((apiKey) => {
        if (!apiKey) {
          console.warn(`[ws] auth rejected reason=invalid_api_key remote=${remote}`)
          this.stats.recordAuthFailure()
          callback(false, 401, 'unauthorized')
          return
        }
        this.pendingAuth.set(info.req, apiKey)
        callback(true)
      })
      .catch((error) => {
        console.warn(`[ws] auth error remote=${remote}:`, error)
        callback(false, 500, 'auth_error')
      })
  }

  start() {
    console.log(`[ws] listening on ws://${this.config.wsBind}:${this.config.wsPort}`)
    console.log(`[grpc] endpoint: ${this.config.grpcEndpoint} (x-token ${this.config.xToken ? 'set' : 'not set'})`)

    this.startGrpcLoops()
    this.startClientHeartbeat()
    this.stats.start(60_000, () => this.statsContext())
  }

  private handleClientConnected = (ws: WebSocket, request?: IncomingMessage) => {
    const apiKey = request ? this.pendingAuth.get(request) : undefined
    if (request) this.pendingAuth.delete(request)
    if (!apiKey) {
      ws.close(1008, 'unauthorized')
      return
    }
    ws.on('pong', () => this.touchClient(ws))

    const options = this.getInitialClientOptions(request)
    const { clientId, error } = this.getInitialClientId(request)
    if (error) {
      ws.close(1008, error)
      return
    }

    if (clientId) {
      const existing = this.sessions.get(clientId)
      if (existing) {
        if (!this.canResumeWithApiKey(apiKey, existing)) {
          console.warn(
            `[ws] resume denied clientId=${clientId} apiKeyId=${apiKey.id ?? 'unknown'} (${this.clientLabel(ws)})`
          )
          ws.close(1008, 'client_id_conflict')
          return
        }
        this.totalClients += 1
        this.attachSession(ws, existing, existing.disconnectedAt ?? existing.lastSeenAt)
        console.log(`[ws] client resumed clientId=${existing.id} (${this.clientLabel(ws)}) total=${this.connectedCount()}`)
        return
      }
      const session = this.createSession(ws, options, apiKey, clientId)
      console.log(
        `[ws] client connected clientId=${session.id} apiKeyId=${session.apiKeyId ?? 'unknown'} (${this.clientLabel(ws)}) total=${this.connectedCount()}`
      )
      this.sendStatus(session)
      return
    }

    const session = this.createSession(ws, options, apiKey)
    console.log(
      `[ws] client connected clientId=${session.id} apiKeyId=${session.apiKeyId ?? 'unknown'} (${this.clientLabel(ws)}) total=${this.connectedCount()}`
    )
    this.sendStatus(session)
  }

  private handleClientMessage = (ws: WebSocket, msg: ClientMsg) => {
    this.touchClient(ws)

    const session = this.socketToSession.get(ws)
    if (!session) return
    if (!this.allowClientMessage(session)) return

    if (msg.op === 'resume') {
      this.resumeSession(ws, msg.clientId, session)
      return
    }

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
        this.updateSubscriptions({ reason: 'watchlist_update', clientIds: [session.id] })
        break
      case 'addAccounts':
        this.applyList(session.watchAccounts, msg.accounts ?? [], 'add')
        this.updateSubscriptions({ reason: 'watchlist_update', clientIds: [session.id] })
        break
      case 'removeAccounts':
        this.applyList(session.watchAccounts, msg.accounts ?? [], 'remove')
        this.updateSubscriptions({ reason: 'watchlist_update', clientIds: [session.id] })
        break
      case 'setMints':
        this.applyList(session.watchMints, msg.mints ?? [], 'set')
        this.updateSubscriptions({ reason: 'watchlist_update', clientIds: [session.id] })
        break
      case 'addMints':
        this.applyList(session.watchMints, msg.mints ?? [], 'add')
        this.updateSubscriptions({ reason: 'watchlist_update', clientIds: [session.id] })
        break
      case 'removeMints':
        this.applyList(session.watchMints, msg.mints ?? [], 'remove')
        this.updateSubscriptions({ reason: 'watchlist_update', clientIds: [session.id] })
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
    this.updateSubscriptions({ reason: 'disconnect', clientIds: [session.id] })
    const reasonSuffix = reason ? ` reason="${reason}"` : ''
    console.log(
      `[ws] client disconnected clientId=${session.id} (${this.clientLabel(ws)}) code=${code}${reasonSuffix} total=${this.connectedCount()}`
    )
  }

  private createSession(
    ws: WebSocket,
    options?: Partial<ClientOptions>,
    apiKey?: ApiKeyAuth,
    clientId?: string
  ): ClientSession {
    const session: ClientSession = {
      id: clientId ?? randomUUID(),
      apiKeyId: apiKey?.id,
      apiUserId: apiKey?.userId,
      apiUserName: apiKey?.userName,
      ws,
      connected: true,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      remote: this.clientLabel(ws),
      options: { ...defaultClientOptions, filterTokenBalances: this.config.filterTokenBalances, ...options },
      watchAccounts: new Set<string>(),
      watchMints: new Set<string>(),
      rateLimiter: new RateLimiter(this.config.wsRateLimitCount, this.config.wsRateLimitWindowMs),
      rateLimitDrops: 0,
      sentStatus: 0,
      sentTransactions: 0
    }
    this.totalClients += 1
    this.sessions.set(session.id, session)
    this.socketToSession.set(ws, session)
    return session
  }

  private resumeSession(ws: WebSocket, clientId: string, current: ClientSession) {
    const target = this.sessions.get(clientId)
    if (!target) {
      this.sendStatus(current)
      return
    }

    if (!this.canResumeSession(current, target)) {
      console.warn(
        `[ws] resume denied clientId=${current.id} targetId=${target.id} apiKeyId=${current.apiKeyId ?? 'unknown'}`
      )
      this.sendStatus(current)
      return
    }

    if (current.id !== target.id) {
      this.removeSession(current, 'resume_replaced')
    }
    this.attachSession(ws, target, target.disconnectedAt ?? target.lastSeenAt)
    console.log(`[ws] client resumed clientId=${target.id} (${this.clientLabel(ws)}) total=${this.connectedCount()}`)
  }

  private canResumeSession(current: ClientSession, target: ClientSession) {
    if (!current.apiKeyId || !target.apiKeyId) return false
    return current.apiKeyId === target.apiKeyId
  }

  private canResumeWithApiKey(apiKey: ApiKeyAuth | undefined, target: ClientSession) {
    if (!apiKey?.id || !target.apiKeyId) return false
    return apiKey.id === target.apiKeyId
  }

  private attachSession(ws: WebSocket, target: ClientSession, resumeFrom?: number) {
    if (target.ws && target.ws !== ws) {
      try {
        target.ws.terminate()
      } catch {
        // ignore
      }
      this.socketToSession.delete(target.ws)
    }

    target.ws = ws
    target.connected = true
    target.remote = this.clientLabel(ws)
    target.lastSeenAt = Date.now()
    target.disconnectedAt = undefined
    this.socketToSession.set(ws, target)

    this.sendStatus(target)
    if (resumeFrom !== undefined) {
      this.replayBacklog(target, resumeFrom)
    }
  }

  private removeSession(session: ClientSession, reason: string) {
    if (session.ws) {
      this.socketToSession.delete(session.ws)
    }
    this.sessions.delete(session.id)
    this.updateSubscriptions({ reason, clientIds: [session.id] })
  }

  private sendStatus(session: ClientSession) {
    const ws = session.ws
    if (!ws) return
    const msg = this.buildStatusEvent(session)
    const sent = this.wsHub.send(ws, msg)
    if (sent) {
      session.sentStatus += 1
      session.lastSentAt = Date.now()
      this.stats.recordWsEvent(msg.type, 1)
    }
  }

  private allowClientMessage(session: ClientSession) {
    const now = Date.now()
    if (session.rateLimiter.allow(now)) return true
    session.rateLimitDrops += 1
    session.lastRateLimitAt = now
    if (session.rateLimiter.shouldWarn(now)) {
      console.warn(
        `[ws] rate limit exceeded clientId=${session.id} limit=${session.rateLimiter.getLimit()} windowMs=${session.rateLimiter.getWindowMs()}`
      )
    }
    return false
  }

  private broadcastStatus(grpcConnectedOverride?: boolean) {
    let delivered = 0
    for (const session of this.sessions.values()) {
      if (!session.connected || !session.ws) continue
      const msg = this.buildStatusEvent(session, grpcConnectedOverride)
      const sent = this.wsHub.send(session.ws, msg)
      if (sent) {
        delivered += 1
        session.sentStatus += 1
        session.lastSentAt = Date.now()
      }
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
    msg: {
      includeAccounts?: boolean
      includeTokenBalanceChanges?: boolean
      includeLogs?: boolean
      includeInstructions?: boolean
      eventFormat?: EventFormat
      filterTokenBalances?: boolean
    }
  ) {
    if (typeof msg.includeAccounts === 'boolean') session.options.includeAccounts = msg.includeAccounts
    if (typeof msg.includeTokenBalanceChanges === 'boolean') {
      session.options.includeTokenBalanceChanges = msg.includeTokenBalanceChanges
    }
    if (typeof msg.includeLogs === 'boolean') session.options.includeLogs = msg.includeLogs
    if (typeof msg.includeInstructions === 'boolean') session.options.includeInstructions = msg.includeInstructions
    if (msg.eventFormat) {
      const format = this.normalizeEventFormat(msg.eventFormat)
      if (format) session.options.eventFormat = format
    }
    if (typeof msg.filterTokenBalances === 'boolean') {
      session.options.filterTokenBalances = msg.filterTokenBalances
    }
  }

  private getInitialClientOptions(request?: IncomingMessage): Partial<ClientOptions> {
    const url = this.parseRequestUrl(request)
    if (!url) return {}
    const formatParam = url.searchParams.get('format') ?? url.searchParams.get('eventFormat')
    const eventFormat = this.normalizeEventFormat(formatParam ?? undefined)
    return eventFormat ? { eventFormat } : {}
  }

  private getInitialClientId(request?: IncomingMessage): { clientId?: string; error?: string } {
    const url = this.parseRequestUrl(request)
    if (!url) return {}
    const raw = url.searchParams.get('clientId') ?? url.searchParams.get('client_id')
    if (raw === null) return {}
    const clientId = raw.trim()
    if (!clientId) return { error: 'client_id_empty' }
    if (clientId.length > maxClientIdLength) return { error: 'client_id_too_long' }
    if (!clientIdPattern.test(clientId)) return { error: 'client_id_invalid' }
    return { clientId }
  }

  private parseRequestUrl(request?: IncomingMessage): URL | undefined {
    if (!request?.url) return undefined
    const host = request.headers.host ?? 'localhost'
    try {
      return new URL(request.url, `http://${host}`)
    } catch {
      return undefined
    }
  }

  private normalizeEventFormat(value?: string): EventFormat | undefined {
    if (!value) return undefined
    const normalized = value.toLowerCase()
    if (normalized === 'raw' || normalized === 'enhanced') return normalized
    return undefined
  }

  private buildStatusEvent(session: ClientSession, grpcConnectedOverride?: boolean): WsEvent {
    return {
      type: 'status',
      clientId: session.id,
      now: new Date().toISOString(),
      grpcConnected: grpcConnectedOverride ?? this.grpcConnected(),
      nodeHealthy: this.nodeHealthy,
      processedHeadSlot: this.processedHeadSlot,
      confirmedHeadSlot: this.confirmedHeadSlot,
      watchedAccounts: session.watchAccounts.size,
      watchedMints: session.watchMints.size
    }
  }

  private grpcConnected() {
    return Boolean(this.processedStream || this.confirmedStream)
  }

  private grpcAllowed() {
    if (!this.grpcWanted) return false
    if (!this.config.grpcRequireHealthy) return true
    return this.nodeHealthy
  }

  private handleHealthStatus = (status: NodeHealthStatus) => {
    const wasHealthy = this.nodeHealthy
    this.nodeHealthy = status.ok

    if (this.healthMonitor) {
      const targetTimeout = status.ok ? this.config.healthCheckTimeoutMs : 1000
      const targetInterval = status.ok ? this.config.healthCheckIntervalMs : this.config.healthCheckIntervalUnhealthyMs
      if (this.healthMonitor.getTimeoutMs() !== targetTimeout) {
        this.healthMonitor.setTimeoutMs(targetTimeout)
      }
      if (this.healthMonitor.getIntervalMs() !== targetInterval) {
        this.healthMonitor.setIntervalMs(targetInterval)
      }
    }

    if (this.config.grpcRequireHealthy) {
      if (!status.ok) {
        this.stopGrpcStreams({ reason: 'node_unhealthy', clientIds: this.connectedClientIds() })
      } else if (this.grpcWanted) {
        this.scheduleResubscribe()
      }
    }

    if (wasHealthy !== status.ok) {
      this.broadcastStatus()
    }
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

  private prepareTransactionForSession(
    event: EnhancedTransactionEvent,
    tokenBalanceChanges: YellowstoneTokenBalanceChange[],
    session: ClientSession
  ): RawTransactionEvent | EnhancedTransactionEvent | undefined {
    const accounts = event.accounts ?? []
    if (!matchesWatchlist(accounts, tokenBalanceChanges, session.watchAccounts, session.watchMints)) return undefined

    if (session.options.eventFormat === 'raw') {
      const rawChanges = session.options.includeTokenBalanceChanges
        ? session.options.filterTokenBalances
          ? filterTokenBalanceChanges(tokenBalanceChanges, session.watchAccounts, session.watchMints)
          : tokenBalanceChanges
        : undefined

      return {
        type: 'transaction',
        commitment: event.commitment,
        slot: event.slot,
        signature: event.signature,
        isVote: event.isVote,
        index: event.index,
        err: event.err,
        accounts: session.options.includeAccounts ? accounts : undefined,
        tokenBalanceChanges: session.options.includeTokenBalanceChanges ? rawChanges : undefined,
        logs: session.options.includeLogs ? event.logs : undefined,
        computeUnitsConsumed: event.computeUnitsConsumed
      }
    }

    const tokenTransfers = session.options.includeTokenBalanceChanges ? event.tokenTransfers : []
    const accountData = session.options.includeTokenBalanceChanges
      ? this.filterAccountData(
          event.accountData,
          session.watchAccounts,
          session.watchMints,
          session.options.filterTokenBalances
        )
      : event.accountData.map((item) => ({ ...item, tokenBalanceChanges: [] }))

    return {
      ...event,
      accounts: session.options.includeAccounts ? accounts : undefined,
      tokenTransfers,
      accountData,
      logs: session.options.includeLogs ? event.logs : undefined,
      instructions: session.options.includeInstructions ? event.instructions : undefined
    }
  }

  private filterAccountData(
    accountData: AccountData[],
    watchedAccounts: Set<string>,
    watchedMints: Set<string>,
    filterTokenBalances: boolean
  ): AccountData[] {
    if (!accountData.length) return accountData
    if (!filterTokenBalances) return accountData
    if (watchedAccounts.size === 0 && watchedMints.size === 0) {
      return accountData.map((item) => ({ ...item, tokenBalanceChanges: [] }))
    }
    return accountData.map((item) => ({
      ...item,
      tokenBalanceChanges: item.tokenBalanceChanges.filter(
        (change) =>
          watchedAccounts.has(change.tokenAccount) ||
          watchedAccounts.has(change.userAccount) ||
          watchedMints.has(change.mint)
      )
    }))
  }

  private broadcastTransaction(event: EnhancedTransactionEvent, tokenBalanceChanges: YellowstoneTokenBalanceChange[]) {
    let delivered = 0
    for (const session of this.sessions.values()) {
      if (!session.connected || !session.ws) continue
      const payload = this.prepareTransactionForSession(event, tokenBalanceChanges, session)
      if (!payload) continue
      const sent = this.wsHub.send(session.ws, payload)
      if (sent) {
        delivered += 1
        session.sentTransactions += 1
        session.lastSentAt = Date.now()
      }
    }
    this.stats.recordWsEvent('transaction', delivered)
  }

  private updateSubscriptions(context?: StopContext) {
    const changed = this.updateSubscriptionUnion()
    const wantGrpc = this.subscriptionAccounts.size > 0 || this.subscriptionMints.size > 0
    const wasWanted = this.grpcWanted
    this.grpcWanted = wantGrpc

    if (!wantGrpc) {
      this.stopGrpcStreams(context)
      return
    }

    if (this.config.grpcRequireHealthy && !this.nodeHealthy) {
      this.stopGrpcStreams({ reason: 'node_unhealthy', clientIds: this.connectedClientIds() })
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
    const blocks: SubscribeRequest['blocks'] =
      commitment === CommitmentLevel.CONFIRMED
        ? {
            confirmed: {
              accountInclude: [],
              includeTransactions: false,
              includeAccounts: false,
              includeEntries: false
            }
          }
        : {}
    const blocksMeta: SubscribeRequest['blocksMeta'] =
      commitment === CommitmentLevel.CONFIRMED
        ? {
            confirmed: {}
          }
        : {}
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
      blocks,
      blocksMeta,
      entry: {},
      accountsDataSlice: [],
      ping: pingId !== undefined ? { id: pingId } : undefined,
      commitment
    }
  }

  private scheduleResubscribe() {
    if (this.pendingWrite || !this.grpcAllowed()) return
    this.pendingWrite = true
    setTimeout(async () => {
      this.pendingWrite = false
      await this.writeSubscriptionSafely()
    }, 200)
  }

  private async writeSubscriptionSafely() {
    if (!this.grpcAllowed()) return
    const writes: Array<Promise<void>> = []
    let wroteBlocksMeta = false

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
      wroteBlocksMeta = Boolean(req.blocksMeta && Object.keys(req.blocksMeta).length > 0)
      writes.push(
        new Promise<void>((resolve, reject) => {
          this.confirmedStream.write(req, (err: any) => (err ? reject(err) : resolve()))
        })
      )
    }

    if (!writes.length) return

    try {
      await Promise.all(writes)
      if (wroteBlocksMeta) {
        this.logBlocksMetaSubscribed('resubscribe')
      }
      this.broadcastStatus(true)
    } catch (e) {
      if (this.isIntentionalGrpcShutdown(e)) {
        return
      }
      this.broadcastStatus(false)
      console.error('[grpc] failed to write subscription:', e)
    }
  }

  private async connectStream(commitment: CommitmentLevel, label: CommitmentLabel): Promise<any> {
    const stream = await this.grpcClient.subscribe()

    stream.on('data', (data: any) => {
      void this.handleStreamData(label, data)
    })

    stream.on('error', (err: any) => {
      if (this.isIntentionalGrpcShutdown(err)) {
        this.logStreamCancelled(label)
        return
      }
      console.error(`[grpc] stream error (${label}):`, err)
      stream.end()
    })

    stream.on('end', () => {
      if (this.isStoppingRecently()) return
      console.error(`[grpc] stream ended (${label})`)
    })
    stream.on('close', () => {
      if (this.isStoppingRecently()) return
      console.error(`[grpc] stream closed (${label})`)
    })

    await new Promise<void>((resolve, reject) => {
      stream.write(this.currentReq(commitment), (err: any) => (err ? reject(err) : resolve()))
    })

    if (label === 'confirmed' && !this.blocksMetaLogged) {
      this.logBlocksMetaSubscribed('connect')
    }

    return stream
  }

  private async handleStreamData(label: CommitmentLabel, data: any) {
    const pongId = data?.pong?.id
    if (pongId !== undefined) {
      this.stats.recordPong(label, Number(pongId))
      return
    }

    const blockUpdate = data?.block ?? data?.blockMeta
    if (blockUpdate?.slot !== undefined) {
      this.handleBlockUpdate(blockUpdate)
      return
    }

    if (data?.slot?.slot !== undefined) {
      const s = Number(data.slot.slot)
      if (label === 'processed') this.processedHeadSlot = s
      if (label === 'confirmed') this.confirmedHeadSlot = s
      this.stats.recordSlot(label)
      return
    }

    const txWrapper = data?.transaction
    const txInfo = txWrapper?.transaction
    if (!txInfo) return

    const message = this.getTransactionMessage(txInfo)
    const meta = this.getTransactionMeta(txInfo)
    if (!message || !meta) return

    const accounts = extractAccounts({ message, meta })
    if (!accounts.length) return

    const tokenBalanceChanges = extractTokenBalanceChanges({ message, meta })
    const slot = Number(txWrapper?.slot ?? txInfo?.slot ?? 0)
    if (!Number.isFinite(slot)) return
    const signature = this.decodeSignature(txInfo.signature ?? txWrapper?.signature)
    const err = this.normalizeErr(meta?.err ?? meta?.status?.err ?? null)
    const logs: string[] | undefined = meta?.logMessages ?? meta?.log_messages ?? undefined
    const computeUnitsValue = meta?.computeUnitsConsumed ?? meta?.compute_units_consumed ?? undefined
    const computeUnitsConsumed = Number.isFinite(Number(computeUnitsValue)) ? Number(computeUnitsValue) : undefined
    const isVote = Boolean(txInfo.isVote ?? txInfo.is_vote ?? txWrapper?.isVote ?? txWrapper?.is_vote ?? false)
    const indexValue = txWrapper?.index ?? txInfo.index ?? 0
    const index = Number.isFinite(Number(indexValue)) ? Number(indexValue) : 0
    const preBalances = this.parseLamportBalances(meta?.preBalances ?? meta?.pre_balances ?? [])
    const postBalances = this.parseLamportBalances(meta?.postBalances ?? meta?.post_balances ?? [])
    const fee = this.parseLamports(meta?.fee ?? 0)

    const rawInstructions = Array.isArray(message?.instructions) ? (message.instructions as RawInstruction[]) : []
    const inner = meta?.innerInstructions ?? meta?.inner_instructions ?? null
    const rawInnerInstructions = Array.isArray(inner) ? (inner as RawInnerInstructions[]) : null

    const preTokenBalances = Array.isArray(meta?.preTokenBalances ?? meta?.pre_token_balances)
      ? (meta?.preTokenBalances ?? meta?.pre_token_balances)
      : []
    const postTokenBalances = Array.isArray(meta?.postTokenBalances ?? meta?.post_token_balances)
      ? (meta?.postTokenBalances ?? meta?.post_token_balances)
      : []

    const rawTx: RawTransactionData = {
      slot,
      signature,
      isVote,
      index,
      err,
      accounts,
      tokenBalanceChanges,
      preTokenBalances,
      postTokenBalances,
      computeUnitsConsumed: computeUnitsConsumed ?? 0,
      logs: logs && logs.length > 0 ? logs : undefined,
      fee,
      preBalances,
      postBalances,
      instructions: rawInstructions,
      innerInstructions: rawInnerInstructions
    }

    if (label === 'confirmed' && this.config.confirmedTxBufferMs > 0) {
      const cachedTime = this.blockCache.getBlockTime(slot)
      if (cachedTime === null || cachedTime === undefined) {
        this.bufferConfirmedTransaction(rawTx, tokenBalanceChanges)
        return
      }
    }

    await this.emitTransaction(rawTx, label, tokenBalanceChanges)
  }

  private handleBlockUpdate(update: any) {
    const slot = Number(update?.slot ?? 0)
    if (!Number.isFinite(slot)) return
    const blockTimeValue = update?.blockTime ?? update?.block_time
    let blockTime: number | null = null
    if (blockTimeValue && typeof blockTimeValue === 'object') {
      const timestamp =
        blockTimeValue.timestamp ?? blockTimeValue.value ?? blockTimeValue.seconds ?? blockTimeValue.sec ?? undefined
      if (timestamp !== undefined) blockTime = Number(timestamp)
    } else if (blockTimeValue !== undefined && blockTimeValue !== null) {
      blockTime = Number(blockTimeValue)
    }
    if (blockTime !== null && !Number.isFinite(blockTime)) blockTime = null
    const parentSlotValue = update?.parentSlot ?? update?.parent_slot ?? 0
    const parentSlot = Number(parentSlotValue)
    this.blockCache.set(slot, {
      slot,
      blockTime: Number.isFinite(blockTime) ? blockTime : null,
      parentSlot: Number.isFinite(parentSlot) ? parentSlot : 0
    })
    this.blockMetaSlot = slot
    this.blockMetaTime = Number.isFinite(blockTime) ? blockTime : null
    this.blockMetaUpdatedAt = Date.now()
    if (this.pendingConfirmed.has(slot)) {
      void this.flushConfirmedSlot(slot)
    }
  }

  private bufferConfirmedTransaction(rawTx: RawTransactionData, tokenBalanceChanges: YellowstoneTokenBalanceChange[]) {
    const slot = rawTx.slot
    let entry = this.pendingConfirmed.get(slot)
    if (!entry) {
      entry = {
        slot,
        createdAt: Date.now(),
        items: []
      }
      entry.timer = setTimeout(() => {
        void this.flushConfirmedSlot(slot)
      }, this.config.confirmedTxBufferMs)
      this.pendingConfirmed.set(slot, entry)
    }
    entry.items.push({ rawTx, tokenBalanceChanges })
    this.pendingConfirmedItems += 1
  }

  private async flushConfirmedSlot(slot: number) {
    const entry = this.pendingConfirmed.get(slot)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    this.pendingConfirmed.delete(slot)
    this.pendingConfirmedItems = Math.max(0, this.pendingConfirmedItems - entry.items.length)

    for (const item of entry.items) {
      await this.emitTransaction(item.rawTx, 'confirmed', item.tokenBalanceChanges)
    }
  }

  private async emitTransaction(
    rawTx: RawTransactionData,
    label: CommitmentLabel,
    tokenBalanceChanges: YellowstoneTokenBalanceChange[]
  ) {
    try {
      const ev: EnhancedTransactionEvent = await transformTransaction(
        rawTx,
        label,
        this.blockCache,
        this.tokenAccountCache
      )

      this.stats.recordTx(label)
      this.maybeBufferEvent(ev, tokenBalanceChanges)
      this.broadcastTransaction(ev, tokenBalanceChanges)
    } catch (err) {
      console.error('[grpc] failed to transform transaction:', err)
    }
  }

  private decodeSignature(value: unknown): string {
    if (!value) return ''
    if (typeof value === 'string') return value
    if (value instanceof Uint8Array) return bs58.encode(value)
    if (Array.isArray(value)) {
      try {
        return bs58.encode(Uint8Array.from(value))
      } catch {
        return ''
      }
    }
    return ''
  }


  private parseLamports(value: unknown): bigint {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 0n
      return BigInt(Math.trunc(value))
    }
    if (typeof value === 'string') {
      try {
        return BigInt(value)
      } catch {
        return 0n
      }
    }
    return 0n
  }

  private parseLamportBalances(value: unknown): bigint[] {
    if (!Array.isArray(value)) return []
    return value.map((v) => this.parseLamports(v))
  }

  private normalizeErr(err: unknown): object | null {
    if (!err) return null
    if (typeof err === 'object') return err as object
    return { message: String(err) }
  }

  private getTransactionMessage(updateTxInfo: any) {
    return (
      updateTxInfo?.transaction?.message ??
      updateTxInfo?.transaction?.transaction?.message ??
      updateTxInfo?.transaction?.transaction?.transaction?.message ??
      updateTxInfo?.message ??
      undefined
    )
  }

  private getTransactionMeta(updateTxInfo: any) {
    return (
      updateTxInfo?.meta ??
      updateTxInfo?.transaction?.meta ??
      updateTxInfo?.transaction?.transaction?.meta ??
      updateTxInfo?.transaction?.transaction?.transaction?.meta ??
      undefined
    )
  }

  private maybeBufferEvent(event: EnhancedTransactionEvent, tokenBalanceChanges: YellowstoneTokenBalanceChange[]) {
    if (this.config.grpcRetentionMs <= 0 || this.config.grpcRetentionMaxEvents <= 0) return
    const now = Date.now()
    if (!this.shouldBuffer(now)) {
      if (this.backlog.length) this.backlog.clear()
      return
    }
    this.backlog.push({ ts: now, event, tokenBalanceChanges })
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
    this.backlog.forEach((item) => {
      if (item.ts <= since) return
      const payload = this.prepareTransactionForSession(item.event, item.tokenBalanceChanges, session)
      if (!payload) return
      const sent = this.wsHub.send(session.ws as WebSocket, payload)
      if (sent) {
        delivered += 1
        session.sentTransactions += 1
        session.lastSentAt = Date.now()
      }
    })
    this.stats.recordWsEvent('transaction', delivered)
  }

  private trimBacklog(now: number) {
    const cutoff = now - this.config.grpcRetentionMs
    this.backlog.trimBefore(cutoff, (item) => item.ts)
  }

  private stopGrpcStreams(context?: StopContext) {
    this.markStopping(context)

    if (this.processedStream) {
      this.safeStopStream(this.processedStream)
      this.processedStream = undefined
    }
    if (this.confirmedStream) {
      this.safeStopStream(this.confirmedStream)
      this.confirmedStream = undefined
    }
  }

  private safeStopStream(stream: any) {
    try {
      if (typeof stream.end === 'function') stream.end()
    } catch {
      // ignore
    }
    try {
      if (typeof stream.cancel === 'function') stream.cancel()
    } catch {
      // ignore
    }
    try {
      if (typeof stream.removeAllListeners === 'function') {
        stream.removeAllListeners('data')
      }
    } catch {
      // ignore
    }
  }

  private markStopping(context?: StopContext) {
    this.stoppingGrpc = true
    this.lastStopAt = Date.now()
    this.lastStopContext = context
    if (this.stopResetTimer) clearTimeout(this.stopResetTimer)
    this.stopResetTimer = setTimeout(() => {
      this.stoppingGrpc = false
    }, 1000)
  }

  private isStoppingRecently() {
    if (!this.lastStopAt) return false
    return Date.now() - this.lastStopAt <= 10_000
  }

  private getRecentStopContext() {
    if (!this.isStoppingRecently()) return undefined
    return this.lastStopContext
  }

  private isCancelledError(err: any) {
    if (err?.code === 1 || err?.code === '1') return true
    if (typeof err?.code === 'string' && err.code.toUpperCase() === 'CANCELLED') return true
    const details = typeof err?.details === 'string' ? err.details : ''
    if (details.toLowerCase().includes('cancelled')) return true
    const message = typeof err?.message === 'string' ? err.message : ''
    return message.toLowerCase().includes('cancelled')
  }

  private isIntentionalGrpcShutdown(err: any) {
    if (!this.isCancelledError(err)) return false
    return this.stoppingGrpc || this.isStoppingRecently()
  }

  private logStreamCancelled(label: CommitmentLabel) {
    const context = this.getRecentStopContext()
    const reason = context?.reason ?? 'unknown'
    const clients = context?.clientIds?.length ? context.clientIds.join(',') : 'unknown'
    console.log(`[grpc] stream cancelled (${label}) for clientId=${clients} reason=${reason}`)
  }

  private logBlocksMetaSubscribed(source: 'connect' | 'resubscribe') {
    this.blocksMetaLogged = true
    console.log(`[grpc] subscribed blocksMeta (confirmed) source=${source}`)
  }

  private startGrpcLoops() {
    void this.runGrpcLoop(CommitmentLevel.PROCESSED, 'processed')
    void this.runGrpcLoop(CommitmentLevel.CONFIRMED, 'confirmed')

    setInterval(() => {
      if (!this.grpcAllowed()) return
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
        this.updateSubscriptions({ reason: 'retention_expired', clientIds: expiredSessions.map((s) => s.id) })
      }

      this.trimBacklog(now)
    }, intervalMs)
  }

  private async runGrpcLoop(commitment: CommitmentLevel, label: CommitmentLabel) {
    let attempt = 0
    while (true) {
      if (!this.grpcAllowed()) {
        attempt = 0
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      let failure = false
      try {
        if (label === 'confirmed') this.blocksMetaLogged = false
        console.log(`[grpc] connecting ${label} -> ${this.config.grpcEndpoint}`)
        const stream = await this.connectStream(commitment, label)
        if (label === 'processed') this.processedStream = stream
        if (label === 'confirmed') this.confirmedStream = stream
        this.broadcastStatus(true)

        await new Promise<void>((resolve) => {
          stream.on('end', resolve)
          stream.on('close', resolve)
        })
        const shouldRetry = this.grpcWanted && (!this.config.grpcRequireHealthy || this.nodeHealthy)
        if (shouldRetry && !this.stoppingGrpc) failure = true
      } catch (e) {
        if (this.isIntentionalGrpcShutdown(e)) {
          failure = false
          this.logStreamCancelled(label)
        } else {
          failure = true
          console.error(`[grpc] ${label} loop error:`, e)
        }
      } finally {
        if (label === 'processed') this.processedStream = undefined
        if (label === 'confirmed') this.confirmedStream = undefined
      }

      if (!failure) {
        attempt = 0
        continue
      }

      attempt += 1
      const delay = this.getRetryDelayMs(attempt)
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  private getRetryDelayMs(attempt: number) {
    if (attempt <= 0) return 0
    const base = this.config.grpcRetryBaseMs
    const max = this.config.grpcRetryMaxMs
    const exp = Math.min(max, base * 2 ** (attempt - 1))
    return Math.floor(Math.random() * exp)
  }

  private connectedClientIds() {
    const ids: string[] = []
    for (const session of this.sessions.values()) {
      if (session.connected) ids.push(session.id)
    }
    return ids
  }

  private connectedCount() {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.connected) count += 1
    }
    return count
  }

  disconnectByApiKeyId(apiKeyId: string, reason: string = 'api_key_revoked') {
    let disconnected = 0
    for (const session of this.sessions.values()) {
      if (session.apiKeyId !== apiKeyId) continue
      const ws = session.ws
      if (!ws) continue
      if (ws.readyState === ws.OPEN) {
        ws.close(1008, reason)
      } else {
        ws.terminate()
      }
      disconnected += 1
    }
    if (disconnected > 0) {
      console.log(`[ws] disconnected ${disconnected} session(s) for apiKeyId=${apiKeyId}`)
    }
    return disconnected
  }

  getStatsSnapshot(): StatsSnapshot {
    return this.stats.getSnapshot(this.statsContext())
  }

  getMetricsSnapshot(): BridgeMetricsSnapshot {
    const now = Date.now()
    const stats = this.stats.getSnapshot(this.statsContext(), now)
    const nodeStatus: NodeHealthStatus = this.healthMonitor?.getStatus() ?? { ok: this.nodeHealthy }
    const nodeMetrics: NodeHealthMetrics | undefined = this.healthMonitor?.getMetrics()
    const nodeEndpoint = this.healthMonitor?.getEndpoint()
    const tokenAccountMetrics = this.tokenAccountCache.getMetrics()
    const blockCacheMetrics = this.blockCache.getMetrics()
    const connected = this.connectedCount()
    const total = this.sessions.size
    const retained = total - connected
    const lastStop =
      this.lastStopAt || this.lastStopContext
        ? {
            at: this.lastStopAt ? new Date(this.lastStopAt).toISOString() : undefined,
            reason: this.lastStopContext?.reason,
            clientIds: this.lastStopContext?.clientIds
          }
        : undefined

    let sentStatusTotal = 0
    let sentTransactionsTotal = 0
    const clients: ClientMetrics[] = []

    for (const session of this.sessions.values()) {
      sentStatusTotal += session.sentStatus
      sentTransactionsTotal += session.sentTransactions
      clients.push({
        id: session.id,
        connected: session.connected,
        remote: session.remote,
        createdAt: new Date(session.createdAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
        disconnectedAt: session.disconnectedAt ? new Date(session.disconnectedAt).toISOString() : undefined,
        options: session.options,
        watchlist: {
          accounts: session.watchAccounts.size,
          mints: session.watchMints.size
        },
        rateLimit: {
          limit: session.rateLimiter.getLimit(),
          windowMs: session.rateLimiter.getWindowMs(),
          drops: session.rateLimitDrops,
          lastDroppedAt: session.lastRateLimitAt ? new Date(session.lastRateLimitAt).toISOString() : undefined
        },
        sent: {
          status: session.sentStatus,
          transactions: session.sentTransactions,
          total: session.sentStatus + session.sentTransactions
        },
        lastSentAt: session.lastSentAt ? new Date(session.lastSentAt).toISOString() : undefined
      })
    }

    return {
      server: {
        now: stats.now,
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSec: stats.uptimeSec
      },
      node: {
        endpoint: nodeEndpoint,
        status: nodeStatus,
        metrics: nodeMetrics
      },
      grpc: {
        endpoint: this.config.grpcEndpoint,
        wanted: this.grpcWanted,
        allowed: this.grpcAllowed(),
        retry: {
          baseMs: this.config.grpcRetryBaseMs,
          maxMs: this.config.grpcRetryMaxMs
        },
        processed: {
          connected: Boolean(this.processedStream),
          headSlot: this.processedHeadSlot
        },
        confirmed: {
          connected: Boolean(this.confirmedStream),
          headSlot: this.confirmedHeadSlot
        },
        blocksMeta: {
          lastSlot: this.blockMetaSlot,
          lastBlockTime: this.blockMetaTime ?? undefined,
          lastUpdatedAt: this.blockMetaUpdatedAt ? new Date(this.blockMetaUpdatedAt).toISOString() : undefined
        },
        lastStop
      },
      websocket: {
        clients: {
          connected,
          retained,
          total,
          totalSeen: this.totalClients,
          wsHub: this.wsHub.size
        },
        sent: {
          status: sentStatusTotal,
          transactions: sentTransactionsTotal,
          total: sentStatusTotal + sentTransactionsTotal
        }
      },
      clients: {
        total,
        connected,
        retained,
        totalSeen: this.totalClients,
        byId: clients
      },
      caches: {
        blockMeta: blockCacheMetrics,
        tokenAccount: tokenAccountMetrics,
        confirmedBuffer: {
          slots: this.pendingConfirmed.size,
          items: this.pendingConfirmedItems,
          bufferMs: this.config.confirmedTxBufferMs
        },
        backlog: {
          size: this.backlog.length,
          maxSize: this.config.grpcRetentionMaxEvents,
          retentionMs: this.config.grpcRetentionMs
        }
      },
      rpc: {
        healthCheck: nodeMetrics
          ? {
              endpoint: nodeEndpoint,
              checks: nodeMetrics.checks,
              ok: nodeMetrics.ok,
              errors: nodeMetrics.errors,
              avgDurationMs: nodeMetrics.avgDurationMs,
              lastDurationMs: nodeMetrics.lastDurationMs
            }
          : undefined,
        tokenAccountLookup: {
          endpoint: tokenAccountMetrics.rpcEndpoint,
          enabled: tokenAccountMetrics.rpcEnabled,
          calls: tokenAccountMetrics.fetches,
          errors: tokenAccountMetrics.fetchErrors,
          avgDurationMs: tokenAccountMetrics.avgFetchMs,
          lastDurationMs: tokenAccountMetrics.lastFetchDurationMs,
          lastError: tokenAccountMetrics.lastFetchError,
          lastFetchAt: tokenAccountMetrics.lastFetchAt
        }
      },
      subscriptions: {
        accounts: this.subscriptionAccounts.size,
        mints: this.subscriptionMints.size
      },
      stats
    }
  }

  private statsContext() {
    return {
      clients: this.connectedCount(),
      watchedAccounts: this.subscriptionAccounts.size,
      watchedMints: this.subscriptionMints.size,
      processedConnected: Boolean(this.processedStream),
      confirmedConnected: Boolean(this.confirmedStream),
      processedHeadSlot: this.processedHeadSlot,
      confirmedHeadSlot: this.confirmedHeadSlot,
      blockMetaSlot: this.blockMetaSlot,
      blockMetaTime: this.blockMetaTime,
      blockMetaUpdatedAt: this.blockMetaUpdatedAt
    }
  }
}
