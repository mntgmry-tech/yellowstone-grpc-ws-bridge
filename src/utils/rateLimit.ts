export class RateLimiter {
  private windowStart = 0
  private count = 0
  private lastWarnAt = 0

  constructor(
    private limit: number,
    private windowMs: number
  ) {}

  allow(now = Date.now()) {
    if (this.limit <= 0 || this.windowMs <= 0) return true
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now
      this.count = 0
    }
    this.count += 1
    return this.count <= this.limit
  }

  shouldWarn(now = Date.now()) {
    if (this.windowMs <= 0) return false
    if (now - this.lastWarnAt >= this.windowMs) {
      this.lastWarnAt = now
      return true
    }
    return false
  }

  getLimit() {
    return this.limit
  }

  getWindowMs() {
    return this.windowMs
  }
}
