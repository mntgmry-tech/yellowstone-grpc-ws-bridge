import { CommitmentLabel } from '../types'

export type StatsContext = {
  clients: number
  watchedAccounts: number
  watchedMints: number
  processedConnected: boolean
  confirmedConnected: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
  blockMetaSlot?: number
  blockMetaTime?: number | null
  blockMetaUpdatedAt?: number
}

export type StatsSnapshot = {
  now: string
  uptimeSec: number
  periodSec: number
  clients: number
  watchedAccounts: number
  watchedMints: number
  grpc: {
    processedConnected: boolean
    confirmedConnected: boolean
  }
  headSlots: {
    processed?: number
    confirmed?: number
  }
  blockMeta: {
    slot?: number
    blockTime?: number | null
    updatedAt?: string
    ageSec?: number
  }
  totals: {
    tx: { processed: number; confirmed: number }
    slots: { processed: number; confirmed: number }
    pongs: { processed: number; confirmed: number }
    wsEvents: { status: number; transaction: number; total: number }
    wsMessages: { status: number; transaction: number; total: number }
    authFailures: number
  }
  deltas: {
    tx: { processed: number; confirmed: number }
    slots: { processed: number; confirmed: number }
    pongs: { processed: number; confirmed: number }
    wsEvents: { total: number }
    wsMessages: { total: number }
    authFailures: number
  }
  last: {
    txAgeSec?: number
    pingAgeSec?: number
    pongAgeSec?: number
    pingId?: number
    pongId?: number
    rttMs?: number
  }
}

export class StatsTracker {
  private statsStartedAt = Date.now()
  private lastLogAt = this.statsStartedAt
  private lastTxAt: number | undefined
  private lastPingAt: number | undefined
  private lastPingId: number | undefined
  private lastPongAt: number | undefined
  private lastPongId: number | undefined
  private lastPongRttMs: number | undefined

  private processedSlotCount = 0
  private confirmedSlotCount = 0
  private processedTxCount = 0
  private confirmedTxCount = 0
  private processedPongCount = 0
  private confirmedPongCount = 0

  private wsStatusEvents = 0
  private wsTransactionEvents = 0
  private wsStatusMessages = 0
  private wsTransactionMessages = 0
  private authFailureCount = 0

  private lastProcessedSlotCount = 0
  private lastConfirmedSlotCount = 0
  private lastProcessedTxCount = 0
  private lastConfirmedTxCount = 0
  private lastProcessedPongCount = 0
  private lastConfirmedPongCount = 0
  private lastWsStatusEvents = 0
  private lastWsTransactionEvents = 0
  private lastWsStatusMessages = 0
  private lastWsTransactionMessages = 0
  private lastAuthFailureCount = 0

  private pingSentAt = new Map<number, number>()
  private logFn: (line: string) => void

  constructor(logFn: (line: string) => void = console.log) {
    this.logFn = logFn
  }

  recordWsEvent(type: 'status' | 'transaction', recipients: number) {
    if (recipients <= 0) return
    if (type === 'status') {
      this.wsStatusEvents += 1
      this.wsStatusMessages += recipients
    } else {
      this.wsTransactionEvents += 1
      this.wsTransactionMessages += recipients
    }
  }

  recordSlot(commitment: CommitmentLabel) {
    if (commitment === 'processed') this.processedSlotCount += 1
    if (commitment === 'confirmed') this.confirmedSlotCount += 1
  }

  recordAuthFailure() {
    this.authFailureCount += 1
  }

  recordTx(commitment: CommitmentLabel) {
    this.lastTxAt = Date.now()
    if (commitment === 'processed') this.processedTxCount += 1
    if (commitment === 'confirmed') this.confirmedTxCount += 1
  }

  recordPing(id: number) {
    const now = Date.now()
    this.lastPingAt = now
    this.lastPingId = id
    this.pingSentAt.set(id, now)
    while (this.pingSentAt.size > 20) {
      const oldest = this.pingSentAt.keys().next().value
      if (oldest === undefined) break
      this.pingSentAt.delete(oldest)
    }
  }

  recordPong(commitment: CommitmentLabel, id: number) {
    const now = Date.now()
    this.lastPongAt = now
    this.lastPongId = id
    const sentAt = this.pingSentAt.get(id)
    if (sentAt !== undefined) {
      this.lastPongRttMs = now - sentAt
      this.pingSentAt.delete(id)
    } else {
      this.lastPongRttMs = undefined
    }
    if (commitment === 'processed') this.processedPongCount += 1
    if (commitment === 'confirmed') this.confirmedPongCount += 1
  }

  start(intervalMs: number, contextProvider: () => StatsContext) {
    setInterval(() => {
      this.logSnapshot(contextProvider())
    }, intervalMs)
  }

  getSnapshot(context: StatsContext, now = Date.now()): StatsSnapshot {
    const uptimeSec = Math.floor((now - this.statsStartedAt) / 1000)
    const periodSec = Math.max(1, Math.round((now - this.lastLogAt) / 1000))

    const procTxDelta = this.processedTxCount - this.lastProcessedTxCount
    const confTxDelta = this.confirmedTxCount - this.lastConfirmedTxCount
    const procSlotDelta = this.processedSlotCount - this.lastProcessedSlotCount
    const confSlotDelta = this.confirmedSlotCount - this.lastConfirmedSlotCount
    const procPongDelta = this.processedPongCount - this.lastProcessedPongCount
    const confPongDelta = this.confirmedPongCount - this.lastConfirmedPongCount

    const wsEventsTotal = this.wsStatusEvents + this.wsTransactionEvents
    const wsMessagesTotal = this.wsStatusMessages + this.wsTransactionMessages
    const lastWsEventsTotal = this.lastWsStatusEvents + this.lastWsTransactionEvents
    const lastWsMessagesTotal = this.lastWsStatusMessages + this.lastWsTransactionMessages

    const wsEventsDelta = wsEventsTotal - lastWsEventsTotal
    const wsMessagesDelta = wsMessagesTotal - lastWsMessagesTotal
    const authFailureDelta = this.authFailureCount - this.lastAuthFailureCount
    const rtt = this.lastPongRttMs !== undefined ? this.lastPongRttMs : undefined
    const blockMetaAgeSec = context.blockMetaUpdatedAt
      ? Math.floor((now - context.blockMetaUpdatedAt) / 1000)
      : undefined

    return {
      now: new Date(now).toISOString(),
      uptimeSec,
      periodSec,
      clients: context.clients,
      watchedAccounts: context.watchedAccounts,
      watchedMints: context.watchedMints,
      grpc: {
        processedConnected: context.processedConnected,
        confirmedConnected: context.confirmedConnected
      },
      headSlots: {
        processed: context.processedHeadSlot,
        confirmed: context.confirmedHeadSlot
      },
      blockMeta: {
        slot: context.blockMetaSlot,
        blockTime: context.blockMetaTime ?? undefined,
        updatedAt: context.blockMetaUpdatedAt ? new Date(context.blockMetaUpdatedAt).toISOString() : undefined,
        ageSec: blockMetaAgeSec
      },
      totals: {
        tx: { processed: this.processedTxCount, confirmed: this.confirmedTxCount },
        slots: { processed: this.processedSlotCount, confirmed: this.confirmedSlotCount },
        pongs: { processed: this.processedPongCount, confirmed: this.confirmedPongCount },
        wsEvents: {
          status: this.wsStatusEvents,
          transaction: this.wsTransactionEvents,
          total: wsEventsTotal
        },
        wsMessages: {
          status: this.wsStatusMessages,
          transaction: this.wsTransactionMessages,
          total: wsMessagesTotal
        },
        authFailures: this.authFailureCount
      },
      deltas: {
        tx: { processed: procTxDelta, confirmed: confTxDelta },
        slots: { processed: procSlotDelta, confirmed: confSlotDelta },
        pongs: { processed: procPongDelta, confirmed: confPongDelta },
        wsEvents: { total: wsEventsDelta },
        wsMessages: { total: wsMessagesDelta },
        authFailures: authFailureDelta
      },
      last: {
        txAgeSec: this.ageSec(now, this.lastTxAt),
        pingAgeSec: this.ageSec(now, this.lastPingAt),
        pongAgeSec: this.ageSec(now, this.lastPongAt),
        pingId: this.lastPingId,
        pongId: this.lastPongId,
        rttMs: rtt
      }
    }
  }

  private logSnapshot(context: StatsContext) {
    const now = Date.now()
    const snapshot = this.getSnapshot(context, now)
    const rtt = snapshot.last.rttMs !== undefined ? `${snapshot.last.rttMs}ms` : 'n/a'
    const blockMetaSlot = snapshot.blockMeta.slot ?? '-'
    const blockMetaTime = snapshot.blockMeta.blockTime ?? '-'

    this.logFn(
      [
        `[stats] up=${snapshot.uptimeSec}s`,
        `clients=${snapshot.clients}`,
        `watched=${snapshot.watchedAccounts}/${snapshot.watchedMints}`,
        `grpc=proc:${snapshot.grpc.processedConnected ? 'on' : 'off'} conf:${
          snapshot.grpc.confirmedConnected ? 'on' : 'off'
        }`,
        `head=${snapshot.headSlots.processed ?? '-'} / ${snapshot.headSlots.confirmed ?? '-'}`,
        `block_meta=${blockMetaSlot}@${blockMetaTime}`,
        `tx_total=proc:${snapshot.totals.tx.processed} conf:${snapshot.totals.tx.confirmed}`,
        `tx_${snapshot.periodSec}s=proc:${snapshot.deltas.tx.processed} conf:${snapshot.deltas.tx.confirmed}`,
        `slots_${snapshot.periodSec}s=proc:${snapshot.deltas.slots.processed} conf:${snapshot.deltas.slots.confirmed}`,
        `pongs_${snapshot.periodSec}s=proc:${snapshot.deltas.pongs.processed} conf:${snapshot.deltas.pongs.confirmed}`,
        `ws_events_${snapshot.periodSec}s=${snapshot.deltas.wsEvents.total}`,
        `ws_msgs_${snapshot.periodSec}s=${snapshot.deltas.wsMessages.total}`,
        `auth_failures_total=${snapshot.totals.authFailures}`,
        `auth_failures_${snapshot.periodSec}s=${snapshot.deltas.authFailures}`,
        `last_tx=${this.formatAge(now, this.lastTxAt)}`,
        `ping=${this.formatAge(now, this.lastPingAt)}(${this.lastPingId ?? '-'})`,
        `pong=${this.formatAge(now, this.lastPongAt)}(${this.lastPongId ?? '-'})`,
        `rtt=${rtt}`
      ].join(' ')
    )

    this.lastLogAt = now
    this.lastProcessedTxCount = this.processedTxCount
    this.lastConfirmedTxCount = this.confirmedTxCount
    this.lastProcessedSlotCount = this.processedSlotCount
    this.lastConfirmedSlotCount = this.confirmedSlotCount
    this.lastProcessedPongCount = this.processedPongCount
    this.lastConfirmedPongCount = this.confirmedPongCount
    this.lastWsStatusEvents = this.wsStatusEvents
    this.lastWsTransactionEvents = this.wsTransactionEvents
    this.lastWsStatusMessages = this.wsStatusMessages
    this.lastWsTransactionMessages = this.wsTransactionMessages
    this.lastAuthFailureCount = this.authFailureCount
  }

  private ageSec(now: number, t?: number) {
    if (!t) return undefined
    return Math.max(0, Math.floor((now - t) / 1000))
  }

  private formatAge(now: number, t?: number) {
    if (!t) return 'never'
    const sec = Math.max(0, Math.floor((now - t) / 1000))
    return `${sec}s`
  }
}
