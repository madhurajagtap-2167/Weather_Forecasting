/**
 * Plane-of-array (POA) irradiance: JavaScript equivalent of what the old
 * Python code did with pvlib:
 *   solarposition.get_solarposition  (NREL-style position + refraction)
 *   irradiance.get_extra_radiation   (Spencer)
 *   irradiance.get_total_irradiance(model="perez", allsitescomposite1990, albedo 0.25)
 */
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm360 = (x) => ((x % 360) + 360) % 360;

/** Apparent solar zenith & azimuth (deg) for epoch ms at lat/lon. */
export function solarPosition(ms, lat, lon, pressure = 101325, temperature = 12) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;
  const L0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = norm360(357.52911 + T * (35999.05029 - 0.0001537 * T));
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T)
    + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const ra = Math.atan2(Math.cos(rad(eps)) * Math.sin(rad(lambda)), Math.cos(rad(lambda)));
  const gmst = norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T);
  const H = rad(norm360(gmst + lon - deg(ra)));
  const latR = rad(lat);

  const sinEl = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(H);
  const elevation = deg(Math.asin(Math.min(1, Math.max(-1, sinEl))));
  const azimuth = norm360(
    deg(Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(latR) - Math.tan(decl) * Math.cos(latR))) + 180,
  );

  // Atmospheric refraction (as in the NREL SPA)
  let refraction = 0;
  if (elevation >= -0.83337) {
    refraction = ((pressure / 101000) * (283 / (273 + temperature)) * 1.02)
      / (60 * Math.tan(rad(elevation + 10.3 / (elevation + 5.11))));
  }
  return { zenith: 90 - elevation, apparentZenith: 90 - (elevation + refraction), azimuth };
}

/** Extraterrestrial normal irradiance (W/m2), Spencer method. dayOfYear in IST. */
export function extraRadiation(dayOfYear, solarConstant = 1366.1) {
  const B = (2 * Math.PI * (dayOfYear - 1)) / 365;
  return solarConstant * (1.00011 + 0.034221 * Math.cos(B) + 0.00128 * Math.sin(B)
    + 0.000719 * Math.cos(2 * B) + 0.000077 * Math.sin(2 * B));
}
function dayOfYearIst(ms) {
  const d = new Date(ms + 5.5 * 3600 * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000) + 1;
}

// Perez 1990 "allsitescomposite1990" coefficients: [F11,F12,F13,F21,F22,F23]
const PEREZ = [
  [-0.008, 0.588, -0.062, -0.06, 0.072, -0.022],
  [0.13, 0.683, -0.151, -0.019, 0.066, -0.029],
  [0.33, 0.487, -0.221, 0.055, -0.064, -0.026],
  [0.568, 0.187, -0.295, 0.109, -0.152, -0.014],
  [0.873, -0.392, -0.362, 0.226, -0.462, 0.001],
  [1.132, -1.237, -0.412, 0.288, -0.823, 0.056],
  [1.06, -1.6, -0.359, 0.264, -1.127, 0.131],
  [0.678, -0.327, -0.25, 0.156, -1.377, 0.251],
];
const EPS_BINS = [0, 1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];

/** Kasten-Young 1989 relative airmass (NaN below horizon, like pvlib). */
function relativeAirmass(zenith) {
  if (zenith > 90 || !Number.isFinite(zenith)) return NaN;
  return 1 / (Math.cos(rad(zenith)) + 0.50572 * (6.07995 + (90 - zenith)) ** -1.6364);
}

/**
 * POA irradiance for one instant.
 * @returns {{poaGlobal:number|null, poaDirect:number|null, poaDiffuse:number|null}} rounded to 2dp
 */
export function computePoa(ms, { ghi, dni, dhi, lat, lon, tilt, azimuth, albedo = 0.25 }) {
  if (ghi == null || dni == null || dhi == null) return { poaGlobal: null, poaDirect: null, poaDiffuse: null };
  if (ghi <= 0 && dni <= 0 && dhi <= 0) return { poaGlobal: 0, poaDirect: 0, poaDiffuse: 0 };

  const sp = solarPosition(ms, lat, lon);
  const zen = sp.apparentZenith;
  const zenR = rad(zen);
  const tiltR = rad(tilt);
  const aoiProj = Math.cos(tiltR) * Math.cos(zenR)
    + Math.sin(tiltR) * Math.sin(zenR) * Math.cos(rad(sp.azimuth - azimuth));
  const aoi = deg(Math.acos(Math.min(1, Math.max(-1, aoiProj))));

  // --- Perez sky diffuse ---
  const dniExtra = extraRadiation(dayOfYearIst(ms));
  const airmass = relativeAirmass(zen);
  const kappa = 1.041;
  const delta = (dhi * airmass) / dniExtra;
  const eps = (((dhi + dni) / dhi) + kappa * zenR ** 3) / (1 + kappa * zenR ** 3);

  let skyDiffuse = 0;
  if (!Number.isNaN(airmass) && !Number.isNaN(eps)) {
    let bin = 0;
    for (let i = 0; i < EPS_BINS.length; i++) if (eps >= EPS_BINS[i]) bin = i;
    const c = PEREZ[bin];
    const F1 = Math.max(c[0] + c[1] * delta + c[2] * zenR, 0);
    const F2 = c[3] + c[4] * delta + c[5] * zenR;
    const A = Math.max(aoiProj, 0);
    const B = Math.max(Math.cos(zenR), Math.cos(rad(85)));
    const term1 = 0.5 * (1 - F1) * (1 + Math.cos(tiltR));
    const term2 = (F1 * A) / B;
    const term3 = F2 * Math.sin(tiltR);
    skyDiffuse = Math.max(dhi * (term1 + term2 + term3), 0);
    if (!Number.isFinite(skyDiffuse)) skyDiffuse = 0;
  }

  const ground = ghi * albedo * (1 - Math.cos(tiltR)) * 0.5;
  const poaDirect = Math.max(dni * Math.cos(rad(aoi)), 0);
  const poaDiffuse = skyDiffuse + ground;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { poaGlobal: r2(poaDirect + poaDiffuse), poaDirect: r2(poaDirect), poaDiffuse: r2(poaDiffuse) };
}
