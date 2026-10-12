import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

export const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const monthName = (i) => MONTHS[i];
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Epoch ms -> "YYYY-MM-DDTHH:MM:SS+05:30" (IST wall clock, like Python isoformat()). */
export function toIstIso(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30';
}
/** Epoch ms -> naive IST "YYYY-MM-DDTHH:MM:SS". */
export function toIstNaive(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19);
}
/** Parse a timestamp. Strings with no offset are treated as IST. */
export function parseTime(str) {
  if (typeof str !== 'string' || !str) return NaN;
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  let s = str.trim().replace(' ', 'T');
  if (/T\d{2}:\d{2}$/.test(s)) s += ':00';
  return Date.parse(hasOffset ? s : `${s}+05:30`);
}
/** IST calendar parts for an epoch ms. */
export function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(),
  };
}
/** "DD_Month_YYYY" for the IST date of ms (matches the existing CSV file names). */
export function dayFileName(ms) {
  const p = istParts(ms);
  return `${pad(p.day)}_${MONTHS[p.month]}_${p.year}`;
}
/** "YYYY-MM-DD" for the IST date of ms. */
export function istDateStr(ms) {
  return toIstNaive(ms).slice(0, 10);
}
/** Parse "DD_Month_YYYY" -> "YYYY-MM-DD" or null. */
export function dayFileToIso(str) {
  const m = /^(\d{1,2})_([A-Za-z]+)_(\d{4})$/.exec(str || '');
  if (!m) return null;
  const idx = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (idx < 0) return null;
  return `${m[3]}-${pad(idx + 1)}-${pad(m[1])}`;
}
export function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Round like numpy/pandas: rint(v * 10^d) / 10^d (exact halves go to the even neighbour). */
export const round = (v, d = 2) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  const y = v * f;
  let r = Math.round(y);
  if (Math.abs(y % 1) === 0.5) r = 2 * Math.round(y / 2);
  return r / f;
};

// ---------- CSV ----------
const csvCache = new Map(); // path -> {mtimeMs, rows}
export function readCsv(filePath, { cache = false } = {}) {
  if (cache) {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const hit = csvCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.rows;
    const rows = readCsv(filePath);
    csvCache.set(filePath, { mtimeMs, rows });
    return rows;
  }
  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
}
const csvCell = (v) => {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function writeCsv(filePath, fields, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [fields.map(csvCell).join(',')];
  for (const r of rows) lines.push(fields.map((f) => csvCell(r[f])).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}
/** Newest file in dir matching regex (by mtime), or null. */
export function newestFile(dir, regex, exclude) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => regex.test(f) && !(exclude && exclude.test(f)));
  if (!files.length) return null;
  return files
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
