import { BridgeServer } from './BridgeServer'
import { env } from './env'

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
  grpcEndpoint: env.grpcEndpoint,
  xToken: env.xToken
})

server.start()
