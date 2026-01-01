import dotenv from 'dotenv'

dotenv.config()

const grpcEndpointRaw = process.env.YELLOWSTONE_GRPC_ENDPOINT ?? '127.0.0.1:10000'
const wsIdleTimeoutMsRaw = parseInt(process.env.WS_IDLE_TIMEOUT_MS ?? '120000', 10)
const wsIdleTimeoutMs = Number.isFinite(wsIdleTimeoutMsRaw) && wsIdleTimeoutMsRaw > 0 ? wsIdleTimeoutMsRaw : 120000
const grpcRetentionMsRaw = parseInt(process.env.GRPC_SUBSCRIPTION_RETENTION_MS ?? '120000', 10)
const grpcRetentionMs = Number.isFinite(grpcRetentionMsRaw) && grpcRetentionMsRaw >= 0 ? grpcRetentionMsRaw : 120000

export const env = {
  wsBind: process.env.WS_BIND ?? '0.0.0.0',
  wsPort: parseInt(process.env.WS_PORT ?? '8787', 10),
  wsIdleTimeoutMs,
  grpcRetentionMs,
  grpcEndpoint: grpcEndpointRaw.includes('://') ? grpcEndpointRaw : `http://${grpcEndpointRaw}`,
  xToken: process.env.YELLOWSTONE_X_TOKEN ?? ''
}
