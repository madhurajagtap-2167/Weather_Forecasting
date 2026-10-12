import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, SNAPSHOT_DIR, PILOT_SITES, PILOT_SITE_DISPLAY_NAMES,
} from '../config.js';
import {
  readCsv, writeCsv, parseTime, toIstIso, istParts, monthName, toNum, round, IST_OFFSET_MS,
} from '../utils.js';

const REPORT_PARAMS = [
  ['ghi', 'ghi_{label}'],
  ['temperature', 'temperature_{label}'],
  ['poaGlobal', 'POA_Global_{label}'],
  ['poaDiffuse', 'POA_Diffuse {label}'],
  ['poaDirect', 'POA_Direct {label}'],
];
const SNAPSHOT_RE = /_(\d{4})\.csv$/;

function captureLabel(hhmm) {
  const hour = parseInt(hhmm.slice(0, 2), 10);
  const minute = parseInt(hhmm.slice(2), 10);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')}`;
}

function findSnapshotFiles(displayName, dateIso) {
  const dir = path.join(SNAPSHOT_DIR, displayName);
  if (!fs.existsSync(dir)) return [];
  const prefix = `${displayName}_${dateIso}_`;
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv') && SNAPSHOT_RE.test(f))
    .map((f) => [SNAPSHOT_RE.exec(f)[1], path.join(dir, f)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function loadSeries(filePath, col) {
  const rows = readCsv(filePath);
  if (!rows.length || !(col in rows[0])) return null;
  const pts = [];
  for (const r of rows) {
    const t = parseTime(r.time);
    if (!Number.isNaN(t)) pts.push([t, toNum(r[col])]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts.length ? pts : null;
}

/** Linear interpolation strictly BETWEEN known points (no extrapolation). */
function interpInside(pts, t) {
  if (!pts) return null;
  const known = pts.filter((p) => p[1] != null);
  if (!known.length || t < known[0][0] || t > known[known.length - 1][0]) return null;
  for (let i = 0; i < known.length; i++) {
    if (known[i][0] === t) return known[i][1];
    if (known[i][0] > t) {
      const [t0, v0] = known[i - 1]; const [t1, v1] = known[i];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return null;
}

/** Builds DATA_DIR/<SITE>/24_hrs_<Display>_<d>_<month>_<yyyy>.csv for a pilot site. */
export function buildDailyReport(siteKey, nowMs = Date.now()) {
  const display = PILOT_SITE_DISPLAY_NAMES[siteKey] || siteKey;
  const p = istParts(nowMs);
  const dateIso = `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const captures = findSnapshotFiles(display, dateIso);
  if (!captures.length) {
    console.log(`[report_builder] No snapshots found for ${siteKey} on ${dateIso} - skipping.`);
    return null;
  }
  const dayStart = Date.parse(`${dateIso}T00:00:00+05:30`);
  const start = dayStart + 7 * 3600000;
  const grid = Array.from({ length: 96 }, (_, i) => start + i * 900000); // 07:00 .. next day 06:45

  const fields = ['time'];
  const cols = {};
  for (const [hhmm, file] of captures) {
    const label = captureLabel(hhmm);
    for (const [valueCol, tmpl] of REPORT_PARAMS) {
      const name = tmpl.replace('{label}', label);
      fields.push(name);
      const series = loadSeries(file, valueCol);
      cols[name] = grid.map((t) => round(interpInside(series, t)));
    }
  }
  const rows = grid.map((t, i) => {
    const r = { time: toIstIso(t) };
    for (const f of fields.slice(1)) r[f] = cols[f][i];
    return r;
  });

  const outPath = path.join(
    DATA_DIR, siteKey, `24_hrs_${display}_${p.day}_${monthName(p.month).toLowerCase()}_${p.year}.csv`);
  writeCsv(outPath, fields, rows);
  console.log(`[report_builder] Wrote ${outPath} (${captures.length} captures, ${rows.length} rows)`);
  return outPath;
}

export function buildReportsForAllPilotSites(nowMs = Date.now()) {
  for (const siteKey of PILOT_SITES) {
    try { buildDailyReport(siteKey, nowMs); } catch (e) {
      console.error(`[report_builder] FAILED for ${siteKey}: ${e.message}`);
    }
  }
}
export { IST_OFFSET_MS };
