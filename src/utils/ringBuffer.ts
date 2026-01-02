export class RingBuffer<T> {
  private buffer: Array<T | undefined>
  private head = 0
  private size = 0

  constructor(private capacity: number) {
    this.buffer = new Array<T | undefined>(Math.max(0, capacity))
  }

  get length() {
    return this.size
  }

  push(item: T) {
    if (this.capacity <= 0) return
    if (this.size < this.capacity) {
      const idx = (this.head + this.size) % this.capacity
      this.buffer[idx] = item
      this.size += 1
      return
    }

    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
  }

  forEach(fn: (item: T) => void) {
    for (let i = 0; i < this.size; i += 1) {
      const idx = (this.head + i) % this.capacity
      const item = this.buffer[idx]
      if (item !== undefined) fn(item)
    }
  }

  trimBefore(cutoff: number, getTs: (item: T) => number) {
    while (this.size > 0) {
      const item = this.buffer[this.head]
      if (!item) break
      if (getTs(item) >= cutoff) break
      this.buffer[this.head] = undefined
      this.head = (this.head + 1) % this.capacity
      this.size -= 1
    }
  }

  clear() {
    if (this.capacity <= 0) return
    this.buffer.fill(undefined)
    this.head = 0
    this.size = 0
  }
}
