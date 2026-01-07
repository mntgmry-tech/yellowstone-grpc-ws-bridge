import BigNumber from 'bignumber.js'
import bs58 from 'bs58'
import { YellowstoneTokenBalanceChange } from '../types'

export function normalizePubkeyMaybe(b58: string): string | undefined {
  try {
    const bytes = bs58.decode(b58)
    return bs58.encode(bytes)
  } catch {
    return undefined
  }
}

function decodeAccountKey(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return normalizePubkeyMaybe(value) ?? ''
  if (value instanceof Uint8Array) {
    try {
      return bs58.encode(value)
    } catch {
      return ''
    }
  }
  if (Array.isArray(value)) {
    try {
      return bs58.encode(Uint8Array.from(value))
    } catch {
      return ''
    }
  }
  if (typeof value === 'object') {
    const data = (value as { data?: unknown }).data
    if (Array.isArray(data)) {
      try {
        return bs58.encode(Uint8Array.from(data))
      } catch {
        return ''
      }
    }
  }
  return ''
}

function decodeAccountKeys(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.map(decodeAccountKey).filter(Boolean)
}

function collectAccountKeys(updateTxInfo: any): string[] {
  const message =
    updateTxInfo?.message ??
    updateTxInfo?.transaction?.message ??
    updateTxInfo?.transaction?.transaction?.message ??
    updateTxInfo?.transaction?.transaction?.transaction?.message
  const meta =
    updateTxInfo?.meta ??
    updateTxInfo?.transaction?.meta ??
    updateTxInfo?.transaction?.transaction?.meta ??
    updateTxInfo?.transaction?.transaction?.transaction?.meta

  const messageValue = message ?? updateTxInfo
  const metaValue = meta ?? updateTxInfo

  const baseKeys = decodeAccountKeys(messageValue?.accountKeys ?? messageValue?.account_keys ?? [])
  const loadedWritable = decodeAccountKeys(
    metaValue?.loadedWritableAddresses ?? metaValue?.loaded_writable_addresses ?? []
  )
  const loadedReadonly = decodeAccountKeys(
    metaValue?.loadedReadonlyAddresses ?? metaValue?.loaded_readonly_addresses ?? []
  )

  return [...baseKeys, ...loadedWritable, ...loadedReadonly]
}

function bigIntSub(a: string, b: string): string {
  try {
    return (BigInt(a) - BigInt(b)).toString()
  } catch {
    return '0'
  }
}

function formatUiAmount(amount: string, decimals: number): string {
  try {
    if (!Number.isFinite(decimals) || decimals < 0) return amount
    const base = new BigNumber(amount)
    if (!base.isFinite()) return amount
    return base.shiftedBy(-decimals).toFixed()
  } catch {
    return amount
  }
}

export function extractTokenBalanceChanges(updateTxInfo: any): YellowstoneTokenBalanceChange[] {
  const meta =
    updateTxInfo?.meta ??
    updateTxInfo?.transaction?.meta ??
    updateTxInfo?.transaction?.transaction?.meta ??
    updateTxInfo?.transaction?.transaction?.transaction?.meta

  const accountKeys = collectAccountKeys(updateTxInfo)

  const pre = meta?.preTokenBalances ?? meta?.pre_token_balances ?? []
  const post = meta?.postTokenBalances ?? meta?.post_token_balances ?? []

  const byIndexMint = new Map<string, any>()
  for (const p of pre) {
    const key = `${p.accountIndex ?? p.account_index}:${p.mint}`
    byIndexMint.set(key, { pre: p, post: undefined })
  }
  for (const p of post) {
    const key = `${p.accountIndex ?? p.account_index}:${p.mint}`
    const existing = byIndexMint.get(key) ?? { pre: undefined, post: undefined }
    existing.post = p
    byIndexMint.set(key, existing)
  }

  const changes: YellowstoneTokenBalanceChange[] = []
  for (const [, v] of byIndexMint) {
    const preAmt = v.pre?.uiTokenAmount?.amount ?? v.pre?.ui_token_amount?.amount ?? '0'
    const postAmt = v.post?.uiTokenAmount?.amount ?? v.post?.ui_token_amount?.amount ?? '0'
    const decimals =
      v.post?.uiTokenAmount?.decimals ??
      v.post?.ui_token_amount?.decimals ??
      v.pre?.uiTokenAmount?.decimals ??
      v.pre?.ui_token_amount?.decimals ??
      0

    if (String(preAmt) === String(postAmt)) continue

    const accountIndexValue =
      v.post?.accountIndex ?? v.post?.account_index ?? v.pre?.accountIndex ?? v.pre?.account_index ?? undefined
    const accountIndex =
      typeof accountIndexValue === 'number' ? accountIndexValue : Number.parseInt(String(accountIndexValue), 10)
    const account =
      Number.isFinite(accountIndex) && accountIndex >= 0 && accountIndex < accountKeys.length
        ? accountKeys[accountIndex]
        : ''
    const mint = v.post?.mint ?? v.pre?.mint ?? ''
    const owner = v.post?.owner ?? v.pre?.owner ?? undefined

    const preStr = String(preAmt)
    const postStr = String(postAmt)
    const decimalsNum = Number(decimals) || 0
    const delta = bigIntSub(postStr, preStr)

    changes.push({
      account,
      mint,
      owner,
      decimals: decimalsNum,
      preAmount: preStr,
      preAmountUi: formatUiAmount(preStr, decimalsNum),
      postAmount: postStr,
      postAmountUi: formatUiAmount(postStr, decimalsNum),
      delta,
      deltaUi: formatUiAmount(delta, decimalsNum)
    })
  }

  return changes
}

export function filterTokenBalanceChanges(
  changes: YellowstoneTokenBalanceChange[],
  watchedAccounts: Set<string>,
  watchedMints: Set<string>
) {
  if (!changes.length) return changes
  if (watchedAccounts.size === 0 && watchedMints.size === 0) return []
  return changes.filter(
    (change) =>
      (change.account && watchedAccounts.has(change.account)) ||
      (change.owner && watchedAccounts.has(change.owner)) ||
      (change.mint && watchedMints.has(change.mint))
  )
}

export function matchesWatchlist(
  accounts: string[],
  changes: YellowstoneTokenBalanceChange[],
  watchedAccounts: Set<string>,
  watchedMints: Set<string>
) {
  if (watchedAccounts.size === 0 && watchedMints.size === 0) return false
  for (const account of accounts) {
    if (watchedAccounts.has(account) || watchedMints.has(account)) return true
  }
  for (const change of changes) {
    if (change.account && watchedAccounts.has(change.account)) return true
    if (change.owner && watchedAccounts.has(change.owner)) return true
    if (change.mint && watchedMints.has(change.mint)) return true
  }
  return false
}

export function extractAccounts(updateTxInfo: any): string[] {
  return collectAccountKeys(updateTxInfo)
}
