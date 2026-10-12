import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';

process.env.DATA_ROOT = makeTempRoot();
process.env.DISABLE_SCHEDULER = 'true';

const { createApp } = await import('../src/app.js');
const db = await import('../src/db.js');
const { FakeDb } = await import('./fakeMongo.js');
const { runImport } = await import('../scripts/importToMongo.js');

const fakePoints = [{ time: '2020-01-01T00:15:00+05:30', ghi: 1, dni: 2, dhi: 3, temperature: 4, windSpeed: 5, humidity: 6, poaGlobal: 7, poaDirect: 8, poaDiffuse: 9 }];
let server; let base;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test.before(async () => {
  const app = createApp({
    forecast15min: async () => fakePoints,
    backtest: async (site, s, e) => ({ site, start: s, end: e, stub: true }),
  });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

test('CSV fallback works when MongoDB is down', async () => {
  db._setDbForTests(null);
  // force "unavailable": getDb would try a real connection - mark as just failed
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const sites = await get('/api/sites');
  assert.equal(sites.body.length, 6);
  assert.deepEqual(Object.keys(sites.body[0]), ['name', 'lat', 'lon']);

  const h = await get('/api/historical?site=KASIPET&start=2025-01-01&end=2025-01-02');
  assert.match(h.body.file, /^KASIPET_historical_.*\.csv$/);
  assert.equal(h.body.rows.length, 48);
  assert.deepEqual(Object.keys(h.body.rows[0]), ['timestamp', 'global_tilted_irradiance', 'temperature_2m', 'surface_temperature', 'precipitation', 'cloud_cover_low']);

  const h15 = await get('/api/historical?site=KASIPET&start=2025-01-01&end=2025-01-01&resolution=15min');
  assert.equal(h15.body.rows.length, 96);

  const fl = await get('/api/forecast-log?site=BHUPALPALLY&date=02_October_2026');
  assert.equal(fl.body.forecast.length, 10);
  assert.equal(fl.body.forecast[0].callAt, '2026-10-02 09:30');
});

test('validation errors', async () => {
  assert.equal((await get('/api/forecast-log?site=NOPE')).status, 400);
  assert.equal((await get('/api/forecast-log?site=KASIPET&date=bad')).status, 400);
  assert.equal((await get('/api/historical?site=KASIPET&resolution=weekly')).status, 400);
  assert.equal((await get('/api/weather')).status, 400);
  assert.equal((await get('/api/model-backtest?site=KASIPET')).status, 400);
  const bt = await get('/api/model-backtest?site=KASIPET&start=2026-07-01&end=2026-08-31');
  assert.equal(bt.body.stub, true);
});

test('MongoDB path: import, then API reads from Mongo', async () => {
  const fake = new FakeDb();
  db._setDbForTests(fake);
  await db.ensureIndexes(fake);
  await runImport(fake, {});
  // report files (24_hrs_*) must NOT be imported into forecast_log
  assert.ok(fake.collection('forecast_log').docs.every((d) => /^\d{4}-\d{2}-\d{2}T/.test(d.time) && d.site));
  assert.ok(fake.collection('historical').docs.length > 400000);

  const h = await get('/api/historical?site=KASIPET&start=2025-01-01&end=2025-01-02&resolution=15min');
  assert.equal(h.body.file, 'mongodb');
  assert.equal(h.body.rows.length, 192);
  assert.equal(h.body.rows[0].timestamp, '2025-01-01T00:00:00');

  const fl = await get('/api/forecast-log?site=BHUPALPALLY&date=02_October_2026');
  assert.equal(fl.body.forecast.length, 10);

  const health = await get('/api/health');
  assert.equal(health.body.mongo.connected, true);
  assert.ok(health.body.mongo.counts.model_backtest >= 5);
});

test('/api/weather logs the forecast to CSV and MongoDB', async () => {
  const fake = new FakeDb();
  db._setDbForTests(fake);
  const w = await get('/api/weather?site=KASIPET');
  assert.equal(w.status, 200);
  assert.equal(w.body.site, 'KASIPET');
  assert.equal(w.body.forecast.length, 1);
  // the stub point is in the past, so it must have been logged
  assert.equal(fake.collection('forecast_log').docs.length, 1);
  assert.equal(fake.collection('forecast_log').docs[0].site, 'KASIPET');
  const csvDir = path.join(process.env.DATA_ROOT, 'data', 'KASIPET');
  const today = (await import('../src/utils.js')).dayFileName(Date.now());
  assert.ok(fs.existsSync(path.join(csvDir, `${today}.csv`)));
});
