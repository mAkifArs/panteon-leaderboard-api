import { MongoClient, type Db } from 'mongodb'
import { loadEnv } from '../config/env.ts'

let client: MongoClient | undefined
let db: Db | undefined

/**
 * Lazy-init MongoDB client. Safe to call multiple times —
 * returns the same instance.
 */
export function getMongo(): { client: MongoClient; db: Db } {
  if (client && db) return { client, db }
  const env = loadEnv()
  client = new MongoClient(env.MONGO_URL, {
    serverSelectionTimeoutMS: 5000,
  })
  db = client.db(env.MONGO_DB)
  return { client, db }
}

export async function pingMongo(): Promise<boolean> {
  const { client } = getMongo()
  try {
    await client.db('admin').command({ ping: 1 })
    return true
  } catch {
    return false
  }
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close()
    client = undefined
    db = undefined
  }
}
