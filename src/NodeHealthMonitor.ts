import axios, { AxiosInstance } from 'axios'

export type NodeHealthStatus = {
  ok: boolean
  lastCheckedAt?: string
  lastOkAt?: string
  lastErrorAt?: string
  lastError?: string
}

type NodeHealthConfig = {
  rpcEndpoint: string
  intervalMs: number
  timeoutMs?: number
}

type NodeHealthListener = (status: NodeHealthStatus) => void

export class NodeHealthMonitor {
  private client: AxiosInstance
  private status: NodeHealthStatus = { ok: false }
  private timer?: ReturnType<typeof setTimeout>
  private inFlight = false
  private started = false
  private intervalMs: number
  private timeoutMs: number
  private listeners = new Set<NodeHealthListener>()

  constructor(private config: NodeHealthConfig) {
    const timeoutMs =
      typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : 5000
    this.timeoutMs = timeoutMs
    this.client = axios.create({
      baseURL: config.rpcEndpoint,
      timeout: this.timeoutMs,
      headers: { 'Content-Type': 'application/json' }
    })
    const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0 ? config.intervalMs : 1000
    this.intervalMs = Math.max(intervalMs, this.timeoutMs)
  }

  start() {
    if (this.started) return
    this.started = true
    void this.runOnce()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.started = false
  }

  onStatus(listener: NodeHealthListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getIntervalMs() {
    return this.intervalMs
  }

  getTimeoutMs() {
    return this.timeoutMs
  }

  setIntervalMs(intervalMs: number) {
    const next = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined
    if (!next || next === this.intervalMs) return
    const clamped = Math.max(next, this.timeoutMs)
    if (clamped === this.intervalMs) return
    this.intervalMs = clamped
    if (this.started && !this.inFlight) {
      this.scheduleNext(this.intervalMs)
    }
  }

  setTimeoutMs(timeoutMs: number) {
    const next = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined
    if (!next || next === this.timeoutMs) return
    this.timeoutMs = next
    this.client.defaults.timeout = next
    if (this.intervalMs < next) {
      this.intervalMs = next
    }
    if (this.started && !this.inFlight) {
      this.scheduleNext(this.intervalMs)
    }
  }

  isHealthy() {
    return this.status.ok
  }

  getEndpoint() {
    return this.config.rpcEndpoint
  }

  getStatus(): NodeHealthStatus {
    return { ...this.status }
  }

  private async checkNow() {
    if (this.inFlight) return
    this.inFlight = true
    const now = new Date().toISOString()
    const startedAt = Date.now()

    try {
      const response = await this.client.post('/', {
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth'
      })
      const ok = response.data?.result === 'ok'
      const durationMs = Date.now() - startedAt
      if (ok) {
        this.status = {
          ...this.status,
          ok: true,
          lastCheckedAt: now,
          lastOkAt: now,
          lastErrorAt: undefined,
          lastError: undefined
        }
        console.log(`[health] rpc ok endpoint=${this.config.rpcEndpoint} durationMs=${durationMs}`)
        return
      }

      const error = this.formatResponseError(response.data)
      this.status = {
        ...this.status,
        ok: false,
        lastCheckedAt: now,
        lastErrorAt: now,
        lastError: error
      }
      console.warn(`[health] rpc unhealthy endpoint=${this.config.rpcEndpoint} durationMs=${durationMs} error="${error}"`)
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const error = this.formatError(err)
      this.status = {
        ...this.status,
        ok: false,
        lastCheckedAt: now,
        lastErrorAt: now,
        lastError: error
      }
      console.warn(`[health] rpc unhealthy endpoint=${this.config.rpcEndpoint} durationMs=${durationMs} error="${error}"`)
    } finally {
      this.inFlight = false
      this.emitStatus()
    }
  }

  private formatResponseError(data: unknown) {
    if (data && typeof data === 'object') {
      const record = data as { error?: { message?: string } }
      if (record.error?.message) return record.error.message
    }
    return `unexpected response ${this.safeStringify(data)}`
  }

  private formatError(err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status
      const data = err.response?.data
      const detail = this.formatResponseError(data)
      if (status) return `${detail} (status ${status})`
      return err.message
    }
    if (err instanceof Error) return err.message
    return this.safeStringify(err)
  }

  private safeStringify(value: unknown) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  private emitStatus() {
    if (!this.listeners.size) return
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore listener errors
      }
    }
  }

  private async runOnce() {
    await this.checkNow()
    if (!this.started) return
    this.scheduleNext(this.intervalMs)
  }

  private scheduleNext(intervalMs: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.runOnce()
    }, intervalMs)
  }
}
