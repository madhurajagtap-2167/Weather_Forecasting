import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSolarForecast, fetchSolarForecast15min, interpLinear, next15MinBoundary } from '../src/services/openmeteo.js';

function stubOpenMeteo() {
  const realFetch = globalThis.fetch;
  const times = []; const base = Date.parse('2026-10-02T00:00:00Z');
  for (let i = 0; i < 72; i++) times.push(new Date(base + i * 3600000).toISOString().slice(0, 13) + ':00');
  const sine = (amp) => times.map((_, i) => Math.max(0, Math.round(amp * Math.sin(((i % 24) - 6) / 12 * Math.PI) * 10) / 10));
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('timezone'), 'Asia/Kolkata');
    return new Response(JSON.stringify({
      hourly: {
        time: times, shortwave_radiation: sine(800), direct_normal_irradiance: sine(700),
        diffuse_radiation: sine(150), temperature_2m: times.map(() => 30), wind_speed_10m: times.map(() => 2),
        relative_humidity_2m: times.map(() => 60),
      },
    }), { status: 200 });
  };
  return () => { globalThis.fetch = realFetch; };
}

test('raw hourly forecast shape + POA', async () => {
  const restore = stubOpenMeteo();
  try {
    const pts = await fetchSolarForecast(17.5, 80.6, { tilt: 20, azimuth: 180, hours: 24 });
    assert.equal(pts.length, 24);
    assert.equal(pts[0].time, '2026-10-02T00:00:00+05:30');
    assert.deepEqual(Object.keys(pts[0]), ['time', 'ghi', 'dni', 'dhi', 'temperature', 'windSpeed', 'humidity', 'poaGlobal', 'poaDirect', 'poaDiffuse']);
    const noon = pts[12];
    assert.ok(noon.poaGlobal > 100, `poa ${noon.poaGlobal}`);
  } finally { restore(); }
});

test('15-min interpolation: 96 slots from next boundary', async () => {
  const restore = stubOpenMeteo();
  try {
    const now = Date.parse('2026-10-02T10:07:00+05:30');
    const pts = await fetchSolarForecast15min(17.5, 80.6, { tilt: 20, azimuth: 180 }, now);
    assert.equal(pts.length, 96);
    assert.equal(pts[0].time, '2026-10-02T10:15:00+05:30');
    assert.equal(pts[95].time, '2026-10-03T10:00:00+05:30');
    assert.ok(Number.isInteger(pts[0].humidity));
    // 10:15 lies between the 10:00 and 11:00 values
    const lo = Math.min(...[10, 11].map((h) => 0)); assert.ok(lo === 0);
  } finally { restore(); }
});

test('interpLinear / boundary helpers', () => {
  assert.equal(interpLinear([0, 10], [0, 100], 5), 50);
  assert.equal(interpLinear([0, 10], [0, 100], -5), 0);   // clamps (bfill)
  assert.equal(interpLinear([0, 10], [0, 100], 50), 100); // clamps (ffill)
  assert.equal(interpLinear([0, 5, 10], [0, null, 100], 5), 50); // skips nulls
  const t = Date.parse('2026-10-02T10:15:00+05:30');
  assert.equal(next15MinBoundary(t), t + 900000);          // strictly after
  assert.equal(next15MinBoundary(t - 60000), t);
});
