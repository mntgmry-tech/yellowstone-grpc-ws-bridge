export type CommitmentLabel = 'processed' | 'confirmed'

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
    }
  | { op: 'getState' }
  | { op: 'ping' }

export type ClientOptions = {
  includeAccounts: boolean
  includeTokenBalanceChanges: boolean
  includeLogs: boolean
}

export type TokenBalanceChange = {
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

export type WsStatusEvent = {
  type: 'status'
  clientId?: string
  now: string
  grpcConnected: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
  watchedAccounts: number
  watchedMints: number
}

export type WsTransactionEvent = {
  type: 'transaction'
  commitment: CommitmentLabel
  slot: number
  signature: string
  isVote: boolean
  index: number
  err: unknown
  accounts?: string[]
  tokenBalanceChanges?: TokenBalanceChange[]
  logs?: string[]
  computeUnitsConsumed?: number
}

export type WsEvent = WsStatusEvent | WsTransactionEvent
