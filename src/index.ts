import { BridgeServer } from './BridgeServer'
import { env } from './env'

const server = new BridgeServer({
  wsBind: env.wsBind,
  wsPort: env.wsPort,
  wsIdleTimeoutMs: env.wsIdleTimeoutMs,
  grpcRetentionMs: env.grpcRetentionMs,
  grpcEndpoint: env.grpcEndpoint,
  xToken: env.xToken
})

server.start()
