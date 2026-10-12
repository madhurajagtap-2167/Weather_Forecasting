import { useState, useEffect } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend,
} from 'chart.js';
import { fetchSites, fetchModelBacktest } from './api';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

const MODEL_DISPLAY_NAMES = {
  ecmwf: 'ECMWF (IFS)',
  gfs: 'GFS (NOAA)',
  icon: 'ICON (DWD)',
  gem: 'GEM (ECCC)',
  meteofrance: 'Météo-France (ARPEGE/AROME)',
  jma: 'JMA',
  best_match: 'Open-Meteo',
};

function formatSiteName(name) {
  if (!name) return '';
  return name.charAt(0) + name.slice(1).toLowerCase();
}

function tierColor(pct) {
  if (pct == null) return 'text-slate-500';
  if (pct >= 80) return 'text-emerald-400';
  if (pct >= 60) return 'text-amber-400';
  return 'text-rose-400';
}

function tierBar(pct) {
  if (pct == null) return 'bg-slate-700';
  if (pct >= 80) return 'bg-emerald-500';
  if (pct >= 60) return 'bg-amber-500';
  return 'bg-rose-500';
}

function MiniBar({ pct }) {
  const width = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${tierBar(pct)} transition-all duration-500`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className={`text-xs font-semibold tabular-nums ${tierColor(pct)}`}>
        {pct != null ? `${pct}%` : '—'}
      </span>
    </div>
  );
}

const barOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { position: 'top', labels: { color: '#475569', font: { size: 11, weight: '600' }, usePointStyle: true, pointStyle: 'circle', padding: 16 } },
    tooltip: {
      backgroundColor: '#0f172a',
      titleColor: '#34D399',
      bodyColor: '#e2e8f0',
      padding: 10,
      cornerRadius: 8,
      titleFont: { weight: '700' },
    },
  },
  scales: {
    x: { ticks: { color: '#64748b', font: { size: 10, weight: '600' } }, grid: { display: false } },
    y: { beginAtZero: true, max: 100, ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(148, 163, 184, 0.12)' } },
  },
};

export default function ModelComparison() {
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState(null);
  const [startDate, setStartDate] = useState('2026-07-01');
  const [endDate, setEndDate] = useState('2026-08-31');
  const [report, setReport] = useState(null);
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

  const runBacktest = async (forceRefresh = false) => {
    if (!site) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchModelBacktest(site, { start: startDate, end: endDate, refresh: forceRefresh });
      setReport(r);
    } catch (e) {
      setError(e.message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const modelRows = report
    ? Object.entries(report.models)
        .filter(([, v]) => !v.error)
        .map(([key, v]) => ({
          key,
          name: MODEL_DISPLAY_NAMES[key] || key,
          irradianceAcc: v.irradiance?.accuracy_pct ?? null,
          tempAcc: v.temperature?.accuracy_pct ?? null,
          combined: v.combined_accuracy_pct ?? null,
        }))
        .sort((a, b) => (b.combined ?? -1) - (a.combined ?? -1))
    : [];

  const failedModels = report
    ? Object.entries(report.models).filter(([, v]) => v.error)
    : [];

  const barData = {
    labels: modelRows.map(m => m.name),
    datasets: [
      { label: 'Irradiance Accuracy %', data: modelRows.map(m => m.irradianceAcc), backgroundColor: '#F5A623', borderRadius: 4 },
      { label: 'Temperature Accuracy %', data: modelRows.map(m => m.tempAcc), backgroundColor: '#38BDF8', borderRadius: 4 },
      { label: 'Combined Score %', data: modelRows.map(m => m.combined), backgroundColor: '#34D399', borderRadius: 4 },
    ],
  };

  const bestSingle = report?.best_single_model;
  const bestSingleAcc = bestSingle ? report.models[bestSingle]?.combined_accuracy_pct : null;
  const ensembleAcc = report?.ensemble?.irradiance?.accuracy_pct ?? null;
  const recommendation = report?.recommendation;
  const reportNote = report?.note;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-6">

      <div className="card-glow shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 p-5 flex flex-wrap items-end gap-4 hover:border-slate-700 transition-colors duration-300">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Site</label>
          <select
            className="bg-slate-800/70 border border-slate-700 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
            value={site || ''}
            onChange={(e) => { setSite(e.target.value); setReport(null); }}
          >
            {sites.map(s => <option key={s.name} value={s.name}>{formatSiteName(s.name)}</option>)}
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
          onClick={() => runBacktest(false)}
          disabled={loading}
          className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-semibold rounded-xl px-5 py-2.5 transition-all duration-200 shadow-md shadow-emerald-900/30 hover:-translate-y-0.5"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-slate-900/40 border-t-slate-900 rounded-full animate-spin" />
              Running…
            </span>
          ) : 'Run Comparison'}
        </button>
        <button
          onClick={() => runBacktest(true)}
          disabled={loading}
          title="Ignore cached report and re-fetch every model"
          className="px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 rounded-xl py-2.5 text-sm transition-all duration-200 disabled:opacity-60"
        >
          Refresh
        </button>

        <p className="text-xs text-slate-500 basis-full">
          Scores each NWP model's PAST forecasts for this site against the real archived weather for the same dates —
          needs <code className="text-slate-400">historical_fetch.py</code> to have already been run for this site/range.
        </p>
      </div>

      {error && (
        <div className="shrink-0 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-rose-300 text-sm">
          {error}
        </div>
      )}
      {failedModels.length > 0 && (
        <p className="shrink-0 text-amber-400 text-xs">
          {failedModels.length} model(s) failed to fetch: {failedModels.map(([k]) => MODEL_DISPLAY_NAMES[k] || k).join(', ')}
        </p>
      )}

      {reportNote && (
        <p className="shrink-0 text-xs text-slate-500 italic border-l-2 border-slate-700 pl-3">{reportNote}</p>
      )}

      {report && modelRows.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 shrink-0">
            <div className="card-glow relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/15 via-slate-900/60 to-slate-900/60 p-5">
              <div className="absolute -right-6 -top-6 w-28 h-28 rounded-full bg-emerald-500/10 blur-2xl" />
              <p className="relative text-emerald-300 text-sm font-semibold mb-1 tracking-wide uppercase">🏆 Best single model</p>
              <p className="relative text-2xl font-bold text-white">{MODEL_DISPLAY_NAMES[bestSingle] || bestSingle || '—'}</p>
              <p className="relative text-slate-300 text-sm mt-1">{bestSingleAcc != null ? `${bestSingleAcc}% combined accuracy` : ''}</p>
            </div>
            <div className="card-glow relative overflow-hidden rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/15 via-slate-900/60 to-slate-900/60 p-5">
              <div className="absolute -right-6 -top-6 w-28 h-28 rounded-full bg-cyan-500/10 blur-2xl" />
              <p className="relative text-cyan-300 text-sm font-semibold mb-1 tracking-wide uppercase">
                🧬 Ensemble ({report.ensemble?.models_used?.map(k => MODEL_DISPLAY_NAMES[k] || k).join(' + ') || 'not enough models'})
              </p>
              <p className="relative text-2xl font-bold text-white">{ensembleAcc != null ? `${ensembleAcc}% irradiance accuracy` : '—'}</p>
              <p className="relative text-slate-300 text-sm mt-1">
                {recommendation === 'ensemble'
                  ? 'Recommendation: use this ensemble average for power forecasting at this site.'
                  : 'Recommendation: the best single model above already beats the ensemble here.'}
              </p>
            </div>
          </div>

          <div className="card-glow shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 overflow-hidden hover:border-slate-700 transition-colors duration-300">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
              <h2 className="font-display text-base font-semibold text-white">
                Model Accuracy — {formatSiteName(site)} ({report.start} → {report.end})
              </h2>
              <span className="text-xs text-slate-500">{modelRows.length} models compared</span>
            </div>
            <div className="bg-white p-4">
              <div className="relative w-full" style={{ height: '380px' }}>
                <Bar data={barData} options={barOptions} />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-t border-slate-800 bg-slate-900/80">
                    <th className="px-5 py-3 font-medium">Model</th>
                    <th className="px-5 py-3 font-medium">Irradiance Acc.</th>
                    <th className="px-5 py-3 font-medium">Temperature Acc.</th>
                    <th className="px-5 py-3 font-medium">Combined</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.map((m, i) => (
                    <tr
                      key={m.key}
                      className={`border-t border-slate-800/80 transition-colors duration-150 hover:bg-slate-800/40 ${m.key === bestSingle ? 'bg-emerald-500/5' : ''}`}
                    >
                      <td className="px-5 py-3 text-slate-200">
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-slate-600 tabular-nums w-4">{i + 1}</span>
                          <span className="font-medium">{m.name}</span>
                          {m.key === bestSingle && (
                            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-emerald-400 text-[11px] font-semibold">
                              ★ best
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-5 py-3"><MiniBar pct={m.irradianceAcc} /></td>
                      <td className="px-5 py-3"><MiniBar pct={m.tempAcc} /></td>
                      <td className={`px-5 py-3 font-bold tabular-nums ${tierColor(m.combined)}`}>
                        {m.combined != null ? `${m.combined}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {report && modelRows.length === 0 && !loading && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 p-10 text-center text-slate-500">
          No model results — every call may have failed, or there's no actual historical data for this site/range yet.
        </div>
      )}
    </div>
  );
}