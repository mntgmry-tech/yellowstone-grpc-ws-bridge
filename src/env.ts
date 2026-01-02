import dotenv from 'dotenv'

dotenv.config()

const grpcEndpointRaw = process.env.YELLOWSTONE_GRPC_ENDPOINT ?? '127.0.0.1:10000'
const wsIdleTimeoutMsRaw = parseInt(process.env.WS_IDLE_TIMEOUT_MS ?? '120000', 10)
const wsIdleTimeoutMs = Number.isFinite(wsIdleTimeoutMsRaw) && wsIdleTimeoutMsRaw > 0 ? wsIdleTimeoutMsRaw : 120000
const grpcRetentionMsRaw = parseInt(process.env.GRPC_SUBSCRIPTION_RETENTION_MS ?? '120000', 10)
const grpcRetentionMs = Number.isFinite(grpcRetentionMsRaw) && grpcRetentionMsRaw >= 0 ? grpcRetentionMsRaw : 120000
const grpcRetentionMaxEventsRaw = parseInt(process.env.GRPC_RETENTION_MAX_EVENTS ?? '20000', 10)
const grpcRetentionMaxEvents =
  Number.isFinite(grpcRetentionMaxEventsRaw) && grpcRetentionMaxEventsRaw >= 0 ? grpcRetentionMaxEventsRaw : 20000
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

export const env = {
  wsBind: process.env.WS_BIND ?? '0.0.0.0',
  wsPort: parseInt(process.env.WS_PORT ?? '8787', 10),
  wsIdleTimeoutMs,
  grpcRetentionMs,
  grpcRetentionMaxEvents,
  grpcRetryBaseMs,
  grpcRetryMaxMs,
  wsRateLimitCount,
  wsRateLimitWindowMs,
  grpcEndpoint: grpcEndpointRaw.includes('://') ? grpcEndpointRaw : `http://${grpcEndpointRaw}`,
  xToken: process.env.YELLOWSTONE_X_TOKEN ?? ''
}
