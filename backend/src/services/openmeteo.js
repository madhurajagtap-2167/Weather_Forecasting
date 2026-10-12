import { OPENMETEO_API_HOST, OPENMETEO_FORECAST_PATH } from '../config.js';
import { toIstIso, parseTime, round } from '../utils.js';
import { computePoa } from './solar.js';

const HOURLY_FIELDS = [
  'shortwave_radiation',       // -> ghi
  'direct_normal_irradiance',  // -> dni
  'diffuse_radiation',         // -> dhi
  'temperature_2m',            // -> temperature (C)
  'wind_speed_10m',            // -> windSpeed (m/s)
  'relative_humidity_2m',      // -> humidity (%)
].join(',');

/** GET JSON with timeout. Uses Node's built-in fetch. */
export async function getJson(url, params, timeoutMs = 15000) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * Raw hourly Open-Meteo forecast (+ POA when tilt & azimuth are given).
 * Returns [{time(IST iso), ghi, dni, dhi, temperature, windSpeed, humidity,
 *           poaGlobal, poaDirect, poaDiffuse}]
 */
export async function fetchSolarForecast(lat, lon, { tilt = null, azimuth = null, hours = 24 } = {}) {
  const forecastDays = Math.max(1, Math.min(16, Math.ceil(hours / 24) + 1));
  const payload = await getJson(`https://${OPENMETEO_API_HOST}${OPENMETEO_FORECAST_PATH}`, {
    latitude: lat, longitude: lon, hourly: HOURLY_FIELDS, timezone: 'Asia/Kolkata',
    wind_speed_unit: 'ms', forecast_days: forecastDays,
  });
  if (!payload.hourly) throw new Error(payload.reason || 'Open-Meteo request failed');

  const h = payload.hourly;
  const times = (h.time || []).slice(0, hours);
  return times.map((t, i) => {
    const ms = parseTime(t); // Open-Meteo returns local (IST) wall-clock times
    const ghi = h.shortwave_radiation?.[i] ?? null;
    const dni = h.direct_normal_irradiance?.[i] ?? null;
    const dhi = h.diffuse_radiation?.[i] ?? null;
    let poa = { poaGlobal: null, poaDirect: null, poaDiffuse: null };
    if (tilt != null && azimuth != null) poa = computePoa(ms, { ghi, dni, dhi, lat, lon, tilt, azimuth });
    return {
      time: toIstIso(ms), ghi, dni, dhi,
      temperature: h.temperature_2m?.[i] ?? null,
      windSpeed: h.wind_speed_10m?.[i] ?? null,
      humidity: h.relative_humidity_2m?.[i] ?? null,
      ...poa,
    };
  });
}

export const next15MinBoundary = (ms) => Math.floor(ms / 900000) * 900000 + 900000;

/** Linear interpolation at t over knots (sorted by time); clamps outside (ffill/bfill). */
export function interpLinear(knotsT, knotsV, t) {
  const pts = [];
  for (let i = 0; i < knotsT.length; i++) {
    if (knotsV[i] != null && Number.isFinite(knotsV[i]) && Number.isFinite(knotsT[i])) pts.push([knotsT[i], knotsV[i]]);
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a[0] - b[0]);
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  let lo = 0; let hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
  const [t0, v0] = pts[lo]; const [t1, v1] = pts[hi];
  return t1 === t0 ? v0 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/**
 * 96 rows at 15-min resolution covering 24 h from the next 15-min boundary,
 * linearly interpolated from the raw hourly data; POA recomputed per slot.
 * Humidity -> nearest whole number, everything else 2dp.
 */
export async function fetchSolarForecast15min(lat, lon, { tilt = null, azimuth = null } = {}, now = Date.now()) {
  const raw = await fetchSolarForecast(lat, lon, { hours: 48 });
  if (!raw.length) return [];
  const rawT = raw.map((p) => parseTime(p.time));
  const col = (k) => raw.map((p) => p[k]);
  const series = {
    ghi: col('ghi'), dni: col('dni'), dhi: col('dhi'),
    temperature: col('temperature'), windSpeed: col('windSpeed'), humidity: col('humidity'),
  };
  const start = next15MinBoundary(now);
  const out = [];
  for (let i = 0; i < 96; i++) {
    const t = start + i * 900000;
    const v = (k) => interpLinear(rawT, series[k], t);
    const ghi = v('ghi'); const dni = v('dni'); const dhi = v('dhi');
    let poa = { poaGlobal: null, poaDirect: null, poaDiffuse: null };
    if (tilt != null && azimuth != null) poa = computePoa(t, { ghi, dni, dhi, lat, lon, tilt, azimuth });
    const hum = v('humidity');
    out.push({
      time: toIstIso(t), ghi: round(ghi), dni: round(dni), dhi: round(dhi),
      temperature: round(v('temperature')), windSpeed: round(v('windSpeed')),
      humidity: hum == null ? null : Math.round(hum), ...poa,
    });
  }
  return out;
}
