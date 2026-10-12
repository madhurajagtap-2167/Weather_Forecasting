import cron from 'node-cron';
import {
  SITES, PILOT_SITES, CAPTURE_TIMES,
} from '../config.js';
import { fetchSolarForecast, fetchSolarForecast15min } from './openmeteo.js';
import {
  logForecast, saveForecastSnapshot, saveForecastSnapshotHourly, nextFullHour,
} from './forecastLog.js';
import { buildReportsForAllPilotSites } from './reportBuilder.js';

const TZ = 'Asia/Kolkata';

export async function captureSnapshotJob(captureTime) {
  console.log(`\n===== SNAPSHOT CAPTURE (${captureTime}) at ${new Date().toISOString()} =====`);
  for (const siteKey of PILOT_SITES) {
    const site = SITES[siteKey];
    try {
      const points = await fetchSolarForecast15min(site.lat, site.lon, { tilt: site.tilt, azimuth: site.azimuth });
      saveForecastSnapshot(siteKey, points, captureTime);
    } catch (e) {
      console.error(`FAILED snapshot for ${siteKey} @ ${captureTime}: ${e.message}`);
    }
    try {
      const raw = await fetchSolarForecast(site.lat, site.lon, { tilt: site.tilt, azimuth: site.azimuth, hours: 48 });
      saveForecastSnapshotHourly(siteKey, raw, captureTime, nextFullHour(Date.now()));
    } catch (e) {
      console.error(`FAILED hourly snapshot for ${siteKey} @ ${captureTime}: ${e.message}`);
    }
  }
  console.log(`===== SNAPSHOT CAPTURE COMPLETE (${captureTime}) =====\n`);
}

export async function scheduledJob() {
  console.log(`\n===== SCHEDULER TICK at ${new Date().toISOString()} =====`);
  for (const [name, site] of Object.entries(SITES)) {
    try {
      const points = await fetchSolarForecast(site.lat, site.lon, { tilt: site.tilt, azimuth: site.azimuth });
      await logForecast(name, points);
    } catch (e) {
      console.error(`Failed to fetch/log ${name}: ${e.message}`);
    }
  }
  console.log('===== TICK COMPLETE =====\n');
}

export async function dailyReportJob() {
  console.log('\n===== DAILY REPORT BUILD =====');
  buildReportsForAllPilotSites();
  console.log('===== DAILY REPORT BUILD COMPLETE =====\n');
}

/** Same schedule as the old APScheduler setup (all times Asia/Kolkata). */
export function startScheduler() {
  const opts = { timezone: TZ };
  const safe = (fn) => () => fn().catch((e) => console.error(`[scheduler] job error: ${e.message}`));

  cron.schedule('0,15,30,45 * * * *', safe(scheduledJob), opts);

  for (const t of CAPTURE_TIMES) {
    const [h, m] = t.split(':').map(Number);
    cron.schedule(`${m} ${h} * * *`, safe(() => captureSnapshotJob(t)), opts);
  }

  const [lastH, lastM] = CAPTURE_TIMES[CAPTURE_TIMES.length - 1].split(':').map(Number);
  const reportMinute = (lastM + 30) % 60;
  const reportHour = lastH + (lastM + 30 >= 60 ? 1 : 0);
  cron.schedule(`${reportMinute} ${reportHour} * * *`, safe(dailyReportJob), opts);

  console.log(
    `Scheduler started: 15-min logging (all sites) + ${CAPTURE_TIMES.length} daily snapshot captures `
    + `for ${PILOT_SITES.join(', ')} + daily report at `
    + `${String(reportHour).padStart(2, '0')}:${String(reportMinute).padStart(2, '0')} (${TZ}).`,
  );
}
