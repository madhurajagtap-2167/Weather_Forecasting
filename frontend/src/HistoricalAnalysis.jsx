import { useState, useEffect, useCallback } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend,
} from 'chart.js';
import { fetchSites, fetchHistorical, fetchWeather } from './api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const LINE_STYLE = { borderWidth: 2, pointRadius: 1, pointHoverRadius: 4, tension: 0.3 };

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    tooltip: {
      mode: 'index', intersect: false,
      backgroundColor: '#0f172a', titleColor: '#34D399', bodyColor: '#e2e8f0',
      borderColor: 'rgba(52, 211, 153, 0.35)', borderWidth: 1, padding: 10, boxPadding: 4,
    },
    legend: {
      position: 'top',
      labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, color: '#334155', font: { size: 11 } },
    },
  },
  layout: { padding: { top: 8, right: 8, bottom: 4, left: 4 } },
  scales: {
    x: { ticks: { autoSkip: true, maxTicksLimit: 24, maxRotation: 60, minRotation: 45, color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(148, 163, 184, 0.15)' } },
    y: { beginAtZero: true, grace: '10%', ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(148, 163, 184, 0.15)' } },
  },
};

function pad(n) { return String(n).padStart(2, '0'); }

function formatSiteName(name) {
  if (!name) return '';
  return name.charAt(0) + name.slice(1).toLowerCase();
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Backend forecast points carry an ISO timestamp in 'time' (e.g.
// '2026-09-12T08:30:00+05:30', already in IST) — NOT a 'label' field.
// Both the live forecast and the historical CSVs represent naive local
// IST timestamps, so trimming to the first 19 chars ('YYYY-MM-DDTHH:MM:SS')
// lines them up exactly without any timezone conversion on this side.
function isoFromLiveTime(timeStr) {
  return typeof timeStr === 'string' ? timeStr.slice(0, 19) : null;
}

function shortLabel(iso) {
  // 'YYYY-MM-DDTHH:MM:00' -> 'MM-DD HH:MM'
  const [datePart, timePart] = iso.split('T');
  const [, mo, da] = datePart.split('-');
  return `${mo}-${da} ${timePart.slice(0, 5)}`;
}

export default function HistoricalAnalysis() {
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState(null);
  const [resolution, setResolution] = useState('hourly');
  const [startDate, setStartDate] = useState(daysAgoStr(14));
  const [endDate, setEndDate] = useState(todayStr());

  const [historical, setHistorical] = useState(null);
  const [liveForecast, setLiveForecast] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchSites()
      .then(list => {
        setSites(list);
        if (list.length) setSite(list[0].name);
      })
      .catch(e => setError(e.message));
  }, []);

  const loadData = useCallback(async () => {
    if (!site) return;
    setLoading(true);
    setError(null);
    try {
      const hist = await fetchHistorical(site, { resolution, start: startDate, end: endDate });
      setHistorical(hist);

      // Only bother fetching the live forecast if today is inside the
      // selected range — otherwise there's nothing to overlay.
      if (startDate <= todayStr() && endDate >= todayStr()) {
        const live = await fetchWeather(site);
        setLiveForecast(live.forecast || []);
      } else {
        setLiveForecast([]);
      }
    } catch (e) {
      setError(e.message);
      setHistorical(null);
    } finally {
      setLoading(false);
    }
  }, [site, resolution, startDate, endDate]);

  useEffect(() => { loadData(); }, [loadData]);

  const rows = historical?.rows || [];
  const rangeDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24);
  const isWideRange = (resolution === '15min' && rangeDays > 60) || (resolution === 'hourly' && rangeDays > 180);

  // Merge historical rows + live-forecast slots onto one shared, sorted
  // timestamp axis. A timestamp only present in one side simply gets a
  // null for the other's dataset — Chart.js draws that as a gap, it never
  // invents a connecting value.
  const histByTs = {};
  rows.forEach(r => { histByTs[r.timestamp] = r; });

  const liveByTs = {};
  liveForecast.forEach(pt => {
    const ts = isoFromLiveTime(pt.time);
    if (ts) liveByTs[ts] = pt;
  });

  const allTs = Array.from(new Set([...Object.keys(histByTs), ...Object.keys(liveByTs)])).sort();
  const labels = allTs.map(shortLabel);

  const irradianceChart = {
    labels,
    datasets: [
      { label: 'Historical GTI (Open-Meteo Archive)', data: allTs.map(t => histByTs[t]?.global_tilted_irradiance ?? null), borderColor: '#F5A623', backgroundColor: '#F5A623', ...LINE_STYLE },
      { label: 'Live Forecast POA (Today)', data: allTs.map(t => liveByTs[t]?.poaGlobal ?? null), borderColor: '#34D399', backgroundColor: '#34D399', borderDash: [5, 5], ...LINE_STYLE },
    ],
  };

  const temperatureChart = {
    labels,
    datasets: [
      { label: 'Historical Air Temp (2m)', data: allTs.map(t => histByTs[t]?.temperature_2m ?? null), borderColor: '#EC4899', backgroundColor: '#EC4899', ...LINE_STYLE },
      { label: 'Historical Surface Temp', data: allTs.map(t => histByTs[t]?.surface_temperature ?? null), borderColor: '#F87171', backgroundColor: '#F87171', ...LINE_STYLE },
      { label: 'Live Forecast Temp (Today)', data: allTs.map(t => liveByTs[t]?.temperature ?? null), borderColor: '#34D399', backgroundColor: '#34D399', borderDash: [5, 5], ...LINE_STYLE },
    ],
  };

  const precipChart = {
    labels,
    datasets: [
      { label: 'Historical Precipitation (mm)', data: allTs.map(t => histByTs[t]?.precipitation ?? null), borderColor: '#38BDF8', backgroundColor: '#38BDF8', ...LINE_STYLE },
    ],
  };

  const cloudChart = {
    labels,
    datasets: [
      { label: 'Historical Cloud Cover — Low (%)', data: allTs.map(t => histByTs[t]?.cloud_cover_low ?? null), borderColor: '#A78BFA', backgroundColor: '#A78BFA', ...LINE_STYLE },
    ],
  };

  const panels = [
    { title: 'Irradiance — GTI vs Live POA', data: irradianceChart },
    { title: 'Temperature — Air, Surface & Live Forecast', data: temperatureChart },
    { title: 'Precipitation (mm)', data: precipChart },
    { title: 'Cloud Cover — Low (%)', data: cloudChart },
  ];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-6">

      {/* Controls */}
      <div className="card-glow shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 p-5 flex flex-wrap items-end gap-4 hover:border-slate-700 transition-colors duration-300">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Site</label>
          <select
            className="bg-slate-800/70 border border-slate-700 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
            value={site || ''}
            onChange={(e) => setSite(e.target.value)}
          >
            {sites.map(s => <option key={s.name} value={s.name}>{formatSiteName(s.name)}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">Resolution</label>
          <select
            className="bg-slate-800/70 border border-slate-700 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          >
            <option value="hourly">Hourly</option>
            <option value="15min">15-min</option>
          </select>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">Start date</label>
          <input
            type="date"
            className="bg-slate-800/70 border border-slate-700 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">End date</label>
          <input
            type="date"
            className="bg-slate-800/70 border border-slate-700 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>

        <button
          onClick={loadData}
          className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-semibold rounded-xl px-5 py-2.5 transition-all duration-200 shadow-md shadow-emerald-900/30 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-emerald-900/40 active:translate-y-0"
        >
          {loading ? 'Loading…' : 'Load'}
        </button>

        <div className="text-xs text-slate-500 ml-auto">
          {historical?.file && <span>Source: {historical.file}</span>}
        </div>
      </div>

      {isWideRange && (
        <p className="shrink-0 text-xs text-amber-400 -mt-2">
          That's a wide date range at this resolution — the charts may render slowly. Consider narrowing it.
        </p>
      )}
      {error && <p className="shrink-0 text-red-400 text-sm">{error}</p>}
      {historical?.error && <p className="shrink-0 text-amber-400 text-sm">{historical.error}</p>}

      {/* Charts */}
      {rows.length === 0 && !loading ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 p-10 text-center text-slate-500">
          No historical data for this site/range yet. Run <code className="text-slate-400">historical_fetch.py</code> first, or widen the date range.
        </div>
      ) : (
        panels.map(panel => (
          <div key={panel.title} className="card-glow shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 overflow-hidden hover:border-slate-700 transition-colors duration-300">
            <div className="px-5 py-3.5 border-b border-slate-800">
              <h2 className="font-display text-base font-semibold text-white">{panel.title} — {formatSiteName(site)}</h2>
            </div>
            <div className="bg-white p-4">
              <div className="relative w-full" style={{ height: '380px' }}>
                <Line data={panel.data} options={chartOptions} />
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}