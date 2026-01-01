import dotenv from 'dotenv'

dotenv.config()

const grpcEndpointRaw = process.env.YELLOWSTONE_GRPC_ENDPOINT ?? '127.0.0.1:10000'

export const env = {
  wsBind: process.env.WS_BIND ?? '0.0.0.0',
  wsPort: parseInt(process.env.WS_PORT ?? '8787', 10),
  grpcEndpoint: grpcEndpointRaw.includes('://') ? grpcEndpointRaw : `http://${grpcEndpointRaw}`,
  xToken: process.env.YELLOWSTONE_X_TOKEN ?? ''
}
