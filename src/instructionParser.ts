import bs58 from 'bs58'
import { Instruction, InnerInstruction } from './types'
import { ParsedInstruction } from './nativeTransfers'

export type RawInstruction = {
  programIdIndex: number
  accounts: number[] | Uint8Array
  data: Uint8Array | string
}

export type RawInnerInstructions = {
  index: number
  instructions: RawInstruction[]
}

function encodeData(data: Uint8Array | string): string {
  if (typeof data === 'string') return data
  return bs58.encode(data)
}

function decodeAccounts(accounts: number[] | Uint8Array, accountKeys: string[]): string[] {
  return Array.from(accounts).map((idx) => accountKeys[idx] ?? '')
}

export function parseInstructions(
  rawInstructions: RawInstruction[],
  rawInnerInstructions: RawInnerInstructions[] | null,
  accountKeys: string[]
): Instruction[] {
  const innerInstructionsMap = new Map<number, RawInstruction[]>()

  if (rawInnerInstructions) {
    for (const inner of rawInnerInstructions) {
      innerInstructionsMap.set(inner.index, inner.instructions)
    }
  }

  const instructions: Instruction[] = []

  for (let i = 0; i < rawInstructions.length; i += 1) {
    const rawIx = rawInstructions[i]
    const innerRaw = innerInstructionsMap.get(i) ?? []

    const innerInstructions: InnerInstruction[] = innerRaw.map((innerIx) => ({
      programId: accountKeys[innerIx.programIdIndex] ?? '',
      accounts: decodeAccounts(innerIx.accounts, accountKeys),
      data: encodeData(innerIx.data)
    }))

    instructions.push({
      programId: accountKeys[rawIx.programIdIndex] ?? '',
      accounts: decodeAccounts(rawIx.accounts, accountKeys),
      data: encodeData(rawIx.data),
      innerInstructions
    })
  }

  return instructions
}

export function instructionsToParsedInstructions(instructions: Instruction[]): ParsedInstruction[] {
  return instructions.map((ix) => ({
    programId: ix.programId,
    accounts: ix.accounts,
    data: Buffer.from(bs58.decode(ix.data)),
    innerInstructions: ix.innerInstructions.map((inner) => ({
      programId: inner.programId,
      accounts: inner.accounts,
      data: Buffer.from(bs58.decode(inner.data))
    }))
  }))
}
