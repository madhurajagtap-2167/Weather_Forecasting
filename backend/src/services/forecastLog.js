import fs from 'node:fs';
import path from 'node:path';
import {
  SITES, DATA_DIR, PILOT_SITE_DISPLAY_NAMES, SNAPSHOT_DIR, SNAPSHOT_HOURLY_DIR,
} from '../config.js';
import { saveForecastRows } from '../db.js';
import {
  readCsv, writeCsv, parseTime, toIstIso, dayFileName, toNum,
} from '../utils.js';

export const FIELDNAMES = [
  'time', 'ghi', 'dni', 'dhi', 'temperature', 'windSpeed', 'humidity',
  'poaGlobal', 'poaDirect', 'poaDiffuse', 'call_at',
];
const NUM_FIELDS = FIELDNAMES.filter((f) => f !== 'time' && f !== 'call_at');

const pad = (n) => String(n).padStart(2, '0');
const callAtStr = (ms) => toIstIso(ms).slice(0, 16).replace('T', ' ');

/**
 * Merges completed-time forecast points into DATA_DIR/<SITE>/<DD_Month_YYYY>.csv
 * (one file per IST day, one row per time) and mirrors them into MongoDB.
 */
export async function logForecast(siteName, points, nowMs = Date.now()) {
  const siteDir = path.join(DATA_DIR, siteName);
  fs.mkdirSync(siteDir, { recursive: true });
  const filePath = path.join(siteDir, `${dayFileName(nowMs)}.csv`);
  const callAt = callAtStr(nowMs);

  const existing = new Map();
  if (fs.existsSync(filePath)) {
    for (const row of readCsv(filePath)) {
      const r = {};
      for (const f of FIELDNAMES) r[f] = row[f];
      existing.set(row.time, r);
    }
  }

  const saved = [];
  for (const p of points) {
    const t = parseTime(p.time);
    if (Number.isNaN(t) || t > nowMs) continue; // only points whose time has already passed
    const row = { ...Object.fromEntries(NUM_FIELDS.map((f) => [f, p[f]])), time: p.time, call_at: callAt };
    existing.set(p.time, row);
    saved.push(row);
  }

  const rows = [...existing.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  writeCsv(filePath, FIELDNAMES, rows);

  try {
    await saveForecastRows(siteName, saved.map((r) => ({
      ...r, ...Object.fromEntries(NUM_FIELDS.map((f) => [f, toNum(r[f])])),
    })));
  } catch (e) {
    console.warn(`Mongo write failed for ${siteName}: ${e.message}`);
  }
  console.log(`[${toIstIso(nowMs)}] Logged ${saved.length} completed-time points for ${siteName} -> ${filePath}`);
  return saved.length;
}

const CANDIDATE_SNAPSHOT_FIELDS = [
  'ghi', 'dni', 'dhi', 'temperature', 'windSpeed', 'humidity',
  'poaGlobal', 'poaDirect', 'poaDiffuse',
];
export const dynamicFieldnames = (points) => [
  'time', ...CANDIDATE_SNAPSHOT_FIELDS.filter((f) => points.some((p) => p[f] != null)),
];

/** 15-min snapshot for a fixed capture time. Never overwrites an existing file. */
export function saveForecastSnapshot(siteKey, points, captureTime, nowMs = Date.now()) {
  const display = PILOT_SITE_DISPLAY_NAMES[siteKey] || siteKey;
  const dateStr = toIstIso(nowMs).slice(0, 10);
  const filePath = path.join(SNAPSHOT_DIR, display, `${display}_${dateStr}_${captureTime.replace(':', '')}.csv`);
  if (fs.existsSync(filePath)) {
    console.log(`SKIP (already exists, not overwriting): ${filePath}`);
    return null;
  }
  const fields = dynamicFieldnames(points);
  writeCsv(filePath, fields, points);
  console.log(`Snapshot saved: ${filePath} (${points.length} points)`);
  return filePath;
}

const HOUR = 3600000;
/** IST wall-clock hour floor, as epoch ms. */
const floorIstHour = (ms) => Math.floor((ms + 19800000) / HOUR) * HOUR - 19800000;
export const nextFullHour = (ms) => floorIstHour(ms) + HOUR;

/** Raw (non-interpolated) 24-row hourly snapshot starting at windowStart. */
export function saveForecastSnapshotHourly(siteKey, rawPoints, captureTime, windowStart, nowMs = Date.now()) {
  const display = PILOT_SITE_DISPLAY_NAMES[siteKey] || siteKey;
  const dateStr = toIstIso(nowMs).slice(0, 10);
  const filePath = path.join(
    SNAPSHOT_HOURLY_DIR, display, `${display}_${dateStr}_${captureTime.replace(':', '')}_hourly.csv`);
  if (fs.existsSync(filePath)) {
    console.log(`SKIP (hourly snapshot already exists, not overwriting): ${filePath}`);
    return null;
  }
  const byHour = new Map();
  for (const p of rawPoints) {
    const t = parseTime(p.time);
    if (Number.isNaN(t)) continue;
    const key = floorIstHour(t);
    if (!byHour.has(key)) byHour.set(key, p);
  }
  const fields = dynamicFieldnames(rawPoints);
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const target = windowStart + i * HOUR;
    const p = byHour.get(target);
    if (!p) continue; // no data for this hour -> skip, never fabricate
    rows.push({ ...p, time: toIstIso(target) });
  }
  if (!rows.length) {
    console.log(`No matching hourly points for ${siteKey} @ ${captureTime} - hourly file not written.`);
    return null;
  }
  writeCsv(filePath, fields, rows);
  console.log(`Hourly snapshot saved: ${filePath} (${rows.length}/24 rows)`);
  return filePath;
}

export { SITES, pad };
