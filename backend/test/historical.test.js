import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';

process.env.DATA_ROOT = makeTempRoot(['historical_data', 'historical_data_15min']);
const { fetchSiteHistory, dateChunks, interpolateTo15min } = await import('../scripts/historicalFetch.js');
const { HISTORICAL_PROCESSED_DIR, HISTORICAL_PROCESSED_15MIN_DIR } = await import('../src/config.js');
const { readCsv } = await import('../src/utils.js');

// float tie-breaking at exact .xx5 midpoints can differ by one cent from numpy
const near = (a, b) => (a === '' && b === '') || Math.abs(Number(a) - Number(b)) < 0.0101;

test('--from-raw rebuilds the exact CSVs the Python script produced', async () => {
  const site = 'KASIPET';
  const origH = readCsv(path.join(HISTORICAL_PROCESSED_DIR, `${site}_historical_2024-09-01_2026-08-31.csv`));
  const orig15 = readCsv(path.join(HISTORICAL_PROCESSED_15MIN_DIR, `${site}_historical_15min_2024-09-01_2026-08-31.csv`));
  fs.rmSync(path.join(HISTORICAL_PROCESSED_DIR, `${site}_historical_2024-09-01_2026-08-31.csv`));
  fs.rmSync(path.join(HISTORICAL_PROCESSED_15MIN_DIR, `${site}_historical_15min_2024-09-01_2026-08-31.csv`));

  await fetchSiteHistory(site, new Date('2024-09-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'), { fromRaw: true });
  const newH = readCsv(path.join(HISTORICAL_PROCESSED_DIR, `${site}_historical_2024-09-01_2026-08-31.csv`));
  const new15 = readCsv(path.join(HISTORICAL_PROCESSED_15MIN_DIR, `${site}_historical_15min_2024-09-01_2026-08-31.csv`));

  for (const [a, b] of [[origH, newH], [orig15, new15]]) {
    assert.equal(b.length, a.length);
    let bad = 0;
    a.forEach((r, i) => {
      if (r.timestamp !== b[i].timestamp) bad++;
      for (const c of Object.keys(r)) if (c !== 'timestamp' && c !== 'site_id' && !near(r[c], b[i][c])) bad++;
    });
    assert.ok(bad < a.length * 0.001, `${bad} mismatching cells`);
  }
});

test('chunking + interpolation never extrapolates', () => {
  const chunks = [...dateChunks(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-10T00:00:00Z'), 4)];
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2][1].toISOString().slice(0, 10), '2024-01-10');
  const rows = [
    { site_id: 'X', timestamp: '2024-01-01T00:00:00', global_tilted_irradiance: 0, temperature_2m: 20, surface_temperature: null, precipitation: 0, cloud_cover_low: 0 },
    { site_id: 'X', timestamp: '2024-01-01T01:00:00', global_tilted_irradiance: 100, temperature_2m: 24, surface_temperature: null, precipitation: 0, cloud_cover_low: 0 },
  ];
  const out = interpolateTo15min('X', rows);
  assert.equal(out.length, 5);
  assert.equal(out[2].global_tilted_irradiance, 50);
  assert.equal(out[1].temperature_2m, 21);
  assert.equal(out[1].surface_temperature, null);
});
