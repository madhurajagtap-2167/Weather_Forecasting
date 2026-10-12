/**
 * MongoDB access layer (official `mongodb` driver).
 *
 * Every function degrades gracefully: if MongoDB is not running, getDb()
 * resolves to null and callers fall back to the CSV / JSON files, so the API
 * keeps working either way. A failed connection is retried every 30 s, so you
 * can start MongoDB after the server and it will be picked up.
 *
 * Collections
 *   forecast_log    unique (site, time)                  15-min live forecast log
 *   historical      unique (site_id, resolution, timestamp)
 *   model_backtest  unique (site, start, end)            cached NWP model reports
 */
import { MongoClient } from 'mongodb';
import { MONGO_URI, MONGO_DB } from './config.js';
import { addDaysIso } from './utils.js';

let client = null;
let db = null;
let lastFailAt = 0;
let connecting = null;
const RETRY_MS = 30_000;

export async function getDb() {
  if (db) return db;
  if (Date.now() - lastFailAt < RETRY_MS) return null;
  if (!connecting) {
    connecting = (async () => {
      try {
        const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
        await c.connect();
        await c.db('admin').command({ ping: 1 });
        client = c;
        db = c.db(MONGO_DB);
        await ensureIndexes(db);
        console.log(`[db] Connected to MongoDB: ${MONGO_URI} / ${MONGO_DB}`);
      } catch (e) {
        db = null;
        lastFailAt = Date.now();
        console.warn(`[db] MongoDB unavailable (${e.message}). Falling back to CSV/JSON files.`);
      } finally {
        connecting = null;
      }
      return db;
    })();
  }
  return connecting;
}

export async function ensureIndexes(d) {
  await d.collection('forecast_log').createIndex({ site: 1, time: 1 }, { unique: true });
  await d.collection('historical').createIndex(
    { site_id: 1, resolution: 1, timestamp: 1 }, { unique: true });
  await d.collection('model_backtest').createIndex(
    { site: 1, start: 1, end: 1 }, { unique: true });
}

export async function closeDb() {
  if (client) await client.close();
  client = null;
  db = null;
}
/** Test hook: inject a fake database object. */
export function _setDbForTests(fake) {
  db = fake;
  lastFailAt = 0;
}

export async function mongoStatus() {
  const d = await getDb();
  if (!d) return { connected: false };
  return {
    connected: true,
    database: d.databaseName ?? MONGO_DB,
    counts: {
      forecast_log: await d.collection('forecast_log').estimatedDocumentCount(),
      historical: await d.collection('historical').estimatedDocumentCount(),
      model_backtest: await d.collection('model_backtest').estimatedDocumentCount(),
    },
  };
}

// ---------------- forecast_log ----------------
export async function saveForecastRows(site, rows) {
  const d = await getDb();
  if (!d || !rows?.length) return 0;
  const ops = rows.map((r) => ({
    updateOne: { filter: { site, time: r.time }, update: { $set: { ...r, site } }, upsert: true },
  }));
  await d.collection('forecast_log').bulkWrite(ops, { ordered: false });
  return ops.length;
}

/** dayIso = 'YYYY-MM-DD'. Returns null if Mongo is down or has no data for that day. */
export async function getForecastRows(site, dayIso) {
  const d = await getDb();
  if (!d) return null;
  const docs = await d.collection('forecast_log')
    .find({ site, time: { $gte: dayIso, $lt: addDaysIso(dayIso, 1) } }, { projection: { _id: 0 } })
    .sort({ time: 1 }).toArray();
  return docs.length ? docs : null;
}

/** Rows whose time string is within [startIso, endExclusiveIso). */
export async function getForecastRange(site, startIso, endExclusiveIso) {
  const d = await getDb();
  if (!d) return null;
  const docs = await d.collection('forecast_log')
    .find({ site, time: { $gte: startIso, $lt: endExclusiveIso } }, { projection: { _id: 0 } })
    .sort({ time: 1 }).toArray();
  return docs.length ? docs : null;
}

// ---------------- historical ----------------
export async function getHistoricalRows(site, resolution, start, endBound) {
  const d = await getDb();
  if (!d) return null;
  const docs = await d.collection('historical')
    .find(
      { site_id: site, resolution, timestamp: { $gte: start, $lte: endBound } },
      { projection: { _id: 0, site_id: 0, resolution: 0 } },
    ).sort({ timestamp: 1 }).toArray();
  return docs.length ? docs : null;
}

// ---------------- model_backtest cache ----------------
export async function getBacktest(site, start, end) {
  const d = await getDb();
  if (!d) return null;
  return d.collection('model_backtest').findOne({ site, start, end }, { projection: { _id: 0 } });
}
export async function saveBacktest(site, start, end, report) {
  const d = await getDb();
  if (!d) return;
  await d.collection('model_backtest').replaceOne(
    { site, start, end }, { ...report, site, start, end }, { upsert: true });
}
