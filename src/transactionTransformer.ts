import { EnhancedTransactionEvent, YellowstoneTokenBalanceChange } from './types'
import { BlockMetadataCache } from './blockCache'
import { deriveNativeTransfers } from './nativeTransfers'
import { buildAccountData, buildTokenTransfers } from './tokenTransfers'
import {
  instructionsToParsedInstructions,
  parseInstructions,
  RawInnerInstructions,
  RawInstruction
} from './instructionParser'
import { TokenAccountCache } from './tokenAccountCache'

export type RawTransactionData = {
  slot: number
  signature: string
  isVote: boolean
  index: number
  err: object | null
  accounts: string[]
  tokenBalanceChanges: YellowstoneTokenBalanceChange[]
  preTokenBalances: any[]
  postTokenBalances: any[]
  computeUnitsConsumed: number
  logs?: string[]
  fee: bigint
  preBalances: bigint[]
  postBalances: bigint[]
  instructions: RawInstruction[]
  innerInstructions: RawInnerInstructions[] | null
}

export async function transformTransaction(
  raw: RawTransactionData,
  commitment: 'processed' | 'confirmed',
  blockCache: BlockMetadataCache,
  tokenAccountCache: TokenAccountCache
): Promise<EnhancedTransactionEvent> {
  const accounts = raw.accounts
  const fee = raw.fee
  const preBalances = raw.preBalances
  const postBalances = raw.postBalances

  let timestamp: number | null = null
  if (commitment === 'confirmed') {
    timestamp = blockCache.getBlockTime(raw.slot)
  }

  const instructions = parseInstructions(raw.instructions, raw.innerInstructions, accounts)
  const parsedInstructions = instructionsToParsedInstructions(instructions)
  const nativeTransfers = deriveNativeTransfers(accounts, preBalances, postBalances, parsedInstructions, fee)

  tokenAccountCache.populateFromTokenBalances(raw.preTokenBalances, accounts)
  tokenAccountCache.populateFromTokenBalances(raw.postTokenBalances, accounts)

  const tokenTransfers = await buildTokenTransfers(instructions, tokenAccountCache)
  const accountData = buildAccountData(accounts, preBalances, postBalances, raw.tokenBalanceChanges)
  const feePayer = accounts[0] ?? ''

  const event: EnhancedTransactionEvent = {
    type: 'transaction',
    commitment,
    slot: raw.slot,
    signature: raw.signature,
    timestamp,
    isVote: raw.isVote,
    index: raw.index,
    err: raw.err,
    fee: Number(fee),
    feePayer,
    accounts,
    nativeTransfers,
    tokenTransfers,
    accountData,
    instructions,
    computeUnitsConsumed: raw.computeUnitsConsumed
  }

  if (raw.logs && raw.logs.length > 0) {
    event.logs = raw.logs
  }

  return event
}
