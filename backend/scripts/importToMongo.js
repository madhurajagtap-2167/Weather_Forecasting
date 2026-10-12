/**
 * One-time (re-runnable) loader: copies the existing CSV / JSON files into MongoDB.
 *   npm run import              import everything
 *   npm run import -- --reset   drop the 3 collections first
 * Safe to run repeatedly - every row is upserted on its unique key.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, HISTORICAL_PROCESSED_DIR, HISTORICAL_PROCESSED_15MIN_DIR, MODEL_BACKTEST_DIR,
} from '../src/config.js';
import { getDb, closeDb, ensureIndexes } from '../src/db.js';
import { readCsv, toNum } from '../src/utils.js';

const BATCH = 5000;
const NUMERIC_HIST = ['global_tilted_irradiance', 'temperature_2m', 'surface_temperature',
  'precipitation', 'cloud_cover_low'];
const NUMERIC_FORECAST = ['ghi', 'dni', 'dhi', 'temperature', 'windSpeed', 'humidity',
  'poaGlobal', 'poaDirect', 'poaDiffuse'];
const DAY_FILE_RE = /^\d{2}_[A-Za-z]+_\d{4}\.csv$/; // skips the 24_hrs_* report files

async function bulk(coll, ops) {
  for (let i = 0; i < ops.length; i += BATCH) {
    await coll.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
  }
}
const csvFiles = (dir, re = /\.csv$/) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).sort() : []);

async function importHistorical(db) {
  for (const [resolution, dir] of [['hourly', HISTORICAL_PROCESSED_DIR], ['15min', HISTORICAL_PROCESSED_15MIN_DIR]]) {
    for (const f of csvFiles(dir)) {
      const ops = readCsv(path.join(dir, f)).map((r) => {
        const doc = { site_id: r.site_id, resolution, timestamp: r.timestamp };
        for (const c of NUMERIC_HIST) doc[c] = toNum(r[c]);
        return {
          updateOne: {
            filter: { site_id: doc.site_id, resolution, timestamp: doc.timestamp },
            update: { $set: doc }, upsert: true,
          },
        };
      });
      await bulk(db.collection('historical'), ops);
      console.log(`  historical/${resolution}: ${f} -> ${ops.length} rows`);
    }
  }
}

async function importForecastLog(db) {
  if (!fs.existsSync(DATA_DIR)) return;
  for (const site of fs.readdirSync(DATA_DIR).sort()) {
    const dir = path.join(DATA_DIR, site);
    if (!fs.statSync(dir).isDirectory()) continue;
    const ops = [];
    for (const f of csvFiles(dir, DAY_FILE_RE)) {
      for (const r of readCsv(path.join(dir, f))) {
        const doc = { site, time: r.time, call_at: r.call_at ?? null };
        for (const c of NUMERIC_FORECAST) doc[c] = toNum(r[c]);
        ops.push({ updateOne: { filter: { site, time: doc.time }, update: { $set: doc }, upsert: true } });
      }
    }
    await bulk(db.collection('forecast_log'), ops);
    console.log(`  forecast_log: ${site} -> ${ops.length} rows`);
  }
}

async function importBacktests(db) {
  if (!fs.existsSync(MODEL_BACKTEST_DIR)) return;
  for (const f of fs.readdirSync(MODEL_BACKTEST_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const rep = JSON.parse(fs.readFileSync(path.join(MODEL_BACKTEST_DIR, f), 'utf8'));
    const key = { site: rep.site, start: rep.start, end: rep.end };
    await db.collection('model_backtest').replaceOne(key, { ...rep, ...key }, { upsert: true });
    console.log(`  model_backtest: ${f}`);
  }
}

export async function runImport(db, { reset = false } = {}) {
  if (reset) {
    for (const c of ['forecast_log', 'historical', 'model_backtest']) await db.collection(c).drop().catch(() => {});
    await ensureIndexes(db);
  }
  console.log('Importing historical data...');
  await importHistorical(db);
  console.log('Importing forecast log...');
  await importForecastLog(db);
  console.log('Importing model backtest reports...');
  await importBacktests(db);
  console.log('Done.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('importToMongo.js')) {
  const db = await getDb();
  if (!db) {
    console.error('MongoDB is not reachable. Start it first (see README) and check MONGO_URI in .env.');
    process.exit(1);
  }
  await runImport(db, { reset: process.argv.includes('--reset') });
  await closeDb();
}
