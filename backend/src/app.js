import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import {
  SITES, DATA_DIR, HISTORICAL_PROCESSED_DIR, HISTORICAL_PROCESSED_15MIN_DIR,
} from './config.js';
import { getForecastRows, getHistoricalRows, mongoStatus } from './db.js';
import { fetchSolarForecast15min } from './services/openmeteo.js';
import { logForecast } from './services/forecastLog.js';
import { runModelBacktest } from './services/modelBacktest.js';
import {
  readCsv, newestFile, toNum, dayFileName, dayFileToIso, istDateStr, addDaysIso,
} from './utils.js';

export function createApp({ forecast15min = fetchSolarForecast15min, backtest = runModelBacktest } = {}) {
  const app = express();
  app.use(cors()); // allow the React dev server (localhost:4002)
  app.use(express.json());

  // Express wrapper so async errors become JSON 500s
  const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

  app.get('/api/health', route(async (req, res) => {
    res.json({ status: 'ok', mongo: await mongoStatus() });
  }));

  app.get('/api/sites', (req, res) => {
    res.json(Object.entries(SITES).map(([name, s]) => ({ name, lat: s.lat, lon: s.lon })));
  });

  // Live 15-min forecast (POA included); logged to CSV + MongoDB when a named site is used
  app.get('/api/weather', route(async (req, res) => {
    const { site: siteName } = req.query;
    let { lat, lon } = req.query;
    let tilt; let azimuth;
    if (siteName && SITES[siteName]) {
      ({ lat, lon, tilt, azimuth } = SITES[siteName]);
    } else if (lat && lon) {
      lat = parseFloat(lat); lon = parseFloat(lon); tilt = 20; azimuth = 180;
      if (Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ error: "'lat' and 'lon' must be numbers" });
    } else {
      return res.status(400).json({ error: "Provide either 'site' or 'lat'+'lon'" });
    }

    let points;
    try {
      points = await forecast15min(lat, lon, { tilt, azimuth });
    } catch (e) {
      return res.status(502).json({ error: `Open-Meteo solar request failed: ${e.message}` });
    }
    if (siteName && SITES[siteName]) await logForecast(siteName, points);
    res.json({ site: siteName ?? null, lat, lon, forecast: points });
  }));

  // Logged forecast rows for one IST day (MongoDB first, CSV fallback)
  app.get('/api/forecast-log', route(async (req, res) => {
    const { site: siteName } = req.query;
    let dateStr = req.query.date; // DD_Month_YYYY
    if (!siteName || !SITES[siteName]) return res.status(400).json({ error: "Provide a valid 'site'" });
    if (!dateStr) dateStr = dayFileName(Date.now());

    const dayIso = dayFileToIso(dateStr);
    if (!dayIso) return res.status(400).json({ error: 'date must look like 14_August_2026' });

    const shape = (r) => ({
      time: r.time, ghi: toNum(r.ghi), dni: toNum(r.dni), dhi: toNum(r.dhi),
      temperature: toNum(r.temperature), windSpeed: toNum(r.windSpeed), humidity: toNum(r.humidity),
      poaGlobal: toNum(r.poaGlobal), poaDirect: toNum(r.poaDirect), poaDiffuse: toNum(r.poaDiffuse),
      callAt: r.call_at ?? null,
    });

    const mongoRows = await getForecastRows(siteName, dayIso);
    if (mongoRows) return res.json({ site: siteName, date: dateStr, forecast: mongoRows.map(shape) });

    const filePath = path.join(DATA_DIR, siteName, `${dateStr}.csv`);
    if (!fs.existsSync(filePath)) return res.json({ site: siteName, date: dateStr, forecast: [] });
    res.json({ site: siteName, date: dateStr, forecast: readCsv(filePath).map(shape) });
  }));

  // Historical archive rows (MongoDB first, CSV fallback)
  app.get('/api/historical', route(async (req, res) => {
    const { site: siteName } = req.query;
    const resolution = req.query.resolution || 'hourly';
    let { start, end } = req.query;
    if (!siteName || !SITES[siteName]) return res.status(400).json({ error: "Provide a valid 'site'" });
    if (!['hourly', '15min'].includes(resolution)) {
      return res.status(400).json({ error: "resolution must be 'hourly' or '15min'" });
    }
    // Default to the last 14 days so a plain request can't pull 2 years of 15-min data
    if (!end) end = istDateStr(Date.now());
    if (!start) start = addDaysIso(end, -14);
    const endBound = `${end}T23:59:59`;

    const pick = (r) => ({
      timestamp: r.timestamp,
      global_tilted_irradiance: toNum(r.global_tilted_irradiance),
      temperature_2m: toNum(r.temperature_2m),
      surface_temperature: toNum(r.surface_temperature),
      precipitation: toNum(r.precipitation),
      cloud_cover_low: toNum(r.cloud_cover_low),
    });

    const mongoRows = await getHistoricalRows(siteName, resolution, start, endBound);
    if (mongoRows) {
      return res.json({ site: siteName, resolution, start, end, file: 'mongodb', rows: mongoRows.map(pick) });
    }

    const file = resolution === '15min'
      ? newestFile(HISTORICAL_PROCESSED_15MIN_DIR, new RegExp(`^${siteName}_historical_15min_.*\\.csv$`))
      : newestFile(HISTORICAL_PROCESSED_DIR, new RegExp(`^${siteName}_historical_.*\\.csv$`), /_15min_/);
    if (!file) {
      return res.json({
        site: siteName, resolution, start, end, rows: [],
        error: 'No historical data found. Run `npm run historical` first.',
      });
    }
    const rows = readCsv(file, { cache: true })
      .filter((r) => r.timestamp >= start && r.timestamp <= endBound).map(pick);
    res.json({ site: siteName, resolution, start, end, file: path.basename(file), rows });
  }));

  // Which NWP model fits a site best (single vs ensemble)
  app.get('/api/model-backtest', route(async (req, res) => {
    const { site: siteName, start, end } = req.query;
    const forceRefresh = String(req.query.refresh || 'false').toLowerCase() === 'true';
    if (!siteName || !SITES[siteName]) return res.status(400).json({ error: "Provide a valid 'site'" });
    if (!start || !end) return res.status(400).json({ error: "Provide 'start' and 'end' (YYYY-MM-DD)" });
    try {
      res.json(await backtest(siteName, start, end, { forceRefresh }));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }));

  return app;
}
