import { MongoClient } from "mongodb";

let client;
let database;
let connectPromise;

export async function connectDatabase(uri, dbName) {
  if (database) return database;
  if (connectPromise) return connectPromise;
  if (!uri || !dbName) throw new Error("MongoDB URI and database name are required.");

  connectPromise = (async () => {
    const nextClient = new MongoClient(uri, {
      appName: "RapStoreAssistant",
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      retryReads: true,
      retryWrites: true,
    });
    try {
      await nextClient.connect();
      const nextDb = nextClient.db(dbName);
      await nextDb.command({ ping: 1 });
      await ensureIndexes(nextDb);
      client = nextClient;
      database = nextDb;
      return database;
    } catch (error) {
      await nextClient.close().catch(() => {});
      throw error;
    } finally {
      connectPromise = undefined;
    }
  })();
  return connectPromise;
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection("products").createIndex({ active: 1, name: 1 }),
    db.collection("products").createIndex({ sku: 1 }, { unique: true, sparse: true }),
    db.collection("stock_items").createIndex({ productId: 1, status: 1 }),
    db.collection("stock_items").createIndex({ productId: 1, code: 1 }, { unique: true }),
    db.collection("orders").createIndex({ buyerId: 1, createdAt: -1 }),
    db.collection("orders").createIndex({ orderCode: 1 }, { unique: true }),
    db.collection("orders").createIndex({ status: 1, createdAt: -1 }),
    db.collection("tickets").createIndex({ channelId: 1 }, { unique: true, sparse: true }),
    db.collection("tickets").createIndex({ guildId: 1, buyerId: 1, status: 1 }),
    db.collection("orders").createIndex({ guildId: 1, channelId: 1 }),
    db.collection("payment_proofs").createIndex({ orderId: 1, createdAt: -1 }),
    db.collection("payment_proofs").createIndex({ status: 1, createdAt: -1 }),
    db.collection("vouches").createIndex({ orderId: 1 }, { unique: true }),
    db.collection("audit_logs").createIndex({ createdAt: -1 }),
  ]);
}

export function getDatabase() {
  if (!database) throw new Error("Database is not connected.");
  return database;
}

export async function closeDatabase() {
  const activeClient = client;
  client = undefined;
  database = undefined;
  connectPromise = undefined;
  if (activeClient) await activeClient.close();
}
