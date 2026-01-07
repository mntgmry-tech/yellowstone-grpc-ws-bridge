import { randomBytes, randomUUID } from 'crypto'
import { Collection, Db, MongoClient, MongoServerError, ObjectId, WithId } from 'mongodb'
import { SuperLRU } from 'superlru'

export type ApiKeyRecord = {
  id: string
  userId: string
  userName: string
  apiKey: string
  createdAt: string
  lastUsed?: string
  active: boolean
}

export type ApiKeyAuth = {
  id: string
  userId: string
  userName: string
  active: boolean
}

export type ApiKeyCreateInput = {
  userName: string
  active?: boolean
}

export type ApiKeyUpdateInput = {
  userName?: string
  active?: boolean
}

export type ApiKeyStoreOptions = {
  cacheMaxSize?: number
  lastUsedFlushMs?: number
}

export interface ApiKeyStore {
  ready(): boolean
  connect(): Promise<void>
  close(): Promise<void>
  list(): Promise<ApiKeyRecord[]>
  get(id: string): Promise<ApiKeyRecord | null>
  create(input: ApiKeyCreateInput): Promise<ApiKeyRecord>
  update(id: string, update: ApiKeyUpdateInput): Promise<ApiKeyRecord | null>
  delete(id: string): Promise<boolean>
  validate(apiKey: string): Promise<ApiKeyAuth | null>
}

type ApiKeyDocument = {
  userId: string
  userName: string
  apiKey: string
  createdAt: Date
  lastUsed?: Date
  active: boolean
}

const DEFAULT_COLLECTION = 'api_keys'
const API_KEY_BYTES = 32
const API_KEY_RETRIES = 5
const DEFAULT_CACHE_MAX_SIZE = 100000
const DEFAULT_LAST_USED_FLUSH_MS = 15_000

type CachedApiKey = {
  id: string
  apiKey: string
  userId: string
  userName: string
  active: boolean
  lastUsedAt?: number
}

const generateApiKey = () => randomBytes(API_KEY_BYTES).toString('hex')

const toRecord = (doc: WithId<ApiKeyDocument>): ApiKeyRecord => ({
  id: doc._id.toHexString(),
  userId: doc.userId,
  userName: doc.userName,
  apiKey: doc.apiKey,
  createdAt: doc.createdAt.toISOString(),
  lastUsed: doc.lastUsed ? doc.lastUsed.toISOString() : undefined,
  active: doc.active
})

const toAuthFromCache = (entry: CachedApiKey): ApiKeyAuth => ({
  id: entry.id,
  userId: entry.userId,
  userName: entry.userName,
  active: entry.active
})

const isDuplicateKeyError = (error: unknown) =>
  error instanceof MongoServerError && error.code === 11000

const toObjectId = (id: string): ObjectId | null => (ObjectId.isValid(id) ? new ObjectId(id) : null)

export class MongoApiKeyStore implements ApiKeyStore {
  private client: MongoClient
  private db?: Db
  private collection?: Collection<ApiKeyDocument>
  private connected = false
  private cache: SuperLRU<string, CachedApiKey>
  private idToKey = new Map<string, string>()
  private pendingLastUsed = new Map<string, number>()
  private lastUsedTimer?: ReturnType<typeof setInterval>
  private cacheMaxSize: number
  private lastUsedFlushMs: number

  constructor(
    private uri: string,
    private dbName: string,
    private collectionName: string = DEFAULT_COLLECTION,
    options: ApiKeyStoreOptions = {}
  ) {
    this.client = new MongoClient(uri)
    this.cacheMaxSize = options.cacheMaxSize ?? DEFAULT_CACHE_MAX_SIZE
    this.lastUsedFlushMs = options.lastUsedFlushMs ?? DEFAULT_LAST_USED_FLUSH_MS
    this.cache = new SuperLRU<string, CachedApiKey>({
      maxSize: Math.max(1, this.cacheMaxSize),
      compress: false,
      encrypt: false,
      onEvicted: (_key, value) => {
        if (!value) return
        this.idToKey.delete(value.id)
      }
    })
  }

  ready(): boolean {
    return this.connected && Boolean(this.collection)
  }

  async connect(): Promise<void> {
    await this.client.connect()
    this.db = this.client.db(this.dbName)
    this.collection = this.db.collection<ApiKeyDocument>(this.collectionName)
    await this.collection.createIndex({ apiKey: 1 }, { unique: true })
    await this.collection.createIndex({ userId: 1 })
    this.connected = true
    await this.primeCache()

    if (this.lastUsedFlushMs > 0) {
      this.lastUsedTimer = setInterval(() => {
        void this.flushLastUsed()
      }, this.lastUsedFlushMs)
    }
  }

  async close(): Promise<void> {
    if (this.lastUsedTimer) {
      clearInterval(this.lastUsedTimer)
      this.lastUsedTimer = undefined
    }
    try {
      await this.flushLastUsed()
    } catch (error) {
      console.warn('[api-keys] failed to flush lastUsed on close', error)
    }
    await this.client.close()
    this.connected = false
    this.collection = undefined
    this.db = undefined
  }

  async list(): Promise<ApiKeyRecord[]> {
    const collection = this.requireCollection()
    const docs = await collection.find({}).sort({ createdAt: -1 }).toArray()
    await Promise.all(docs.map((doc) => this.upsertCacheFromDoc(doc)))
    return docs.map(toRecord)
  }

  async get(id: string): Promise<ApiKeyRecord | null> {
    const collection = this.requireCollection()
    const objectId = toObjectId(id)
    if (!objectId) return null
    const doc = await collection.findOne({ _id: objectId })
    if (!doc) return null
    await this.upsertCacheFromDoc(doc)
    return toRecord(doc)
  }

  async create(input: ApiKeyCreateInput): Promise<ApiKeyRecord> {
    const collection = this.requireCollection()
    const createdAt = new Date()
    const active = input.active ?? true
    const userId = randomUUID()
    let apiKey = generateApiKey()

    for (let attempt = 0; attempt < API_KEY_RETRIES; attempt += 1) {
      try {
        const doc: ApiKeyDocument = {
          userId,
          userName: input.userName,
          apiKey,
          createdAt,
          active
        }
        const result = await collection.insertOne(doc)
        const record = { ...doc, _id: result.insertedId }
        await this.upsertCacheFromDoc(record)
        return toRecord(record)
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          apiKey = generateApiKey()
          continue
        }
        throw error
      }
    }

    throw new Error('failed to create api key after multiple attempts')
  }

  async update(id: string, update: ApiKeyUpdateInput): Promise<ApiKeyRecord | null> {
    const collection = this.requireCollection()
    const objectId = toObjectId(id)
    if (!objectId) return null

    const patch: Partial<ApiKeyDocument> = {}
    if (update.userName !== undefined) patch.userName = update.userName
    if (update.active !== undefined) patch.active = update.active

    if (Object.keys(patch).length === 0) {
      return this.get(id)
    }

    const result = await collection.findOneAndUpdate(
      { _id: objectId },
      { $set: patch },
      { returnDocument: 'after' }
    )
    if (!result) return null
    await this.upsertCacheFromDoc(result)
    return toRecord(result)
  }

  async delete(id: string): Promise<boolean> {
    const collection = this.requireCollection()
    const objectId = toObjectId(id)
    if (!objectId) return false
    const result = await collection.deleteOne({ _id: objectId })
    if (result.deletedCount > 0) {
      await this.evictCacheById(id)
      this.pendingLastUsed.delete(id)
    }
    return result.deletedCount > 0
  }

  async validate(apiKey: string): Promise<ApiKeyAuth | null> {
    const collection = this.requireCollection()
    const now = Date.now()
    const cached = await this.cache.get(apiKey)
    if (cached) {
      if (!cached.active) return null
      this.markLastUsed(cached, now)
      return toAuthFromCache(cached)
    }

    const doc = await collection.findOne({ apiKey })
    if (!doc) return null
    const entry = await this.upsertCacheFromDoc(doc)
    if (!entry.active) return null
    this.markLastUsed(entry, now)
    return toAuthFromCache(entry)
  }

  private requireCollection(): Collection<ApiKeyDocument> {
    if (!this.collection) {
      throw new Error('api key store not initialized')
    }
    return this.collection
  }

  private async primeCache() {
    const collection = this.collection
    if (!collection) return
    try {
      const docs = await collection.find({}).toArray()
      await Promise.all(docs.map((doc) => this.upsertCacheFromDoc(doc)))
      console.log(`[api-keys] cache primed size=${docs.length} maxSize=${this.cacheMaxSize}`)
    } catch (error) {
      console.warn('[api-keys] failed to prime cache', error)
    }
  }

  private async upsertCacheFromDoc(doc: WithId<ApiKeyDocument>): Promise<CachedApiKey> {
    const id = doc._id.toHexString()
    const existingKey = this.idToKey.get(id)
    let entry: CachedApiKey | null = null
    if (existingKey) {
      entry = await this.cache.get(existingKey)
      if (existingKey !== doc.apiKey) {
        await this.cache.unset(existingKey)
      }
    }

    if (!entry) {
      entry = {
        id,
        apiKey: doc.apiKey,
        userId: doc.userId,
        userName: doc.userName,
        active: doc.active
      }
    }

    entry.id = id
    entry.apiKey = doc.apiKey
    entry.userId = doc.userId
    entry.userName = doc.userName
    entry.active = doc.active

    const docLastUsed = doc.lastUsed ? doc.lastUsed.getTime() : undefined
    if (docLastUsed !== undefined) {
      if (entry.lastUsedAt === undefined || docLastUsed > entry.lastUsedAt) {
        entry.lastUsedAt = docLastUsed
      }
    }

    await this.cache.set(entry.apiKey, entry)
    this.idToKey.set(entry.id, entry.apiKey)
    return entry
  }

  private async evictCacheById(id: string) {
    const key = this.idToKey.get(id)
    if (!key) return
    await this.cache.unset(key)
    this.idToKey.delete(id)
  }

  private markLastUsed(entry: CachedApiKey, now: number) {
    entry.lastUsedAt = now
    const pending = this.pendingLastUsed.get(entry.id)
    if (!pending || now > pending) {
      this.pendingLastUsed.set(entry.id, now)
    }
  }

  private async flushLastUsed() {
    const collection = this.collection
    if (!collection) return
    if (!this.pendingLastUsed.size) return
    const updates: Array<{ id: string; ts: number; objectId: ObjectId }> = []
    for (const [id, ts] of this.pendingLastUsed.entries()) {
      const objectId = toObjectId(id)
      if (!objectId) {
        this.pendingLastUsed.delete(id)
        continue
      }
      updates.push({ id, ts, objectId })
    }
    if (!updates.length) return

    try {
      await collection.bulkWrite(
        updates.map((item) => ({
          updateOne: {
            filter: { _id: item.objectId },
            update: { $set: { lastUsed: new Date(item.ts) } }
          }
        })),
        { ordered: false }
      )
      for (const item of updates) {
        this.pendingLastUsed.delete(item.id)
      }
    } catch (error) {
      console.warn('[api-keys] failed to flush lastUsed', error)
    }
  }
}
