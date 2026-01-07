import BigNumber from 'bignumber.js'
import bs58 from 'bs58'
import { AccountData, Instruction, TokenBalanceChange, TokenTransfer, YellowstoneTokenBalanceChange } from './types'
import { TokenAccountCache, TokenAccountInfo } from './tokenAccountCache'

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

enum TokenInstruction {
  Transfer = 3,
  TransferChecked = 12
}

type ParsedTokenTransfer = {
  fromTokenAccount: string
  toTokenAccount: string
  authority: string
  amount: bigint
  mint: string | null
  decimals: number | null
}

function parseTokenTransferInstruction(
  programId: string,
  accounts: string[],
  data: Buffer
): ParsedTokenTransfer | null {
  if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) {
    return null
  }

  if (data.length < 1) return null

  const discriminator = data[0]

  if (discriminator === TokenInstruction.Transfer) {
    if (data.length < 9 || accounts.length < 3) return null
    const amount = data.readBigUInt64LE(1)
    return {
      fromTokenAccount: accounts[0],
      toTokenAccount: accounts[1],
      authority: accounts[2],
      amount,
      mint: null,
      decimals: null
    }
  }

  if (discriminator === TokenInstruction.TransferChecked) {
    if (data.length < 10 || accounts.length < 4) return null
    const amount = data.readBigUInt64LE(1)
    const decimals = data[9]
    return {
      fromTokenAccount: accounts[0],
      toTokenAccount: accounts[2],
      authority: accounts[3],
      amount,
      mint: accounts[1],
      decimals
    }
  }

  return null
}

function decodeInstructionData(data: string): Buffer | null {
  try {
    return Buffer.from(bs58.decode(data))
  } catch {
    return null
  }
}

export async function buildTokenTransfers(
  instructions: Instruction[],
  tokenAccountCache: TokenAccountCache
): Promise<TokenTransfer[]> {
  const pending: ParsedTokenTransfer[] = []

  const collectTransfers = (ix: { programId: string; accounts: string[]; data: string }) => {
    const dataBuffer = decodeInstructionData(ix.data)
    if (!dataBuffer) return
    const parsed = parseTokenTransferInstruction(ix.programId, ix.accounts, dataBuffer)
    if (parsed) pending.push(parsed)
  }

  for (const ix of instructions) {
    collectTransfers(ix)
    for (const inner of ix.innerInstructions) {
      collectTransfers(inner)
    }
  }

  if (!pending.length) return []

  const lookupCache = new Map<string, Promise<TokenAccountInfo | null>>()
  const getInfo = (account: string) => {
    if (!lookupCache.has(account)) {
      lookupCache.set(account, tokenAccountCache.getOrFetch(account))
    }
    return lookupCache.get(account) as Promise<TokenAccountInfo | null>
  }

  const transfers: TokenTransfer[] = []

  for (const parsed of pending) {
    const [fromInfo, toInfo] = await Promise.all([
      getInfo(parsed.fromTokenAccount),
      getInfo(parsed.toTokenAccount)
    ])

    const mint = parsed.mint ?? fromInfo?.mint ?? toInfo?.mint ?? ''
    const decimals = parsed.decimals ?? fromInfo?.decimals ?? toInfo?.decimals ?? 0
    const tokenAmount = new BigNumber(parsed.amount.toString()).shiftedBy(-decimals).toNumber()

    transfers.push({
      fromTokenAccount: parsed.fromTokenAccount,
      toTokenAccount: parsed.toTokenAccount,
      fromUserAccount: fromInfo?.owner ?? parsed.authority ?? '',
      toUserAccount: toInfo?.owner ?? '',
      tokenAmount,
      mint,
      tokenStandard: 'Fungible'
    })
  }

  return transfers
}

export function buildAccountData(
  accounts: string[],
  preBalances: bigint[],
  postBalances: bigint[],
  tokenBalanceChanges: YellowstoneTokenBalanceChange[],
  filterTokenBalances = false,
  watchedAccounts: Set<string> = new Set(),
  watchedMints: Set<string> = new Set()
): AccountData[] {
  const tokenChangesByAccount = new Map<string, TokenBalanceChange[]>()

  for (const change of tokenBalanceChanges) {
    if (filterTokenBalances) {
      const isWatchedAccount =
        watchedAccounts.has(change.account) || (change.owner ? watchedAccounts.has(change.owner) : false)
      const isWatchedMint = watchedMints.has(change.mint)
      if (!isWatchedAccount && !isWatchedMint) {
        continue
      }
    }

    const existing = tokenChangesByAccount.get(change.account) ?? []
    existing.push({
      userAccount: change.owner ?? '',
      tokenAccount: change.account,
      rawTokenAmount: {
        tokenAmount: change.delta,
        decimals: change.decimals
      },
      mint: change.mint
    })
    tokenChangesByAccount.set(change.account, existing)
  }

  const accountData: AccountData[] = []

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i]
    const pre = preBalances[i] ?? 0n
    const post = postBalances[i] ?? 0n
    const nativeBalanceChange = Number(post - pre)
    const tokenChanges = tokenChangesByAccount.get(account) ?? []

    accountData.push({
      account,
      nativeBalanceChange,
      tokenBalanceChanges: tokenChanges
    })
  }

  return accountData
}

export { parseTokenTransferInstruction }
