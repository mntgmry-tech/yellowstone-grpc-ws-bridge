import express from 'express'
import { NodeHealthMonitor } from './NodeHealthMonitor'

type HealthServerConfig = {
  bind: string
  port: number
  monitor: NodeHealthMonitor
}

export class HealthServer {
  private app = express()
  private server?: ReturnType<typeof this.app.listen>

  constructor(private config: HealthServerConfig) {
    this.app.disable('x-powered-by')
    this.app.get('/health', (_req, res) => {
      const node = this.config.monitor.getStatus()
      const ok = node.ok
      res.status(ok ? 200 : 503).json({
        ok,
        now: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        node: {
          endpoint: this.config.monitor.getEndpoint(),
          ...node
        }
      })
    })
  }

  start() {
    this.server = this.app.listen(this.config.port, this.config.bind, () => {
      console.log(`[health] listening on http://${this.config.bind}:${this.config.port}/health`)
    })
  }

  stop() {
    if (this.server) this.server.close()
    this.server = undefined
  }
}
