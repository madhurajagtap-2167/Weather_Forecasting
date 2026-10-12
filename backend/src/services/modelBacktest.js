/**
 * Model backtest: for a site and a past date range with real archived weather,
 * score what each NWP model PREDICTED (Open-Meteo Historical Forecast API) against
 * the real archive, rank them, and test an ensemble of the top models.
 *
 * "best_match" can't be scored from the Historical Forecast API (it echoes the
 * archive for past dates), so it is scored from your own live-captured forecasts
 * (the 15-min logs written by the scheduler) - genuine predictions made in advance.
 *
 * Reports are cached in MongoDB (collection model_backtest) and in
 * historical_data/model_backtest/*.json, keyed by site + date range.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SITES, DATA_DIR, HISTORICAL_TIMEZONE, HISTORICAL_PROCESSED_DIR, MODEL_BACKTEST_DIR,
  NWP_MODELS, OPENMETEO_HISTORICAL_FORECAST_HOST, OPENMETEO_HISTORICAL_FORECAST_PATH,
  OPENMETEO_API_KEY,
} from '../config.js';
import {
  getBacktest, saveBacktest, getHistoricalRows, getForecastRange,
} from '../db.js';
import {
  readCsv, newestFile, toNum, addDaysIso, dayFileName,
} from '../utils.js';
import { getJson } from './openmeteo.js';

const HOURLY_VARS = ['global_tilted_irradiance', 'temperature_2m'];
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 4000;
const REQUEST_PAUSE_MS = 1000;
const IRRADIANCE_MAPE_THRESHOLD = 20.0;
const TEMPERATURE_MAPE_THRESHOLD = 0.1;
const IRRADIANCE_WEIGHT = 0.7;
const TEMPERATURE_WEIGHT = 0.3;
const ENSEMBLE_TOP_N = 3;
export const BASELINE_MODEL_KEY = 'best_match';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => Math.round(v * 100) / 100;
/** Normalise "2026-07-01T00:00" / "...+05:30" to "YYYY-MM-DDTHH:MM:SS". */
const tsKey = (s) => {
  const t = String(s).slice(0, 19);
  return t.length === 16 ? `${t}:00` : t;
};

// ---------- actual (archive) ----------
/** Returns {gti:Map, temp:Map} for [start,end] or null if no archive is available. */
export async function loadActual(siteName, start, end, historicalDir = HISTORICAL_PROCESSED_DIR) {
  const endBound = `${end}T23:59:59`;
  let rows = await getHistoricalRows(siteName, 'hourly', start, endBound);
  if (!rows) {
    const file = newestFile(historicalDir, new RegExp(`^${siteName}_historical_(?!15min_).*\\.csv$`));
    if (!file) return null;
    rows = readCsv(file, { cache: true })
      .filter((r) => r.timestamp >= start && r.timestamp <= endBound);
  }
  if (!rows.length) return null;
  const gti = new Map(); const temp = new Map();
  for (const r of rows) {
    const k = tsKey(r.timestamp);
    const g = toNum(r.global_tilted_irradiance); const t = toNum(r.temperature_2m);
    if (g != null) gti.set(k, g);
    if (t != null) temp.set(k, t);
  }
  return { gti, temp };
}

// ---------- model predictions ----------
async function fetchModelHistory(site, start, end, omModelId) {
  const url = `https://${OPENMETEO_HISTORICAL_FORECAST_HOST}${OPENMETEO_HISTORICAL_FORECAST_PATH}`;
  const params = {
    latitude: site.lat, longitude: site.lon, start_date: start, end_date: end,
    hourly: HOURLY_VARS.join(','), models: omModelId, tilt: site.tilt, azimuth: site.azimuth,
    timezone: HISTORICAL_TIMEZONE, wind_speed_unit: 'ms',
  };
  if (OPENMETEO_API_KEY) params.apikey = OPENMETEO_API_KEY;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try { return await getJson(url, params, 60000); } catch (e) { lastError = e.message; }
    await sleep(RETRY_BACKOFF_MS * attempt);
  }
  throw new Error(`${omModelId} request failed: ${lastError}`);
}

export function payloadToSeries(payload) {
  const h = payload.hourly;
  if (!h || !h.time) throw new Error(payload.reason || 'Historical Forecast API request failed');
  const gti = new Map(); const temp = new Map();
  h.time.forEach((t, i) => {
    const k = tsKey(t);
    const g = toNum(h.global_tilted_irradiance?.[i]); const tt = toNum(h.temperature_2m?.[i]);
    if (g != null) gti.set(k, g);
    if (tt != null) temp.set(k, tt);
  });
  return { gti, temp };
}

/** MAE / RMSE / MAPE / accuracy% on shared timestamps (hours below the threshold skip MAPE only). */
export function score(pred, actual, mapeThreshold) {
  let n = 0; let sumAbs = 0; let sumSq = 0; let nv = 0; let sumPct = 0;
  for (const [k, p] of pred) {
    const a = actual.get(k);
    if (a === undefined) continue;
    const e = p - a;
    n++; sumAbs += Math.abs(e); sumSq += e * e;
    if (Math.abs(a) > mapeThreshold) { nv++; sumPct += Math.abs(e) / Math.abs(a); }
  }
  if (!n) return { mae: null, rmse: null, mape: null, accuracy_pct: null, n: 0 };
  let mape = null; let acc = null;
  if (nv) {
    const m = (sumPct / nv) * 100;
    acc = r2(Math.max(0, 100 - m));
    mape = r2(m);
  }
  return { mae: r2(sumAbs / n), rmse: r2(Math.sqrt(sumSq / n)), mape, accuracy_pct: acc, n };
}

/** Genuine live-captured best_match forecasts (poaGlobal as irradiance). */
export async function loadBestMatchLiveCapture(siteName, start, end, dataDir = DATA_DIR) {
  let rows = await getForecastRange(siteName, start, addDaysIso(end, 1));
  if (!rows) {
    rows = [];
    for (let d = start; d <= end; d = addDaysIso(d, 1)) {
      const f = path.join(dataDir, siteName, `${dayFileName(Date.parse(`${d}T12:00:00+05:30`))}.csv`);
      if (fs.existsSync(f)) rows.push(...readCsv(f));
    }
  }
  if (!rows.length) return null;
  const gti = new Map(); const temp = new Map();
  for (const r of rows) {
    if (!r.time) continue;
    const k = tsKey(r.time); // keep IST wall-clock, drop the offset
    const g = toNum(r.poaGlobal); const t = toNum(r.temperature);
    if (g != null) gti.set(k, g); else gti.delete(k);
    if (t != null) temp.set(k, t); else temp.delete(k);
  }
  return { gti, temp };
}

export async function runModelBacktest(siteName, start, end, { forceRefresh = false, fetchHistory = fetchModelHistory } = {}) {
  if (!SITES[siteName]) throw new Error(`Unknown site: ${siteName}`);

  fs.mkdirSync(MODEL_BACKTEST_DIR, { recursive: true });
  const cachePath = path.join(MODEL_BACKTEST_DIR, `${siteName}_model_backtest_${start}_${end}.json`);
  if (!forceRefresh) {
    const cached = await getBacktest(siteName, start, end);
    if (cached) return cached;
    if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }

  const site = SITES[siteName];
  const actual = await loadActual(siteName, start, end);
  if (!actual) {
    throw new Error(`No historical actual data found for ${siteName} in ${start}..${end}. `
      + 'Run `npm run historical` for this site/range first.');
  }

  const modelResults = {}; const predsGti = {};
  for (const [modelKey, omId] of Object.entries(NWP_MODELS)) {
    let pred;
    try {
      if (modelKey === BASELINE_MODEL_KEY) {
        pred = await loadBestMatchLiveCapture(siteName, start, end);
        if (!pred) {
          throw new Error(`No live-captured forecast data found in ${DATA_DIR}/${siteName}/ for ${start}..${end}. `
            + 'best_match can only be scored from genuine forecasts captured in advance by the running '
            + 'scheduler - it is not retroactively queryable. Let the scheduler run through this date range, '
            + 'then re-run the backtest.');
        }
      } else {
        pred = payloadToSeries(await fetchHistory(site, start, end, omId));
      }
    } catch (e) {
      modelResults[modelKey] = { openmeteo_model_id: omId, error: e.message };
      await sleep(REQUEST_PAUSE_MS);
      continue;
    }
    const gtiScore = score(pred.gti, actual.gti, IRRADIANCE_MAPE_THRESHOLD);
    const tempScore = score(pred.temp, actual.temp, TEMPERATURE_MAPE_THRESHOLD);
    let combined = null;
    if (gtiScore.accuracy_pct !== null) {
      const tAcc = tempScore.accuracy_pct !== null ? tempScore.accuracy_pct : gtiScore.accuracy_pct;
      combined = r2(IRRADIANCE_WEIGHT * gtiScore.accuracy_pct + TEMPERATURE_WEIGHT * tAcc);
    }
    modelResults[modelKey] = {
      openmeteo_model_id: omId, irradiance: gtiScore, temperature: tempScore, combined_accuracy_pct: combined,
    };
    predsGti[modelKey] = pred.gti;
    await sleep(REQUEST_PAUSE_MS);
  }

  const ranked = Object.entries(modelResults)
    .filter(([, v]) => v.combined_accuracy_pct != null && v.combined_accuracy_pct !== undefined)
    .sort((a, b) => b[1].combined_accuracy_pct - a[1].combined_accuracy_pct)
    .map(([k]) => k);
  const bestSingle = ranked[0] ?? null;

  let ensemble = null;
  const topKeys = ranked.slice(0, Math.min(ENSEMBLE_TOP_N, ranked.length));
  if (topKeys.length >= 2) {
    const sums = new Map(); const counts = new Map();
    for (const k of topKeys) {
      for (const [ts, v] of predsGti[k]) {
        sums.set(ts, (sums.get(ts) || 0) + v);
        counts.set(ts, (counts.get(ts) || 0) + 1);
      }
    }
    const mean = new Map([...sums].map(([ts, s]) => [ts, s / counts.get(ts)]));
    ensemble = { models_used: topKeys, irradiance: score(mean, actual.gti, IRRADIANCE_MAPE_THRESHOLD) };
  }

  let recommendation = 'single';
  if (bestSingle && ensemble
    && ensemble.irradiance.accuracy_pct !== null
    && modelResults[bestSingle].irradiance.accuracy_pct !== null
    && ensemble.irradiance.accuracy_pct > modelResults[bestSingle].irradiance.accuracy_pct) {
    recommendation = 'ensemble';
  }

  const report = {
    site: siteName, start, end, generated_at: new Date().toISOString(),
    models: modelResults, ranking: ranked, best_single_model: bestSingle,
    baseline_model: BASELINE_MODEL_KEY, ensemble, recommendation,
  };
  fs.writeFileSync(cachePath, JSON.stringify(report, null, 2));
  try { await saveBacktest(siteName, start, end, report); } catch (e) {
    console.warn(`Mongo cache write failed: ${e.message}`);
  }
  return report;
}
