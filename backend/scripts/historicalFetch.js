/**
 * Fetches historical weather for ALL sites from the Open-Meteo Historical Weather
 * (archive) API - commercial tier, needs OPENMETEO_API_KEY in .env - and writes:
 *   historical_data/raw/<SITE>/<SITE>_<start>_<end>_partNN.json   raw API responses
 *   historical_data/processed/<SITE>_historical_<start>_<end>.csv  hourly, cleaned
 *   historical_data_15min/<SITE>_historical_15min_<start>_<end>.csv  15-min interpolated
 *
 *   npm run historical                                   default range, all sites
 *   npm run historical -- --start-date 2025-09-12 --end-date 2026-09-11
 *   npm run historical -- --sites KOTHAGUDEM,SIRMOUR
 *   npm run historical -- --from-raw    rebuild the CSVs from saved raw JSON (no API calls)
 * Add --mongo to also upsert the results into MongoDB.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SITES, OPENMETEO_ARCHIVE_HOST, OPENMETEO_ARCHIVE_PATH, OPENMETEO_API_KEY, HISTORICAL_TIMEZONE,
  HISTORICAL_RAW_DIR, HISTORICAL_PROCESSED_DIR, HISTORICAL_PROCESSED_15MIN_DIR,
} from '../src/config.js';
import { getDb, closeDb } from '../src/db.js';
import { getJson } from '../src/services/openmeteo.js';
import { writeCsv, toNum, round } from '../src/utils.js';

// Output column -> Open-Meteo hourly variable. Open-Meteo has no literal
// "surface_temperature"; soil_temperature_0_to_7cm is the closest real field.
export const HOURLY_VARIABLE_MAP = {
  global_tilted_irradiance: 'global_tilted_irradiance',
  temperature_2m: 'temperature_2m',
  surface_temperature: 'soil_temperature_0_to_7cm',
  precipitation: 'precipitation',
  cloud_cover_low: 'cloud_cover_low',
};
const VALUE_COLS = Object.keys(HOURLY_VARIABLE_MAP);
export const OUTPUT_COLUMNS = ['site_id', 'timestamp', ...VALUE_COLS];
const MAX_RETRIES = 4;
const RETRY_BACKOFF_MS = 5000;
const REQUEST_PAUSE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

export function* dateChunks(start, end, chunkDays) {
  let cur = start;
  while (cur <= end) {
    const chunkEnd = new Date(Math.min(addDays(cur, chunkDays - 1).getTime(), end.getTime()));
    yield [cur, chunkEnd];
    cur = addDays(chunkEnd, 1);
  }
}

async function fetchChunk(siteName, site, cs, ce) {
  if (!OPENMETEO_API_KEY) throw new Error('OPENMETEO_API_KEY is not set. Add it to backend/.env');
  const url = `https://${OPENMETEO_ARCHIVE_HOST}${OPENMETEO_ARCHIVE_PATH}`;
  const params = {
    latitude: site.lat, longitude: site.lon, start_date: isoDate(cs), end_date: isoDate(ce),
    hourly: Object.values(HOURLY_VARIABLE_MAP).join(','), tilt: site.tilt, azimuth: site.azimuth,
    timezone: HISTORICAL_TIMEZONE, wind_speed_unit: 'ms', apikey: OPENMETEO_API_KEY,
  };
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try { return await getJson(url, params, 60000); } catch (e) { lastError = e.message; }
    console.log(`  [retry ${attempt}/${MAX_RETRIES}] ${siteName} ${isoDate(cs)}..${isoDate(ce)} failed: ${lastError}`);
    await sleep(RETRY_BACKOFF_MS * attempt);
  }
  throw new Error(`Giving up on ${siteName} ${isoDate(cs)}..${isoDate(ce)}: ${lastError}`);
}

/** Raw payload -> rows (no invented values: a missing variable stays null). */
export function payloadToRows(siteName, payload) {
  const h = payload.hourly;
  if (!h || !h.time) return [];
  return h.time.map((t, i) => {
    const row = { site_id: siteName, timestamp: t };
    for (const [out, omVar] of Object.entries(HOURLY_VARIABLE_MAP)) row[out] = toNum(h[omVar]?.[i]);
    return row;
  });
}

/** De-duplicate by timestamp, sort, and report missing values / hourly gaps. */
export function runQualityChecks(siteName, rows) {
  const seen = new Set(); const clean = [];
  for (const r of rows) {
    const key = r.timestamp.length === 16 ? `${r.timestamp}:00` : r.timestamp;
    if (seen.has(key)) continue;
    seen.add(key); clean.push({ ...r, timestamp: key });
  }
  clean.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const missing = Object.fromEntries(VALUE_COLS.map((c) => [c, clean.filter((r) => r[c] == null).length]));
  let gaps = 0; let firstGap = null;
  for (let i = 1; i < clean.length; i++) {
    const diffH = (Date.parse(`${clean[i].timestamp}Z`) - Date.parse(`${clean[i - 1].timestamp}Z`)) / 3600000;
    if (diffH > 1) { gaps += diffH - 1; firstGap ??= clean[i - 1].timestamp; }
  }
  const report = {
    site: siteName, rows_before: rows.length, rows_after: clean.length,
    duplicate_timestamps_removed: rows.length - clean.length,
    missing_value_counts: missing, gap_hours_count: gaps, first_gap: firstGap,
  };
  console.log(`  Data quality for ${siteName}: rows ${report.rows_before} -> ${report.rows_after}, `
    + `missing ${JSON.stringify(missing)}, gap hours ${gaps}`);
  return { rows: clean, report };
}

/** Hourly -> 15-min (linear, only BETWEEN real hourly points; never extrapolates). */
export function interpolateTo15min(siteName, hourly) {
  if (hourly.length < 2) return hourly;
  const t = hourly.map((r) => Date.parse(`${r.timestamp}Z`));
  const out = [];
  const first = t[0]; const last = t[t.length - 1];
  for (let ts = first; ts <= last; ts += 900000) {
    // locate surrounding hourly points
    let lo = 0; let hi = t.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= ts) lo = mid; else hi = mid; }
    const row = { site_id: siteName, timestamp: new Date(ts).toISOString().slice(0, 19) };
    for (const c of VALUE_COLS) {
      let v = null;
      if (t[lo] === ts) v = hourly[lo][c];
      else if (t[hi] === ts) v = hourly[hi][c];
      else if (hourly[lo][c] != null && hourly[hi][c] != null && t[lo] < ts && ts < t[hi]) {
        // same formula as numpy.interp (what pandas uses): slope * (x - x0) + y0
        v = ((hourly[hi][c] - hourly[lo][c]) / (t[hi] - t[lo])) * (ts - t[lo]) + hourly[lo][c];
      }
      row[c] = round(v);
    }
    out.push(row);
  }
  return out;
}

function loadRaw(siteName) {
  const dir = path.join(HISTORICAL_RAW_DIR, siteName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

async function writeToMongo(siteName, hourly, quarter) {
  const db = await getDb();
  if (!db) { console.log('  (MongoDB not reachable - skipping Mongo upsert)'); return; }
  for (const [resolution, rows] of [['hourly', hourly], ['15min', quarter]]) {
    const ops = rows.map((r) => ({
      updateOne: {
        filter: { site_id: r.site_id, resolution, timestamp: r.timestamp },
        update: { $set: { ...r, resolution } }, upsert: true,
      },
    }));
    for (let i = 0; i < ops.length; i += 5000) await db.collection('historical').bulkWrite(ops.slice(i, i + 5000), { ordered: false });
  }
  console.log(`  upserted ${hourly.length} hourly + ${quarter.length} 15-min rows into MongoDB`);
}

export async function fetchSiteHistory(siteName, start, end, { chunkDays = 92, fromRaw = false, mongo = false } = {}) {
  const site = SITES[siteName];
  console.log(`\n--- ${siteName} (${site.lat}, ${site.lon}) tilt=${site.tilt} azimuth=${site.azimuth} ---`);
  let rows = [];
  if (fromRaw) {
    for (const payload of loadRaw(siteName)) rows.push(...payloadToRows(siteName, payload));
  } else {
    let part = 1;
    for (const [cs, ce] of dateChunks(start, end, chunkDays)) {
      console.log(`  fetching ${isoDate(cs)} .. ${isoDate(ce)} (part ${part})`);
      const payload = await fetchChunk(siteName, site, cs, ce);
      const dir = path.join(HISTORICAL_RAW_DIR, siteName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${siteName}_${isoDate(cs)}_${isoDate(ce)}_part${String(part).padStart(2, '0')}.json`), JSON.stringify(payload));
      rows.push(...payloadToRows(siteName, payload));
      part++;
      await sleep(REQUEST_PAUSE_MS);
    }
  }
  const { rows: hourly, report } = runQualityChecks(siteName, rows);
  const tag = `${isoDate(start)}_${isoDate(end)}`;
  const hourlyPath = path.join(HISTORICAL_PROCESSED_DIR, `${siteName}_historical_${tag}.csv`);
  writeCsv(hourlyPath, OUTPUT_COLUMNS, hourly);
  console.log(`  wrote ${hourlyPath} (${hourly.length} rows)`);
  const quarter = interpolateTo15min(siteName, hourly);
  const quarterPath = path.join(HISTORICAL_PROCESSED_15MIN_DIR, `${siteName}_historical_15min_${tag}.csv`);
  writeCsv(quarterPath, OUTPUT_COLUMNS, quarter);
  console.log(`  wrote ${quarterPath} (${quarter.length} rows)`);
  if (mongo) await writeToMongo(siteName, hourly, quarter);
  return report;
}

function parseArgs(argv) {
  const a = { 'start-date': '2024-09-01', 'end-date': '2026-08-31', 'chunk-days': '92' };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (['from-raw', 'mongo'].includes(k)) a[k] = true; else a[k] = argv[++i];
  }
  return a;
}

if (process.argv[1]?.endsWith('historicalFetch.js')) {
  const args = parseArgs(process.argv.slice(2));
  const start = new Date(`${args['start-date']}T00:00:00Z`);
  const end = new Date(`${args['end-date']}T00:00:00Z`);
  if (end < start) { console.error('--end-date must not be before --start-date'); process.exit(1); }
  const names = args.sites ? args.sites.split(',').map((s) => s.trim().toUpperCase()) : Object.keys(SITES);
  const unknown = names.filter((n) => !SITES[n]);
  if (unknown.length) { console.error(`Unknown site(s): ${unknown}. Valid: ${Object.keys(SITES)}`); process.exit(1); }

  console.log(`Fetching ${args['start-date']} .. ${args['end-date']} for ${names.join(', ')}`);
  const reports = [];
  for (const n of names) {
    try {
      reports.push(await fetchSiteHistory(n, start, end, {
        chunkDays: parseInt(args['chunk-days'], 10), fromRaw: !!args['from-raw'], mongo: !!args.mongo,
      }));
    } catch (e) { console.error(`FAILED for ${n}: ${e.message}`); }
  }
  console.log('\n===== SUMMARY =====');
  for (const r of reports) console.log(`${r.site}: ${r.rows_after} rows, ${r.duplicate_timestamps_removed} dup(s) removed, ${r.gap_hours_count} gap hour(s)`);
  await closeDb();
}
