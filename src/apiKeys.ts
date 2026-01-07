import { randomBytes, randomUUID } from 'crypto'
import { Collection, Db, MongoClient, MongoServerError, ObjectId, WithId } from 'mongodb'

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

const toAuth = (doc: WithId<ApiKeyDocument>): ApiKeyAuth => ({
  id: doc._id.toHexString(),
  userId: doc.userId,
  userName: doc.userName,
  active: doc.active
})

const isDuplicateKeyError = (error: unknown) =>
  error instanceof MongoServerError && error.code === 11000

const toObjectId = (id: string): ObjectId | null => (ObjectId.isValid(id) ? new ObjectId(id) : null)

export class MongoApiKeyStore implements ApiKeyStore {
  private client: MongoClient
  private db?: Db
  private collection?: Collection<ApiKeyDocument>
  private connected = false

  constructor(
    private uri: string,
    private dbName: string,
    private collectionName: string = DEFAULT_COLLECTION
  ) {
    this.client = new MongoClient(uri)
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
  }

  async close(): Promise<void> {
    await this.client.close()
    this.connected = false
    this.collection = undefined
    this.db = undefined
  }

  async list(): Promise<ApiKeyRecord[]> {
    const collection = this.requireCollection()
    const docs = await collection.find({}).sort({ createdAt: -1 }).toArray()
    return docs.map(toRecord)
  }

  async get(id: string): Promise<ApiKeyRecord | null> {
    const collection = this.requireCollection()
    const objectId = toObjectId(id)
    if (!objectId) return null
    const doc = await collection.findOne({ _id: objectId })
    return doc ? toRecord(doc) : null
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
        return toRecord({ ...doc, _id: result.insertedId })
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
    return result ? toRecord(result) : null
  }

  async delete(id: string): Promise<boolean> {
    const collection = this.requireCollection()
    const objectId = toObjectId(id)
    if (!objectId) return false
    const result = await collection.deleteOne({ _id: objectId })
    return result.deletedCount > 0
  }

  async validate(apiKey: string): Promise<ApiKeyAuth | null> {
    const collection = this.requireCollection()
    const doc = await collection.findOne({ apiKey })
    if (!doc || !doc.active) return null
    try {
      await collection.updateOne({ _id: doc._id }, { $set: { lastUsed: new Date() } })
    } catch (error) {
      console.warn('[api-keys] failed to update lastUsed', error)
    }
    return toAuth(doc)
  }

  private requireCollection(): Collection<ApiKeyDocument> {
    if (!this.collection) {
      throw new Error('api key store not initialized')
    }
    return this.collection
  }
}
