import dotenv from 'dotenv'

dotenv.config()

const normalizeEndpoint = (value: string) => (value.includes('://') ? value : `http://${value}`)
const safeParseUrl = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

const legacyGrpcEndpointRaw = process.env.YELLOWSTONE_GRPC_ENDPOINT
const legacyGrpcEndpoint = legacyGrpcEndpointRaw ? normalizeEndpoint(legacyGrpcEndpointRaw) : undefined
const legacyGrpcUrl = legacyGrpcEndpoint ? safeParseUrl(legacyGrpcEndpoint) : undefined
const legacyGrpcHost = legacyGrpcUrl?.hostname
const legacyGrpcPort = legacyGrpcUrl?.port ? parseInt(legacyGrpcUrl.port, 10) : undefined

const hasExplicitHost = Boolean(process.env.YELLOWSTONE_HOST)
const hasExplicitGrpcPort = Boolean(process.env.YELLOWSTONE_GRPC_PORT)
const nodeHost = process.env.YELLOWSTONE_HOST ?? legacyGrpcHost ?? '127.0.0.1'
const grpcProtocol = process.env.YELLOWSTONE_GRPC_PROTOCOL ?? 'http'
const grpcPortRaw =
  process.env.YELLOWSTONE_GRPC_PORT ?? (!hasExplicitHost && legacyGrpcPort ? String(legacyGrpcPort) : undefined)
const grpcPortParsed = parseInt(grpcPortRaw ?? '10000', 10)
const grpcPort = Number.isFinite(grpcPortParsed) && grpcPortParsed > 0 ? grpcPortParsed : 10000

const rpcProtocol = process.env.YELLOWSTONE_RPC_PROTOCOL ?? 'http'
const rpcPortRaw = process.env.YELLOWSTONE_RPC_PORT ?? '8899'
const rpcPortParsed = parseInt(rpcPortRaw, 10)
const rpcPort = Number.isFinite(rpcPortParsed) && rpcPortParsed > 0 ? rpcPortParsed : 8899

const wsIdleTimeoutMsRaw = parseInt(process.env.WS_IDLE_TIMEOUT_MS ?? '120000', 10)
const wsIdleTimeoutMs = Number.isFinite(wsIdleTimeoutMsRaw) && wsIdleTimeoutMsRaw > 0 ? wsIdleTimeoutMsRaw : 120000
const grpcRetentionMsRaw = parseInt(process.env.GRPC_SUBSCRIPTION_RETENTION_MS ?? '120000', 10)
const grpcRetentionMs = Number.isFinite(grpcRetentionMsRaw) && grpcRetentionMsRaw >= 0 ? grpcRetentionMsRaw : 120000
const grpcRetentionMaxEventsRaw = parseInt(process.env.GRPC_RETENTION_MAX_EVENTS ?? '20000', 10)
const grpcRetentionMaxEvents =
  Number.isFinite(grpcRetentionMaxEventsRaw) && grpcRetentionMaxEventsRaw >= 0 ? grpcRetentionMaxEventsRaw : 20000
const confirmedTxBufferMsRaw = parseInt(process.env.CONFIRMED_TX_BUFFER_MS ?? '250', 10)
const confirmedTxBufferMs =
  Number.isFinite(confirmedTxBufferMsRaw) && confirmedTxBufferMsRaw >= 0 ? confirmedTxBufferMsRaw : 250
const grpcRetryBaseMsRaw = parseInt(process.env.GRPC_RETRY_BASE_MS ?? '1000', 10)
const grpcRetryBaseMs = Number.isFinite(grpcRetryBaseMsRaw) && grpcRetryBaseMsRaw > 0 ? grpcRetryBaseMsRaw : 1000
const grpcRetryMaxMsRaw = parseInt(process.env.GRPC_RETRY_MAX_MS ?? '30000', 10)
const grpcRetryMaxMsCandidate = Number.isFinite(grpcRetryMaxMsRaw) && grpcRetryMaxMsRaw > 0 ? grpcRetryMaxMsRaw : 30000
const grpcRetryMaxMs = Math.max(grpcRetryBaseMs, grpcRetryMaxMsCandidate)
const wsRateLimitCountRaw = parseInt(process.env.WS_RATE_LIMIT_COUNT ?? '25', 10)
const wsRateLimitCount = Number.isFinite(wsRateLimitCountRaw) && wsRateLimitCountRaw >= 0 ? wsRateLimitCountRaw : 25
const wsRateLimitWindowMsRaw = parseInt(process.env.WS_RATE_LIMIT_WINDOW_MS ?? '5000', 10)
const wsRateLimitWindowMs =
  Number.isFinite(wsRateLimitWindowMsRaw) && wsRateLimitWindowMsRaw >= 0 ? wsRateLimitWindowMsRaw : 5000

const filterTokenBalancesRaw = process.env.FILTER_TOKEN_BALANCES
const filterTokenBalances =
  filterTokenBalancesRaw === undefined
    ? false
    : ['true', '1', 'yes'].includes(filterTokenBalancesRaw.toLowerCase())

const tokenAccountCacheMaxSizeRaw = parseInt(process.env.TOKEN_ACCOUNT_CACHE_MAX_SIZE ?? '100000', 10)
const tokenAccountCacheMaxSize =
  Number.isFinite(tokenAccountCacheMaxSizeRaw) && tokenAccountCacheMaxSizeRaw > 0 ? tokenAccountCacheMaxSizeRaw : 100000

const grpcRequireHealthyRaw = process.env.GRPC_REQUIRE_HEALTHY
const grpcRequireHealthy =
  grpcRequireHealthyRaw === undefined
    ? true
    : !['false', '0', 'no'].includes(grpcRequireHealthyRaw.toLowerCase())

const blockCacheSizeRaw = parseInt(process.env.BLOCK_CACHE_SIZE ?? '500', 10)
const blockCacheSize = Number.isFinite(blockCacheSizeRaw) && blockCacheSizeRaw > 0 ? blockCacheSizeRaw : 500

const healthCheckIntervalRaw = parseInt(process.env.SOLANA_HEALTHCHECK_INTERVAL_MS ?? '30000', 10)
const healthCheckIntervalMs =
  Number.isFinite(healthCheckIntervalRaw) && healthCheckIntervalRaw > 0 ? healthCheckIntervalRaw : 30000
const healthCheckTimeoutRaw = parseInt(process.env.SOLANA_HEALTHCHECK_TIMEOUT_MS ?? '5000', 10)
const healthCheckTimeoutMs =
  Number.isFinite(healthCheckTimeoutRaw) && healthCheckTimeoutRaw > 0 ? healthCheckTimeoutRaw : 5000
const healthCheckIntervalUnhealthyRaw = parseInt(process.env.SOLANA_HEALTHCHECK_INTERVAL_UNHEALTHY_MS ?? '1000', 10)
const healthCheckIntervalUnhealthyMs =
  Number.isFinite(healthCheckIntervalUnhealthyRaw) && healthCheckIntervalUnhealthyRaw > 0
    ? healthCheckIntervalUnhealthyRaw
    : 1000
const healthPortRaw = parseInt(process.env.HEALTH_PORT ?? '8788', 10)
const healthPort = Number.isFinite(healthPortRaw) && healthPortRaw > 0 ? healthPortRaw : 8788

const apiKeyCacheMaxSizeRaw = parseInt(process.env.API_KEY_CACHE_MAX_SIZE ?? '100000', 10)
const apiKeyCacheMaxSize =
  Number.isFinite(apiKeyCacheMaxSizeRaw) && apiKeyCacheMaxSizeRaw > 0 ? apiKeyCacheMaxSizeRaw : 100000
const apiKeyLastUsedFlushRaw = parseInt(process.env.API_KEY_LAST_USED_FLUSH_MS ?? '15000', 10)
const apiKeyLastUsedFlushMs =
  Number.isFinite(apiKeyLastUsedFlushRaw) && apiKeyLastUsedFlushRaw >= 0 ? apiKeyLastUsedFlushRaw : 15000

const grpcEndpoint =
  legacyGrpcEndpoint && !hasExplicitHost && !hasExplicitGrpcPort
    ? legacyGrpcEndpoint
    : `${grpcProtocol}://${nodeHost}:${grpcPort}`
const solanaRpcUrlRaw = process.env.SOLANA_RPC_URL
const solanaRpcUrlCandidate = solanaRpcUrlRaw ? normalizeEndpoint(solanaRpcUrlRaw) : undefined
const solanaRpcUrl = solanaRpcUrlCandidate && safeParseUrl(solanaRpcUrlCandidate) ? solanaRpcUrlCandidate : undefined
const rpcEndpoint = solanaRpcUrl ?? `${rpcProtocol}://${nodeHost}:${rpcPort}`

const mongoUri = process.env.MONGO_URI ?? 'mongodb://admin:admin@127.0.0.1:27017/?authSource=admin'
const mongoDb = process.env.MONGO_DB ?? 'yellowstone_bridge'
const mongoApiKeysCollection = process.env.MONGO_API_KEYS_COLLECTION ?? 'api_keys'

export const env = {
  wsBind: process.env.WS_BIND ?? '0.0.0.0',
  wsPort: parseInt(process.env.WS_PORT ?? '8787', 10),
  wsIdleTimeoutMs,
  grpcRetentionMs,
  grpcRetentionMaxEvents,
  confirmedTxBufferMs,
  grpcRetryBaseMs,
  grpcRetryMaxMs,
  wsRateLimitCount,
  wsRateLimitWindowMs,
  filterTokenBalances,
  tokenAccountCacheMaxSize,
  grpcRequireHealthy,
  blockCacheSize,
  grpcEndpoint,
  rpcEndpoint,
  solanaRpcUrl: solanaRpcUrl ?? rpcEndpoint,
  healthBind: process.env.HEALTH_BIND ?? '0.0.0.0',
  healthPort,
  healthCheckIntervalMs,
  healthCheckTimeoutMs,
  healthCheckIntervalUnhealthyMs,
  xToken: process.env.YELLOWSTONE_X_TOKEN ?? '',
  mongoUri,
  mongoDb,
  mongoApiKeysCollection,
  apiKeyCacheMaxSize,
  apiKeyLastUsedFlushMs
}
