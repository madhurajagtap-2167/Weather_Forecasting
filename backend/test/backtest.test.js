import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './helpers.js';

process.env.DATA_ROOT = makeTempRoot(['data', 'historical_data']);
const db = await import('../src/db.js');
db._setDbForTests(null);
// make getDb() report "unavailable" instantly (no real connection attempt)
const { score, runModelBacktest, payloadToSeries } = await import('../src/services/modelBacktest.js');

test('score(): MAE / RMSE / MAPE / accuracy', () => {
  const pred = new Map([['a', 110], ['b', 90], ['c', 5]]);
  const actual = new Map([['a', 100], ['b', 100], ['c', 10]]);
  const s = score(pred, actual, 20); // 'c' is below the MAPE threshold
  assert.equal(s.n, 3);
  assert.equal(s.mae, 8.33);
  assert.equal(s.rmse, 8.66);
  assert.equal(s.mape, 10);
  assert.equal(s.accuracy_pct, 90);
  assert.equal(score(new Map(), actual, 20).n, 0);
});

test('payloadToSeries rejects bad payloads', () => {
  assert.throws(() => payloadToSeries({ reason: 'nope' }), /nope/);
});

test('best_match scoring is identical to the original Python implementation (all 6 sites)', async () => {
  // fixtures/best_match_python.json was produced by running the ORIGINAL model_backtest.py
  // (_load_best_match_live_capture + _score) on the same data.
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/best_match_python.json', import.meta.url)));
  const { loadActual, loadBestMatchLiveCapture } = await import('../src/services/modelBacktest.js');
  let compared = 0;
  for (const [key, exp] of Object.entries(expected)) {
    if (!exp) continue;
    const [site, start, end] = key.split('|');
    const actual = await loadActual(site, start, end);
    const pred = await loadBestMatchLiveCapture(site, start, end);
    assert.deepEqual(score(pred.gti, actual.gti, 20.0), exp.irr, `${key} irradiance`);
    assert.deepEqual(score(pred.temp, actual.temp, 0.1), exp.temp, `${key} temperature`);
    compared++;
  }
  assert.equal(compared, 12);
});

test('failed API models are reported as errors, not fabricated', async () => {
  const rep = await runModelBacktest('KOTHAGUDEM', '2026-07-01', '2026-08-31', {
    forceRefresh: true, fetchHistory: async () => { throw new Error('offline'); },
  });
  assert.match(rep.models.ecmwf.error, /offline/);
  assert.equal(rep.models.best_match.irradiance.accuracy_pct, 88.18);
  assert.deepEqual(rep.ranking, ['best_match']);
  assert.equal(rep.ensemble, null);
});

test('ranking + ensemble with stubbed API models', async () => {
  const hist = await (await import('../src/services/modelBacktest.js')).loadActual('KASIPET', '2026-07-01', '2026-07-03');
  assert.ok(hist.gti.size > 0);
  const keys = [...hist.gti.keys()].sort();
  // fake "model" payloads: ecmwf = 5% too high, gfs = 20% too high, others = fail
  const mk = (f) => ({
    hourly: {
      time: keys.map((k) => k.slice(0, 16)),
      global_tilted_irradiance: keys.map((k) => hist.gti.get(k) * f),
      temperature_2m: keys.map((k) => hist.temp.get(k)),
    },
  });
  const rep = await runModelBacktest('KASIPET', '2026-07-01', '2026-07-03', {
    forceRefresh: true,
    fetchHistory: async (site, s, e, id) => {
      if (id === 'ecmwf_ifs025') return mk(1.05);
      if (id === 'gfs_seamless') return mk(1.2);
      throw new Error('unavailable');
    },
  });
  assert.equal(rep.best_single_model, 'ecmwf');
  assert.deepEqual(rep.ranking.slice(0, 2), ['ecmwf', 'gfs']);
  assert.ok(rep.models.ecmwf.combined_accuracy_pct > rep.models.gfs.combined_accuracy_pct);
  assert.deepEqual(rep.ensemble.models_used, ['ecmwf', 'gfs']);
  assert.equal(rep.recommendation, 'single');
});
