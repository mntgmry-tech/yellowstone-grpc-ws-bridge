export type BlockMetadata = {
  slot: number
  blockTime: number | null
  parentSlot: number
}

export type BlockCacheMetrics = {
  size: number
  maxSize: number
  lastSlot?: number
  lastBlockTime?: number | null
  lastUpdatedAt?: string
  evictions: number
  lastEvictedAt?: string
}

export class BlockMetadataCache {
  private cache = new Map<number, BlockMetadata>()
  private lastSlot?: number
  private lastBlockTime?: number | null
  private lastUpdatedAt?: number
  private evictions = 0
  private lastEvictedAt?: number

  constructor(private maxSize: number = 500) {}

  set(slot: number, metadata: BlockMetadata): void {
    this.cache.set(slot, metadata)
    this.lastSlot = slot
    this.lastBlockTime = metadata.blockTime
    this.lastUpdatedAt = Date.now()
    this.evictOldEntries()
  }

  get(slot: number): BlockMetadata | null {
    return this.cache.get(slot) ?? null
  }

  getBlockTime(slot: number): number | null {
    const metadata = this.cache.get(slot)
    return metadata?.blockTime ?? null
  }

  has(slot: number): boolean {
    return this.cache.has(slot)
  }

  size(): number {
    return this.cache.size
  }

  getMetrics(): BlockCacheMetrics {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      lastSlot: this.lastSlot,
      lastBlockTime: this.lastBlockTime ?? undefined,
      lastUpdatedAt: this.lastUpdatedAt ? new Date(this.lastUpdatedAt).toISOString() : undefined,
      evictions: this.evictions,
      lastEvictedAt: this.lastEvictedAt ? new Date(this.lastEvictedAt).toISOString() : undefined
    }
  }

  private evictOldEntries(): void {
    if (this.cache.size <= this.maxSize) return
    const slots = [...this.cache.keys()].sort((a, b) => a - b)
    const countToRemove = this.cache.size - this.maxSize
    for (let i = 0; i < countToRemove; i += 1) {
      this.cache.delete(slots[i])
      this.evictions += 1
      this.lastEvictedAt = Date.now()
    }
  }
}
