export type CommitmentLabel = 'processed' | 'confirmed'
export type EventFormat = 'raw' | 'enhanced'

export type ClientMsg =
  | { op: 'resume'; clientId: string }
  | { op: 'setAccounts'; accounts: string[] }
  | { op: 'addAccounts'; accounts: string[] }
  | { op: 'removeAccounts'; accounts: string[] }
  | { op: 'setMints'; mints: string[] }
  | { op: 'addMints'; mints: string[] }
  | { op: 'removeMints'; mints: string[] }
  | {
      op: 'setOptions'
      includeAccounts?: boolean
      includeTokenBalanceChanges?: boolean
      includeLogs?: boolean
      includeInstructions?: boolean
      eventFormat?: EventFormat
      filterTokenBalances?: boolean
    }
  | { op: 'getState' }
  | { op: 'ping' }

export type ClientOptions = {
  includeAccounts: boolean
  includeTokenBalanceChanges: boolean
  includeLogs: boolean
  includeInstructions: boolean
  eventFormat: EventFormat
  filterTokenBalances: boolean
}

export type NativeTransfer = {
  fromUserAccount: string
  toUserAccount: string
  amount: number
}

export type TokenTransfer = {
  fromTokenAccount: string
  toTokenAccount: string
  fromUserAccount: string
  toUserAccount: string
  tokenAmount: number
  mint: string
  tokenStandard: string
}

export type RawTokenAmount = {
  tokenAmount: string
  decimals: number
}

export type TokenBalanceChange = {
  userAccount: string
  tokenAccount: string
  rawTokenAmount: RawTokenAmount
  mint: string
}

export type AccountData = {
  account: string
  nativeBalanceChange: number
  tokenBalanceChanges: TokenBalanceChange[]
}

export type InnerInstruction = {
  programId: string
  accounts: string[]
  data: string
}

export type Instruction = {
  programId: string
  accounts: string[]
  data: string
  innerInstructions: InnerInstruction[]
}

export type YellowstoneTokenBalanceChange = {
  account: string
  mint: string
  owner?: string
  decimals: number
  preAmount: string
  preAmountUi: string
  postAmount: string
  postAmountUi: string
  delta: string
  deltaUi: string
}

export type EnhancedTransactionEvent = {
  type: 'transaction'
  commitment: CommitmentLabel
  slot: number
  signature: string
  timestamp: number | null
  isVote: boolean
  index: number
  err: object | null
  fee: number
  feePayer: string
  accounts?: string[]
  nativeTransfers: NativeTransfer[]
  tokenTransfers: TokenTransfer[]
  accountData: AccountData[]
  instructions?: Instruction[]
  computeUnitsConsumed: number
  logs?: string[]
}

export type RawTransactionEvent = {
  type: 'transaction'
  commitment: CommitmentLabel
  slot: number
  signature: string
  isVote: boolean
  index: number
  err: object | null
  accounts?: string[]
  tokenBalanceChanges?: YellowstoneTokenBalanceChange[]
  logs?: string[]
  computeUnitsConsumed: number
}

export type WsStatusEvent = {
  type: 'status'
  clientId?: string
  now: string
  grpcConnected: boolean
  nodeHealthy: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
  watchedAccounts: number
  watchedMints: number
}

export type WsTransactionEvent = EnhancedTransactionEvent | RawTransactionEvent

export type WsEvent = WsStatusEvent | WsTransactionEvent
