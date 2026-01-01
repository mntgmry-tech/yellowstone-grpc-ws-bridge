import { CommitmentLabel } from '../types'

export type StatsContext = {
  clients: number
  watchedAccounts: number
  watchedMints: number
  processedConnected: boolean
  confirmedConnected: boolean
  processedHeadSlot?: number
  confirmedHeadSlot?: number
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

  private logSnapshot(context: StatsContext) {
    const now = Date.now()
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
    const rtt = this.lastPongRttMs !== undefined ? `${this.lastPongRttMs}ms` : 'n/a'

    this.logFn(
      [
        `[stats] up=${uptimeSec}s`,
        `clients=${context.clients}`,
        `watched=${context.watchedAccounts}/${context.watchedMints}`,
        `grpc=proc:${context.processedConnected ? 'on' : 'off'} conf:${context.confirmedConnected ? 'on' : 'off'}`,
        `head=${context.processedHeadSlot ?? '-'} / ${context.confirmedHeadSlot ?? '-'}`,
        `tx_total=proc:${this.processedTxCount} conf:${this.confirmedTxCount}`,
        `tx_${periodSec}s=proc:${procTxDelta} conf:${confTxDelta}`,
        `slots_${periodSec}s=proc:${procSlotDelta} conf:${confSlotDelta}`,
        `pongs_${periodSec}s=proc:${procPongDelta} conf:${confPongDelta}`,
        `ws_events_${periodSec}s=${wsEventsDelta}`,
        `ws_msgs_${periodSec}s=${wsMessagesDelta}`,
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
  }

  private formatAge(now: number, t?: number) {
    if (!t) return 'never'
    const sec = Math.max(0, Math.floor((now - t) / 1000))
    return `${sec}s`
  }
}
