import { Connection, PublicKey } from '@solana/web3.js'

export type TokenAccountInfo = {
  mint: string
  owner: string
  decimals: number
}

type RawTokenBalance = {
  accountIndex?: number | string
  account_index?: number | string
  mint?: string
  owner?: string
  uiTokenAmount?: { decimals?: number }
  ui_token_amount?: { decimals?: number }
}

export class TokenAccountCache {
  private cache = new Map<string, TokenAccountInfo>()
  private connection: Connection | null
  private rpcUrl?: string
  private hits = 0
  private misses = 0
  private fetches = 0
  private fetchErrors = 0
  private fetchTotalMs = 0
  private lastFetchAt?: number
  private lastFetchDurationMs?: number
  private lastFetchError?: string
  private evictions = 0
  private lastEvictedAt?: number
  private lastSetAt?: number

  constructor(private maxSize: number = 100000, rpcUrl: string | null = null) {
    this.rpcUrl = rpcUrl ?? undefined
    this.connection = rpcUrl ? new Connection(rpcUrl, 'confirmed') : null
  }

  get(tokenAccount: string): TokenAccountInfo | null {
    const info = this.cache.get(tokenAccount)
    if (info) {
      this.cache.delete(tokenAccount)
      this.cache.set(tokenAccount, info)
    }
    return info ?? null
  }

  set(tokenAccount: string, info: TokenAccountInfo): void {
    if (this.cache.has(tokenAccount)) {
      this.cache.delete(tokenAccount)
    }
    this.cache.set(tokenAccount, info)
    this.lastSetAt = Date.now()
    this.evictIfNeeded()
  }

  has(tokenAccount: string): boolean {
    return this.cache.has(tokenAccount)
  }

  async getOrFetch(tokenAccount: string): Promise<TokenAccountInfo | null> {
    const cached = this.get(tokenAccount)
    if (cached) {
      this.hits += 1
      return cached
    }
    this.misses += 1

    if (this.connection) {
      const fetched = await this.fetchFromRpc(tokenAccount)
      if (fetched) {
        this.set(tokenAccount, fetched)
        return fetched
      }
    }

    return null
  }

  populateFromTokenBalances(balances: RawTokenBalance[], accounts: string[]): void {
    for (const balance of balances) {
      const accountIndexRaw = balance.accountIndex ?? balance.account_index
      const accountIndex = Number.isFinite(Number(accountIndexRaw)) ? Number(accountIndexRaw) : undefined
      if (accountIndex === undefined) continue

      const tokenAccount = accounts[accountIndex]
      if (!tokenAccount) continue

      const mint = balance.mint
      const owner = balance.owner
      const decimals =
        balance.uiTokenAmount?.decimals ?? balance.ui_token_amount?.decimals ?? undefined

      if (!mint || !owner) continue
      if (this.has(tokenAccount)) {
        this.get(tokenAccount)
        continue
      }
      this.set(tokenAccount, {
        mint,
        owner,
        decimals: Number.isFinite(Number(decimals)) ? Number(decimals) : 0
      })
    }
  }

  private async fetchFromRpc(tokenAccount: string): Promise<TokenAccountInfo | null> {
    if (!this.connection) return null
    this.fetches += 1
    const startedAt = Date.now()

    try {
      const pubkey = new PublicKey(tokenAccount)
      const accountInfo = await this.connection.getParsedAccountInfo(pubkey)

      if (
        accountInfo.value?.data &&
        typeof accountInfo.value.data === 'object' &&
        'parsed' in accountInfo.value.data
      ) {
        const parsed = (accountInfo.value.data as { parsed?: any }).parsed
        if (parsed?.type === 'account' && parsed.info) {
          this.recordFetch(Date.now() - startedAt)
          return {
            mint: parsed.info.mint,
            owner: parsed.info.owner,
            decimals: parsed.info.tokenAmount?.decimals ?? 0
          }
        }
      }
      this.recordFetch(Date.now() - startedAt)
    } catch (error) {
      this.recordFetch(Date.now() - startedAt, error)
      console.warn(`[token-cache] failed to fetch token account ${tokenAccount}:`, error)
    }

    return null
  }

  getMetrics() {
    const avg =
      this.fetches > 0 ? Math.round((this.fetchTotalMs / this.fetches) * 100) / 100 : undefined
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      rpcEndpoint: this.rpcUrl,
      rpcEnabled: Boolean(this.connection),
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : undefined,
      fetches: this.fetches,
      fetchErrors: this.fetchErrors,
      avgFetchMs: avg,
      lastFetchAt: this.lastFetchAt ? new Date(this.lastFetchAt).toISOString() : undefined,
      lastFetchDurationMs: this.lastFetchDurationMs,
      lastFetchError: this.lastFetchError,
      evictions: this.evictions,
      lastEvictedAt: this.lastEvictedAt ? new Date(this.lastEvictedAt).toISOString() : undefined,
      lastSetAt: this.lastSetAt ? new Date(this.lastSetAt).toISOString() : undefined
    }
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (!oldest) break
      this.cache.delete(oldest)
      this.evictions += 1
      this.lastEvictedAt = Date.now()
    }
  }

  private recordFetch(durationMs: number, error?: unknown) {
    this.lastFetchAt = Date.now()
    this.lastFetchDurationMs = durationMs
    this.fetchTotalMs += durationMs
    if (error) {
      this.fetchErrors += 1
      this.lastFetchError = error instanceof Error ? error.message : String(error)
    } else {
      this.lastFetchError = undefined
    }
  }
}
