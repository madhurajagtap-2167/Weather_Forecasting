import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computePoa } from '../src/services/solar.js';

// Cases generated with pvlib (Python): perez model, apparent zenith, Spencer extra radiation.
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/pvlib_cases.json', import.meta.url)));

test('POA matches pvlib within 2 W/m2 (mean < 0.1)', () => {
  let sum = 0;
  for (const c of cases) {
    const o = computePoa(c.ms, { ghi: c.ghi, dni: c.dni, dhi: c.dhi, lat: c.lat, lon: c.lon, tilt: c.tilt, azimuth: 180 });
    const d = Math.abs(o.poaGlobal - c.g);
    sum += d;
    assert.ok(d < 2, `global off by ${d} for ${JSON.stringify(c)}`);
    assert.ok(Math.abs(o.poaDirect - c.d) < 0.5);
    assert.ok(Math.abs(o.poaDiffuse - c.f) < 2);
  }
  assert.ok(sum / cases.length < 0.1);
});

test('night / missing inputs', () => {
  const base = { lat: 18.4, lon: 79.8, tilt: 5, azimuth: 180 };
  assert.deepEqual(computePoa(Date.now(), { ghi: 0, dni: 0, dhi: 0, ...base }), { poaGlobal: 0, poaDirect: 0, poaDiffuse: 0 });
  assert.deepEqual(computePoa(Date.now(), { ghi: null, dni: 1, dhi: 1, ...base }), { poaGlobal: null, poaDirect: null, poaDiffuse: null });
});
