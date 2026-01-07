import { HealthServer } from './HealthServer'
import { NodeHealthMonitor } from './NodeHealthMonitor'
import { env } from './env'
import { BridgeServer } from './BridgeServer'
import { MongoApiKeyStore } from './apiKeys'

const start = async () => {
  const apiKeyStore = new MongoApiKeyStore(env.mongoUri, env.mongoDb, env.mongoApiKeysCollection)
  await apiKeyStore.connect()

  const healthMonitor = new NodeHealthMonitor({
    rpcEndpoint: env.rpcEndpoint,
    intervalMs: env.healthCheckIntervalMs,
    timeoutMs: env.healthCheckTimeoutMs
  })
  const server = new BridgeServer({
    wsBind: env.wsBind,
    wsPort: env.wsPort,
    wsIdleTimeoutMs: env.wsIdleTimeoutMs,
    grpcRetentionMs: env.grpcRetentionMs,
    grpcRetentionMaxEvents: env.grpcRetentionMaxEvents,
    confirmedTxBufferMs: env.confirmedTxBufferMs,
    grpcRetryBaseMs: env.grpcRetryBaseMs,
    grpcRetryMaxMs: env.grpcRetryMaxMs,
    wsRateLimitCount: env.wsRateLimitCount,
    wsRateLimitWindowMs: env.wsRateLimitWindowMs,
    filterTokenBalances: env.filterTokenBalances,
    tokenAccountCacheMaxSize: env.tokenAccountCacheMaxSize,
    grpcRequireHealthy: env.grpcRequireHealthy,
    healthCheckIntervalMs: env.healthCheckIntervalMs,
    healthCheckTimeoutMs: env.healthCheckTimeoutMs,
    healthCheckIntervalUnhealthyMs: env.healthCheckIntervalUnhealthyMs,
    blockCacheSize: env.blockCacheSize,
    grpcEndpoint: env.grpcEndpoint,
    solanaRpcUrl: env.solanaRpcUrl,
    xToken: env.xToken,
    healthMonitor,
    apiKeyStore
  })

  const healthServer = new HealthServer({
    bind: env.healthBind,
    port: env.healthPort,
    monitor: healthMonitor,
    statsProvider: () => server.getStatsSnapshot(),
    metricsProvider: () => server.getMetricsSnapshot(),
    apiKeyStore,
    onApiKeyRevoked: (apiKeyId) => server.disconnectByApiKeyId(apiKeyId)
  })

  healthMonitor.start()
  server.start()
  healthServer.start()
}

start().catch((error) => {
  console.error('[startup] failed to initialize', error)
  process.exit(1)
})
