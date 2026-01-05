import { HealthServer } from './HealthServer'
import { NodeHealthMonitor } from './NodeHealthMonitor'
import { env } from './env'
import { BridgeServer } from './BridgeServer'

const healthMonitor = new NodeHealthMonitor({
  rpcEndpoint: env.rpcEndpoint,
  intervalMs: env.healthCheckIntervalMs,
  timeoutMs: env.healthCheckTimeoutMs
})
const healthServer = new HealthServer({
  bind: env.healthBind,
  port: env.healthPort,
  monitor: healthMonitor
})

const server = new BridgeServer({
  wsBind: env.wsBind,
  wsPort: env.wsPort,
  wsIdleTimeoutMs: env.wsIdleTimeoutMs,
  grpcRetentionMs: env.grpcRetentionMs,
  grpcRetentionMaxEvents: env.grpcRetentionMaxEvents,
  grpcRetryBaseMs: env.grpcRetryBaseMs,
  grpcRetryMaxMs: env.grpcRetryMaxMs,
  wsRateLimitCount: env.wsRateLimitCount,
  wsRateLimitWindowMs: env.wsRateLimitWindowMs,
  grpcRequireHealthy: env.grpcRequireHealthy,
  healthCheckIntervalMs: env.healthCheckIntervalMs,
  healthCheckTimeoutMs: env.healthCheckTimeoutMs,
  healthCheckIntervalUnhealthyMs: env.healthCheckIntervalUnhealthyMs,
  grpcEndpoint: env.grpcEndpoint,
  xToken: env.xToken,
  healthMonitor
})

healthMonitor.start()
healthServer.start()
server.start()
