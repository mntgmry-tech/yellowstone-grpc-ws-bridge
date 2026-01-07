import { NativeTransfer } from './types'

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'

enum SystemInstruction {
  CreateAccount = 0,
  Assign = 1,
  Transfer = 2,
  CreateAccountWithSeed = 3,
  AdvanceNonceAccount = 4,
  WithdrawNonceAccount = 5,
  InitializeNonceAccount = 6,
  AuthorizeNonceAccount = 7,
  Allocate = 8,
  AllocateWithSeed = 9,
  AssignWithSeed = 10,
  TransferWithSeed = 11,
  UpgradeNonceAccount = 12
}

export type ParsedInstruction = {
  programId: string
  accounts: string[]
  data: Buffer
  innerInstructions?: ParsedInstruction[]
}

export function parseSystemInstruction(data: Buffer, accounts: string[]): NativeTransfer | null {
  if (data.length < 4) return null
  const discriminator = data.readUInt32LE(0)

  switch (discriminator) {
    case SystemInstruction.Transfer: {
      if (data.length < 12 || accounts.length < 2) return null
      const lamports = data.readBigUInt64LE(4)
      return {
        fromUserAccount: accounts[0],
        toUserAccount: accounts[1],
        amount: Number(lamports)
      }
    }
    case SystemInstruction.CreateAccount: {
      if (data.length < 12 || accounts.length < 2) return null
      const lamports = data.readBigUInt64LE(4)
      return {
        fromUserAccount: accounts[0],
        toUserAccount: accounts[1],
        amount: Number(lamports)
      }
    }
    case SystemInstruction.CreateAccountWithSeed: {
      if (accounts.length < 2) return null
      return null
    }
    case SystemInstruction.WithdrawNonceAccount: {
      if (data.length < 12 || accounts.length < 2) return null
      const lamports = data.readBigUInt64LE(4)
      return {
        fromUserAccount: accounts[0],
        toUserAccount: accounts[1],
        amount: Number(lamports)
      }
    }
    case SystemInstruction.TransferWithSeed: {
      if (data.length < 12 || accounts.length < 3) return null
      const lamports = data.readBigUInt64LE(4)
      return {
        fromUserAccount: accounts[0],
        toUserAccount: accounts[2],
        amount: Number(lamports)
      }
    }
    default:
      return null
  }
}

export function flattenInstructions(instructions: ParsedInstruction[]): ParsedInstruction[] {
  const result: ParsedInstruction[] = []
  for (const ix of instructions) {
    result.push(ix)
    if (ix.innerInstructions && ix.innerInstructions.length > 0) {
      result.push(...flattenInstructions(ix.innerInstructions))
    }
  }
  return result
}

export function deriveNativeTransfers(
  accounts: string[],
  preBalances: bigint[],
  postBalances: bigint[],
  instructions: ParsedInstruction[],
  fee: bigint
): NativeTransfer[] {
  const transfers: NativeTransfer[] = []
  const allInstructions = flattenInstructions(instructions)

  for (const ix of allInstructions) {
    if (ix.programId !== SYSTEM_PROGRAM_ID) continue
    const transfer = parseSystemInstruction(ix.data, ix.accounts)
    if (transfer) transfers.push(transfer)
  }

  const explainedChanges = new Map<string, bigint>()

  for (const t of transfers) {
    const amount = Number.isFinite(t.amount) ? BigInt(Math.trunc(t.amount)) : 0n
    const fromPrev = explainedChanges.get(t.fromUserAccount) ?? 0n
    explainedChanges.set(t.fromUserAccount, fromPrev - amount)

    const toPrev = explainedChanges.get(t.toUserAccount) ?? 0n
    explainedChanges.set(t.toUserAccount, toPrev + amount)
  }

  const feePayer = accounts[0]
  const feePayerPrev = explainedChanges.get(feePayer) ?? 0n
  explainedChanges.set(feePayer, feePayerPrev - fee)

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i]
    const actualChange = (postBalances[i] ?? 0n) - (preBalances[i] ?? 0n)
    const explainedChange = explainedChanges.get(account) ?? 0n
    const unexplained = actualChange - explainedChange
    if (unexplained !== 0n) {
      // Unexplained changes may come from closures, rewards, or rent.
    }
  }

  return transfers
}
