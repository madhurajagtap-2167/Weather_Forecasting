import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';

process.env.DATA_ROOT = makeTempRoot(['forecast']);
const db = await import('../src/db.js');
db._setDbForTests(null);
const { logForecast, saveForecastSnapshot, saveForecastSnapshotHourly, nextFullHour } = await import('../src/services/forecastLog.js');
const { buildDailyReport } = await import('../src/services/reportBuilder.js');
const { DATA_DIR, SNAPSHOT_DIR, SNAPSHOT_HOURLY_DIR } = await import('../src/config.js');
const { readCsv, toIstIso } = await import('../src/utils.js');

const NOW = Date.parse('2026-10-03T10:07:00+05:30');
const pt = (min, v) => ({ time: toIstIso(NOW - min * 60000), ghi: v, dni: v, dhi: v, temperature: 30, windSpeed: 1, humidity: 50, poaGlobal: v, poaDirect: v, poaDiffuse: v });

test('logForecast: only completed times, merges and de-duplicates by time', async () => {
  const future = { ...pt(0, 1), time: toIstIso(NOW + 3600000) };
  const n1 = await logForecast('KASIPET', [pt(30, 10), pt(15, 20), future], NOW);
  assert.equal(n1, 2);
  await logForecast('KASIPET', [pt(15, 99)], NOW + 60000);
  const rows = readCsv(path.join(DATA_DIR, 'KASIPET', '03_October_2026.csv'));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].ghi, '99');
  assert.deepEqual(Object.keys(rows[0]).slice(-1), ['call_at']);
  assert.equal(rows[0].call_at, '2026-10-03 10:07');
});

test('snapshots never overwrite; hourly = 24 rows from next full hour; report interpolates', () => {
  const start = nextFullHour(NOW);
  assert.equal(toIstIso(start), '2026-10-03T11:00:00+05:30');

  const pts = Array.from({ length: 96 }, (_, i) => ({
    time: toIstIso(NOW + 480000 + i * 900000), ghi: 100 + i, temperature: 30, poaGlobal: 90 + i, poaDiffuse: 10, poaDirect: 80 + i,
  }));
  const f = saveForecastSnapshot('KOTHAGUDEM', pts, '08:15', NOW);
  assert.ok(f.endsWith('Kothagudem_2026-10-03_0815.csv'));
  assert.equal(saveForecastSnapshot('KOTHAGUDEM', pts, '08:15', NOW), null); // exists -> skipped

  const raw = Array.from({ length: 48 }, (_, i) => ({ time: toIstIso(start - 3600000 + i * 3600000), ghi: i, temperature: 30 }));
  const h = saveForecastSnapshotHourly('KOTHAGUDEM', raw, '08:15', start, NOW);
  const hrows = readCsv(h);
  assert.equal(hrows.length, 24);
  assert.equal(hrows[0].time, '2026-10-03T11:00:00+05:30');
  assert.ok(h.startsWith(SNAPSHOT_HOURLY_DIR));

  const out = buildDailyReport('KOTHAGUDEM', NOW);
  const rep = readCsv(out);
  assert.equal(rep.length, 96);
  assert.equal(rep[0].time, '2026-10-03T07:00:00+05:30');
  assert.ok('ghi_8:15' in rep[0] && 'POA_Global_8:15' in rep[0] && 'POA_Diffuse 8:15' in rep[0]);
  // outside the snapshot's range -> empty (no extrapolation)
  assert.equal(rep[0]['ghi_8:15'], '');
  const filled = rep.filter((r) => r['ghi_8:15'] !== '');
  assert.ok(filled.length > 50);
  assert.ok(SNAPSHOT_DIR);
});
