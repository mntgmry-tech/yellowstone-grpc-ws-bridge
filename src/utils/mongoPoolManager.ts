import {
  Collection,
  Db,
  Document,
  IndexDescription,
  MongoClient,
  MongoClientOptions
} from 'mongodb'

export type IndexDefinition = { name: string } & Omit<IndexDescription, 'name'>

export type MongoConnectionParams = {
  uri: string
  dbName: string
  connectTimeoutMs?: number
  socketTimeoutMs?: number
  maxPoolSize?: number
  minPoolSize?: number
}

export class MongoPoolManager {
  private static instance: MongoPoolManager | null = null
  private client: MongoClient | null = null
  private db: Db | null = null
  private isConnected = false
  private connectPromise: Promise<void> | null = null

  private constructor(private params: MongoConnectionParams) {}

  static initialize(params: MongoConnectionParams): void {
    if (!MongoPoolManager.instance) {
      MongoPoolManager.instance = new MongoPoolManager(params)
      console.log('[mongo] pool manager initialized')
    }
  }

  static getInstance(): MongoPoolManager {
    if (!MongoPoolManager.instance) {
      throw new Error('MongoPoolManager not initialized. Call initialize() first.')
    }
    return MongoPoolManager.instance
  }

  async createCollection<T extends Document>(
    collectionName: string,
    indexes: IndexDefinition[] = []
  ): Promise<Collection<T>> {
    await this.ensureConnected()
    if (!this.db) {
      throw new Error('Mongo database not initialized')
    }

    const collection = this.db.collection<T>(collectionName)
    if (indexes.length) {
      await collection.createIndexes(indexes.map(({ name, ...rest }) => ({ name, ...rest })))
    }
    return collection
  }

  getDb(): Db {
    if (!this.db) {
      throw new Error('Mongo database not connected. Ensure createCollection() has been called.')
    }
    return this.db
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close()
      this.client = null
      this.db = null
      this.isConnected = false
      console.log('[mongo] connection pool closed')
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected && this.client && this.db) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.connect()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async connect(): Promise<void> {
    const options: MongoClientOptions = {}
    if (this.params.connectTimeoutMs !== undefined) {
      options.connectTimeoutMS = this.params.connectTimeoutMs
    }
    if (this.params.socketTimeoutMs !== undefined) {
      options.socketTimeoutMS = this.params.socketTimeoutMs
    }
    if (this.params.maxPoolSize !== undefined) {
      options.maxPoolSize = this.params.maxPoolSize
    }
    if (this.params.minPoolSize !== undefined) {
      options.minPoolSize = this.params.minPoolSize
    }

    console.log('[mongo] connecting...')
    this.client = new MongoClient(this.params.uri, options)
    await this.client.connect()
    this.db = this.client.db(this.params.dbName)
    this.isConnected = true
    console.log('[mongo] connected')
  }
}
