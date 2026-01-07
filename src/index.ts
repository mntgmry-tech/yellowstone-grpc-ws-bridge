import { HealthServer } from './HealthServer'
import { NodeHealthMonitor } from './NodeHealthMonitor'
import { env } from './env'
import { BridgeServer } from './BridgeServer'
import { ApiKeyDocument, MongoApiKeyStore } from './apiKeys'
import { MongoPoolManager } from './utils/mongoPoolManager'

const start = async () => {
  MongoPoolManager.initialize({
    uri: env.mongoUri,
    dbName: env.mongoDb,
    connectTimeoutMs: env.mongoConnectTimeoutMs,
    socketTimeoutMs: env.mongoSocketTimeoutMs,
    maxPoolSize: env.mongoMaxPoolSize,
    minPoolSize: env.mongoMinPoolSize
  })
  const mongoPool = MongoPoolManager.getInstance()
  const apiKeyCollection = await mongoPool.createCollection<ApiKeyDocument>(env.mongoApiKeysCollection)
  const apiKeyStore = new MongoApiKeyStore(apiKeyCollection, {
    cacheMaxSize: env.apiKeyCacheMaxSize,
    lastUsedFlushMs: env.apiKeyLastUsedFlushMs
  })
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

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] received ${signal}, closing resources...`)
    try {
      await apiKeyStore.close()
    } catch (error) {
      console.error('[shutdown] failed to close api key store', error)
    }
    try {
      await MongoPoolManager.getInstance().close()
    } catch (error) {
      console.error('[shutdown] failed to close mongo pool', error)
    }
    process.exit(0)
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT']
  signals.forEach((signal) => {
    process.on(signal, () => {
      void shutdown(signal)
    })
  })
}

start().catch((error) => {
  console.error('[startup] failed to initialize', error)
  process.exit(1)
})
