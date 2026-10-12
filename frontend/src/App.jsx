import { useState, useEffect, useCallback, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend,
} from 'chart.js';
import { fetchWeather } from './api';
import HistoricalAnalysis from './HistoricalAnalysis';
import ModelComparison from './ModelComparison';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const SITES = ["KOTHAGUDEM", "SIRMOUR"];

const START_HOUR = 5;   // 5 AM
const END_HOUR = 21;    // 9 PM
const INTERVAL_MIN = 15;
const AUTO_REFRESH_MS = 15 * 60 * 1000; // auto re-fetch every 15 min, matches backend scheduler

// ---- Branding ----
const PLATFORM_NAME = 'Open-Meteo Weather';

// ---- Every parameter the dashboard has real data for, driving the sidebar
// checkboxes, the "All Parameters" dropdown, and the Forecast Graph lines.
// Colors match the Forecast Graph dataset colors exactly, so the dropdown's
// dots and the chart lines always agree. Wind Direction / Wind Gust are
// intentionally left OUT of this list — the live per-timeline forecast
// genuinely has no data for them (they only ever show up separately, in the
// one-off Grid Weather panel), so they stay as disabled sidebar rows below.
const PARAMS = [
  { key: 'ghi', label: 'GHI', chartLabel: 'GHI (W/m²)', color: '#F5A623', group: 'solar' },
  { key: 'dni', label: 'DNI', chartLabel: 'DNI (W/m²)', color: '#FBBF24', group: 'solar' },
  { key: 'dhi', label: 'DHI', chartLabel: 'DHI (W/m²)', color: '#F97316', group: 'solar' },
  { key: 'temperature', label: 'Temperature', chartLabel: 'Temperature (°C)', color: '#EC4899', group: 'solar' },
  { key: 'humidity', label: 'Humidity', chartLabel: 'Humidity (%)', color: '#A78BFA', group: 'solar' },
  { key: 'poaGlobal', label: 'POA', chartLabel: 'POA (W/m²)', color: '#34D399', group: 'solar' },
  { key: 'windSpeed', label: 'Wind Speed', chartLabel: 'Wind Speed (m/s)', color: '#22D3EE', group: 'wind' },
];
const SOLAR_PARAMS = PARAMS.filter(p => p.group === 'solar');
const WIND_PARAMS = PARAMS.filter(p => p.group === 'wind');
const DEFAULT_ENABLED_PARAMS = PARAMS.reduce((acc, p) => { acc[p.key] = true; return acc; }, {});

// Shared Chart.js line styling (item 5 polish) applied to every dataset.
const LINE_STYLE = { borderWidth: 2, pointRadius: 2, pointHoverRadius: 4, tension: 0.35 };

function pad(n) { return String(n).padStart(2, '0'); }

function formatSiteName(name) {
  if (!name) return '';
  return name.charAt(0) + name.slice(1).toLowerCase();
}

// SheetJS (cellDates: true) converts Excel's fractional-day time values using
// floating-point math, which often lands a fraction of a second short — e.g.
// 07:15:00 becomes 07:14:59.987. getHours()/getMinutes() TRUNCATE rather than
// round, so every timestamp from an xlsx upload would display ~1 minute early.
// Rounding to the nearest minute before formatting fixes this.
function roundToMinute(date) {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  if (date.getSeconds() >= 30) rounded.setMinutes(rounded.getMinutes() + 1);
  return rounded;
}

// Builds the FIXED full list of time slots: 05:00, 05:15, ... 21:00 (inclusive)
function buildFullTimeline() {
  const slots = [];
  const totalSlots = ((END_HOUR - START_HOUR) * 60) / INTERVAL_MIN + 1;
  for (let i = 0; i < totalSlots; i++) {
    const totalMinutes = START_HOUR * 60 + i * INTERVAL_MIN;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    slots.push({ label: `${pad(hour)}:${pad(minute)}`, date });
  }
  return slots;
}

// Exact current time, used as the zero/live cutoff on Chart 1. Deliberately
// NOT rounded down to the last quarter-hour — rounding down would mark an
// already-past 15-min slot as "live" (e.g. at 12:50 it would show 12:45's
// slot as current, 5 minutes stale). Using the precise time means the
// cutoff sits exactly at "now": slots before it are 0, slots at/after it
// show real (interpolated) data.
function getRoundedNow() {
  return new Date();
}

// Chart.js options shared by both charts: dark tooltip with a colored
// title, point-style legend, faint gridlines, and a fixed-height canvas
// (responsive + maintainAspectRatio: false) so the box we size in the
// layout is exactly what renders — no independent aspect ratio fighting it.
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    tooltip: {
      mode: 'index',
      intersect: false,
      backgroundColor: '#0f172a',
      titleColor: '#34D399',
      bodyColor: '#e2e8f0',
      borderColor: 'rgba(52, 211, 153, 0.35)',
      borderWidth: 1,
      padding: 10,
      boxPadding: 4,
    },
    legend: {
      position: 'top',
      labels: {
        usePointStyle: true,
        pointStyle: 'circle',
        boxWidth: 8,
        boxHeight: 8,
        color: '#334155',
        font: { size: 11 },
      },
    },
  },
  layout: {
    // Extra breathing room on all sides so a line that peaks/dips near the
    // data range's min or max never touches (or looks clipped against) the
    // canvas edge.
    padding: { top: 8, right: 8, bottom: 4, left: 4 },
  },
  scales: {
    x: {
      ticks: { autoSkip: false, maxRotation: 60, minRotation: 45, color: '#64748b', font: { size: 10 } },
      grid: { color: 'rgba(148, 163, 184, 0.15)' },
    },
    y: {
      // Force the axis to always start at 0 and pad the top by 10%, so the
      // full curve (including low dawn/dusk values near zero) is always
      // inside the drawn area — never dependent on Chart.js's auto-fit
      // guessing the right min from the data.
      beginAtZero: true,
      grace: '10%',
      ticks: { color: '#64748b', font: { size: 10 } },
      grid: { color: 'rgba(148, 163, 184, 0.15)' },
    },
  },
};

// ---- Small inline SVG icons (no icon library — nothing extra to install) ----

function LogoIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 40 40" className={className} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="logoGrad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34D399" />
          <stop offset="1" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill="url(#logoGrad)" opacity="0.16" />
      <path
        d="M13.5 25.5a5 5 0 0 1 .7-9.95 7 7 0 0 1 13.2-2.15A5.5 5.5 0 0 1 26.5 24H14.2a2.9 2.9 0 0 1-.7 1.5z"
        fill="url(#logoGrad)"
      />
      <path d="M17 28.5l-1.2 2.6M20.5 28.5l-1.2 2.6M24 28.5l-1.2 2.6" stroke="url(#logoGrad)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ open, className = '' }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} transition-transform duration-200 ease-in-out ${open ? 'rotate-180' : ''}`} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 7.5l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3L5.6 5.6" />
      </g>
    </svg>
  );
}

function WindIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 8h11a2.5 2.5 0 1 0-2.3-3.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13h15a2.5 2.5 0 1 1-2.3 3.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 18h8a2 2 0 1 0-1.8-2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChartIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 19V5M4 19h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 15l3.5-4 3 3L19 7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CompareIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 6h16M4 12h10M4 18h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="17" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

function CollapseIcon({ open, className = '' }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} transition-transform duration-300 ease-in-out ${open ? '' : 'rotate-180'}`} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.5 4.5L7 10l5.5 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ThermoIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 14.5V5a2 2 0 1 0-4 0v9.5a4 4 0 1 0 4 0z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="17" r="1.4" fill="currentColor" />
    </svg>
  );
}

function DropletIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3s6 6.8 6 11.2A6 6 0 0 1 6 14.2C6 9.8 12 3 12 3z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BoltIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 3L4 14h6l-1 7 9-11h-6l1-7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function LiveDotIcon({ className = '' }) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-full w-full rounded-full bg-emerald-400" />
    </span>
  );
}

function RefreshIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 4v4h-4M4 16v-4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 8a5.5 5.5 0 0 0-9.6-2.3M5 12a5.5 5.5 0 0 0 9.6 2.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Live ticking clock, decoupled from the rest of App so it re-renders
// itself once a second without forcing the whole dashboard (charts included)
// to re-render every tick. Gives the header that "real-time system" feel. ----
function LiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const date = now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  return (
    <div className="hidden md:flex flex-col items-end leading-tight shrink-0">
      <span className="font-mono text-sm font-semibold text-emerald-300 tabular-nums">{time} <span className="text-slate-500 text-[10px] font-sans">IST</span></span>
      <span className="text-[11px] text-slate-500">{date}</span>
    </div>
  );
}

// ---- Small live snapshot stat used in the hero strip under the header ----
function SnapshotCard({ label, value, unit, color, icon }) {
  return (
    <div className="card-glow relative flex-1 min-w-[9.5rem] rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur px-4 py-3 shadow-lg shadow-black/20 hover:-translate-y-0.5 hover:border-slate-700 transition-all duration-200">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">{label}</span>
        <span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `${color}22`, color }}>
          {icon}
        </span>
      </div>
      <p className="font-display text-2xl font-bold text-white tabular-nums">
        {value == null ? '—' : value}
        {value != null && <span className="text-sm font-medium text-slate-400 ml-1">{unit}</span>}
      </p>
    </div>
  );
}

// ---- Status pill (item 4) ----
const STATUS_STYLES = {
  'Idle': { dot: 'bg-slate-400', bg: 'bg-slate-800/70', text: 'text-slate-300', border: 'border-slate-700', pulse: false },
  'Fetching...': { dot: 'bg-amber-400', bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/30', pulse: true },
  'Refreshing...': { dot: 'bg-amber-400', bg: 'bg-amber-500/10', text: 'text-amber-300', border: 'border-amber-500/30', pulse: true },
  'Fetch succeeded': { dot: 'bg-emerald-400', bg: 'bg-emerald-500/10', text: 'text-emerald-300', border: 'border-emerald-500/30', pulse: false },
  'Fetch failed': { dot: 'bg-red-400', bg: 'bg-red-500/10', text: 'text-red-300', border: 'border-red-500/30', pulse: false },
};

function StatusPill({ status }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES['Idle'];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border ${style.border} ${style.bg} px-3 py-1.5 text-xs font-medium ${style.text} transition-colors duration-300`}>
      <span className="relative flex h-2 w-2">
        {style.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${style.dot} opacity-75`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
      </span>
      {status}
    </span>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard'); // 'dashboard' | 'analysis'
  const [site, setSite] = useState(SITES[0]);
  const [forecast, setForecast] = useState([]);
  const [gridWeather, setGridWeather] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState(null);
  const [csvRows, setCsvRows] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [solarOpen, setSolarOpen] = useState(true);
  const [windOpen, setWindOpen] = useState(true);
  // Which parameter the "Forecast vs Actual" chart shows.
  // 'all' = every parameter combined on one graph (default, as soon as a file is loaded).
  // 'temp' | 'poa' | 'ghi' = only that parameter's Forecast + Actual pair.
  const [chart2Metric, setChart2Metric] = useState('all');

  // Sidebar checkboxes wired to real state (item 3) — controls which lines
  // render on the Forecast Graph. Every parameter the backend genuinely
  // provides starts checked; Wind Direction / Wind Gust stay disabled below
  // because the live per-timeline forecast has no data for them.
  const [enabledParams, setEnabledParams] = useState(DEFAULT_ENABLED_PARAMS);
  const toggleParam = (key) => setEnabledParams(prev => ({ ...prev, [key]: !prev[key] }));

  // "All Parameters" header dropdown (item 2) — 'all' shows every
  // sidebar-checked parameter; picking one isolates just that line.
  const [activeParam, setActiveParam] = useState('all');
  const [paramMenuOpen, setParamMenuOpen] = useState(false);
  const paramMenuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (paramMenuRef.current && !paramMenuRef.current.contains(e.target)) {
        setParamMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Ticks once a minute purely to force a re-render so `windowStart` (the
  // 0-before-now / real-value-from-now cutoff on Chart 1) tracks the actual
  // clock. Without this, React only re-renders when a fetch completes
  // (immediately, then every 15 min), so the cutoff would stay frozen at
  // whatever time the last fetch happened instead of moving forward with
  // real time in between.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const clockId = setInterval(() => setClockTick(t => t + 1), 60 * 1000);
    return () => clearInterval(clockId);
  }, []);

  const handleFetch = useCallback(async (forceRefresh = false) => {
    setStatus(forceRefresh ? 'Refreshing...' : 'Fetching...');
    setError(null);
    try {
      const data = await fetchWeather(site, { forceRefresh });
      setForecast(data.forecast || []);
      setGridWeather(data.gridWeather || null);
      setBlocked(data.blocked || null);
      setStatus('Fetch succeeded');
    } catch (e) {
      setError(e.message);
      setStatus('Fetch failed');
    }
  }, [site]);

  // Auto-fetch: runs once immediately whenever the selected site changes
  // (using cache if it's fresh), then forces a live refresh every 15 min
  // to match the backend scheduler — no manual click needed. Every call
  // still goes through fetchWeather(), which writes to localStorage.
  useEffect(() => {
    handleFetch(false);
    const intervalId = setInterval(() => {
      handleFetch(true);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(intervalId);
  }, [handleFetch]);

  // Parses the fixed "Site vs Weather" template:
  // Timestamp | Ambient Temperature (C) | POA(W/m2) | GHI_W (W/m2) | Temparature | POA_Global | GHI | POA_Diffuse | POA_Direct
  // Left 3 columns (Ambient Temp / POA / GHI_W) = actual site-sensor readings — POA is a
  // SINGLE real value from the site. The forecast side gives Temp + GHI plus POA broken
  // into three components (Global, Diffuse, Direct) for that same timestamp. Both sides
  // come from this single file — no merging with the live QWeather state.
  const extractRows = (rawRows) => {
    if (!rawRows || !rawRows.length) return null;
    const keys = Object.keys(rawRows[0]);

    const findExact = (name) => keys.find(k => k.trim().toLowerCase() === name);
    const findIncl = (subs, excl = []) => keys.find(k => {
      const low = k.toLowerCase();
      return subs.every(s => low.includes(s)) && excl.every(s => !low.includes(s));
    });

    const timeKey = findExact('timestamp') || findIncl(['time']);
    const siteTempKey = findIncl(['ambient', 'temp']);
    // Site POA is the one plain "POA(W/m2)" column — exclude the forecast's
    // Global/Diffuse/Direct POA columns so this only matches the site sensor.
    const sitePoaKey = findIncl(['poa'], ['global', 'diffuse', 'direct']);
    const siteGhiKey = findIncl(['ghi', 'w']);       // "GHI_W (W/m2)"
    const fcTempKey = findExact('temparature') || findIncl(['temp'], ['ambient']);
    const fcGhiKey = findExact('ghi');                // plain "GHI"
    const fcPoaGlobalKey = findIncl(['poa', 'global']);   // "POA_Global"
    const fcPoaDiffuseKey = findIncl(['poa', 'diffuse']); // "POA_Diffuse"
    const fcPoaDirectKey = findIncl(['poa', 'direct']);   // "POA_Direct"

    if (!timeKey || (!siteGhiKey && !sitePoaKey)) return null;

    return rawRows
      .map(r => {
        const rawTime = r[timeKey];
        const parsedDate = rawTime instanceof Date ? rawTime : new Date(rawTime);
        if (isNaN(parsedDate.getTime())) return null;
        const dateObj = roundToMinute(parsedDate);
        return {
          time: dateObj,
          label: `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`,
          ghiActual: siteGhiKey ? r[siteGhiKey] : null,
          poaActual: sitePoaKey ? r[sitePoaKey] : null,
          tempActual: siteTempKey ? r[siteTempKey] : null,
          ghiForecast: fcGhiKey ? r[fcGhiKey] : null,
          tempForecast: fcTempKey ? r[fcTempKey] : null,
          poaForecastGlobal: fcPoaGlobalKey ? r[fcPoaGlobalKey] : null,
          poaForecastDiffuse: fcPoaDiffuseKey ? r[fcPoaDiffuseKey] : null,
          poaForecastDirect: fcPoaDirectKey ? r[fcPoaDirectKey] : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileError(null);
    setCsvRows(null);

    const name = file.name.toLowerCase();

    if (name.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: (results) => {
          const rows = extractRows(results.data);
          if (!rows) {
            setFileError(
              `No GHI/POA columns found. Columns detected: ${Object.keys(results.data[0] || {}).join(', ') || 'none'}`
            );
            return;
          }
          setCsvRows(rows);
        },
        error: (err) => setFileError(`CSV parse error: ${err.message}`),
      });
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
          const rows = extractRows(json);
          if (!rows) {
            setFileError(
              `No GHI/POA columns found. Columns detected: ${Object.keys(json[0] || {}).join(', ') || 'none'}`
            );
            return;
          }
          setCsvRows(rows);
        } catch (err) {
          setFileError(`Excel parse error: ${err.message}`);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setFileError('Unsupported file type. Please upload a .csv or .xlsx file.');
    }
  };

  // --- Fixed full timeline: always 5 AM -> 9 PM, 15-min steps ---
  const timeline = buildFullTimeline();
  const windowStart = getRoundedNow();

  // Forecast points sorted by their REAL timestamp (Date object math, not
  // string labels). Matching by "HH:MM" string was fragile against any
  // browser/backend timezone edge case — a slot that didn't line up
  // exactly fell back to 0, which is why every trace was zeroing out
  // between spikes instead of varying smoothly.
  const sortedForecast = forecast
    .map(p => ({ ...p, dateObj: new Date(p.time) }))
    .filter(p => !isNaN(p.dateObj.getTime()))
    .sort((a, b) => a.dateObj - b.dateObj);

  // Linearly interpolates between the two forecast points bracketing time
  // `t`, so every 15-min slot gets a real, smoothly-varying value even if
  // it doesn't land exactly on a returned forecast timestamp.
  function interpolateValue(t, field) {
    if (!sortedForecast.length) return null;
    if (t <= sortedForecast[0].dateObj) return sortedForecast[0][field] ?? null;
    const last = sortedForecast[sortedForecast.length - 1];
    if (t >= last.dateObj) return last[field] ?? null;

    let lo = 0, hi = sortedForecast.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sortedForecast[mid].dateObj <= t) lo = mid; else hi = mid;
    }
    const a = sortedForecast[lo], b = sortedForecast[hi];
    const av = a[field], bv = b[field];
    if (av == null || bv == null) return av ?? bv ?? null;
    const span = b.dateObj - a.dateObj;
    if (span <= 0) return av;
    const frac = (t - a.dateObj) / span;
    return av + (bv - av) * frac;
  }

  // Helper: returns 0 for any time before "now", real interpolated forecast value from "now" onward
  const valueForTime = (t, field) => {
    if (t.date < windowStart) return 0;
    const v = interpolateValue(t.date, field);
    return v != null ? v : 0;
  };

  const chart1Labels = timeline.map(t => t.label);

  // Datasets are built from PARAMS so the sidebar checkboxes AND the header
  // "All Parameters" dropdown both genuinely control what's plotted:
  // a line only renders if its sidebar checkbox is on AND it matches the
  // current dropdown selection ('all' = every checked parameter).
  const chart1Data = {
    labels: chart1Labels,
    datasets: PARAMS
      .filter(p => enabledParams[p.key] && (activeParam === 'all' || activeParam === p.key))
      .map(p => ({
        label: p.chartLabel,
        data: timeline.map(t => valueForTime(t, p.key)),
        borderColor: p.color,
        backgroundColor: p.color,
        ...LINE_STYLE,
      })),
  };

  // Forecast-vs-actual chart — built ENTIRELY from the uploaded file.
  // The file already carries both the weather-platform's forecast columns
  // and the site's actual sensor columns for the same timestamps, so this
  // no longer touches the live QWeather `forecast` state, the fixed
  // 5AM-9PM `timeline`, or `windowStart` above — those only drive Chart 1.
  // Temp and GHI each have one site value vs one forecast value. POA is
  // different: the site only reports ONE POA value, but the forecast
  // splits POA into three components (Global, Diffuse, Direct) — so the
  // site's single POA actual is compared against all three forecast parts.
  let chart2Data = null;
  let accuracy = null;
  if (csvRows && csvRows.length) {
    // Each metric's dataset(s), keyed so the dropdown can pick out just one
    // — or 'all' can concatenate every group together.
    const metricDatasets = {
      ghi: [
        {
          label: 'GHI Forecast (Weather Platform)',
          data: csvRows.map(r => r.ghiForecast ?? 0),
          borderColor: '#F5A623', backgroundColor: '#F5A623', ...LINE_STYLE,
        },
        {
          label: 'GHI Actual (Site)',
          data: csvRows.map(r => r.ghiActual ?? 0),
          borderColor: '#F5A623', borderDash: [5, 5], backgroundColor: '#F5A623', ...LINE_STYLE,
        },
      ],
      temp: [
        {
          label: 'Temperature Forecast (Weather Platform)',
          data: csvRows.map(r => r.tempForecast ?? 0),
          borderColor: '#F87171', backgroundColor: '#F87171', ...LINE_STYLE,
        },
        {
          label: 'Temperature Actual (Site)',
          data: csvRows.map(r => r.tempActual ?? 0),
          borderColor: '#F87171', borderDash: [5, 5], backgroundColor: '#F87171', ...LINE_STYLE,
        },
      ],
      // Combined view: site's single POA actual vs. all three forecast components.
      poa: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#38BDF8', borderDash: [5, 5], backgroundColor: '#38BDF8', ...LINE_STYLE,
        },
        {
          label: 'POA Global Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastGlobal ?? 0),
          borderColor: '#38BDF8', backgroundColor: '#38BDF8', ...LINE_STYLE,
        },
        {
          label: 'POA Diffuse Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDiffuse ?? 0),
          borderColor: '#A78BFA', backgroundColor: '#A78BFA', ...LINE_STYLE,
        },
        {
          label: 'POA Direct Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDirect ?? 0),
          borderColor: '#22D3EE', backgroundColor: '#22D3EE', ...LINE_STYLE,
        },
      ],
      // Individual POA-component views: site actual vs just that one forecast part.
      poaGlobal: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#38BDF8', borderDash: [5, 5], backgroundColor: '#38BDF8', ...LINE_STYLE,
        },
        {
          label: 'POA Global Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastGlobal ?? 0),
          borderColor: '#38BDF8', backgroundColor: '#38BDF8', ...LINE_STYLE,
        },
      ],
      poaDiffuse: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#A78BFA', borderDash: [5, 5], backgroundColor: '#A78BFA', ...LINE_STYLE,
        },
        {
          label: 'POA Diffuse Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDiffuse ?? 0),
          borderColor: '#A78BFA', backgroundColor: '#A78BFA', ...LINE_STYLE,
        },
      ],
      poaDirect: [
        {
          label: 'POA Actual (Site)',
          data: csvRows.map(r => r.poaActual ?? 0),
          borderColor: '#22D3EE', borderDash: [5, 5], backgroundColor: '#22D3EE', ...LINE_STYLE,
        },
        {
          label: 'POA Direct Forecast (Weather Platform)',
          data: csvRows.map(r => r.poaForecastDirect ?? 0),
          borderColor: '#22D3EE', backgroundColor: '#22D3EE', ...LINE_STYLE,
        },
      ],
    };

    const selectedDatasets = chart2Metric === 'all'
      ? [...metricDatasets.ghi, ...metricDatasets.temp, ...metricDatasets.poa]
      : metricDatasets[chart2Metric];

    chart2Data = {
      labels: csvRows.map(r => r.label),
      datasets: selectedDatasets,
    };

    // MAPE (error %) and Accuracy % (100 - MAPE, clamped at 0) computed
    // together for each parameter/component — MAPE shows how far off the
    // forecast runs on average; Accuracy % is the more intuitive "how
    // correct was it" read on the same number.
    const mapeFor = (forecastKey, actualKey) => {
      const errors = [];
      csvRows.forEach(r => {
        if (r[forecastKey] != null && r[actualKey]) {
          errors.push(Math.abs((r[forecastKey] - r[actualKey]) / r[actualKey]));
        }
      });
      if (!errors.length) return null;
      const mape = errors.reduce((a, b) => a + b, 0) / errors.length * 100;
      const accuracyPct = Math.max(0, 100 - mape);
      return { mape: mape.toFixed(1), accuracyPct: accuracyPct.toFixed(1) };
    };

    const showGhi = chart2Metric === 'all' || chart2Metric === 'ghi';
    const showTemp = chart2Metric === 'all' || chart2Metric === 'temp';
    const showPoaGlobal = chart2Metric === 'all' || chart2Metric === 'poa' || chart2Metric === 'poaGlobal';
    const showPoaDiffuse = chart2Metric === 'all' || chart2Metric === 'poa' || chart2Metric === 'poaDiffuse';
    const showPoaDirect = chart2Metric === 'all' || chart2Metric === 'poa' || chart2Metric === 'poaDirect';

    const ghiStats = showGhi ? mapeFor('ghiForecast', 'ghiActual') : null;
    const tempStats = showTemp ? mapeFor('tempForecast', 'tempActual') : null;
    const poaGlobalStats = showPoaGlobal ? mapeFor('poaForecastGlobal', 'poaActual') : null;
    const poaDiffuseStats = showPoaDiffuse ? mapeFor('poaForecastDiffuse', 'poaActual') : null;
    const poaDirectStats = showPoaDirect ? mapeFor('poaForecastDirect', 'poaActual') : null;

    if (ghiStats || tempStats || poaGlobalStats || poaDiffuseStats || poaDirectStats) {
      accuracy = { ghiStats, tempStats, poaGlobalStats, poaDiffuseStats, poaDirectStats };
    }
  }

  // Small stat cards (item 5) built from the accuracy figures above.
  const statCards = [];
  if (accuracy) {
    if (accuracy.tempStats) statCards.push({ label: 'Temperature', value: accuracy.tempStats.accuracyPct, color: '#F87171' });
    if (accuracy.ghiStats) statCards.push({ label: 'GHI', value: accuracy.ghiStats.accuracyPct, color: '#F5A623' });
    if (accuracy.poaGlobalStats) statCards.push({ label: 'POA Global', value: accuracy.poaGlobalStats.accuracyPct, color: '#38BDF8' });
    if (accuracy.poaDiffuseStats) statCards.push({ label: 'POA Diffuse', value: accuracy.poaDiffuseStats.accuracyPct, color: '#A78BFA' });
    if (accuracy.poaDirectStats) statCards.push({ label: 'POA Direct', value: accuracy.poaDirectStats.accuracyPct, color: '#22D3EE' });
  }

  // Sidebar collapse/expand (item 7) — after the width transition finishes,
  // nudge Chart.js with a resize event so the canvas actually fills the
  // newly-widened (or narrowed) space instead of stopping short.
  const handleSidebarToggle = () => {
    setSidebarOpen(o => !o);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
  };

  const activeParamMeta = PARAMS.find(p => p.key === activeParam);
  const showingLabel = activeParam === 'all' ? 'All Parameters' : activeParamMeta?.label;

  // Live "right now" snapshot for the hero strip — same interpolated value
  // Chart 1 would show at the current instant, just read directly instead
  // of walking the fixed 15-min timeline.
  const snapshotFields = [
    { key: 'temperature', label: 'Temperature', unit: '°C', color: '#EC4899', icon: <ThermoIcon className="w-3.5 h-3.5" />, decimals: 1 },
    { key: 'ghi', label: 'GHI', unit: 'W/m²', color: '#F5A623', icon: <SunIcon className="w-3.5 h-3.5" />, decimals: 0 },
    { key: 'poaGlobal', label: 'POA', unit: 'W/m²', color: '#34D399', icon: <BoltIcon className="w-3.5 h-3.5" />, decimals: 0 },
    { key: 'humidity', label: 'Humidity', unit: '%', color: '#A78BFA', icon: <DropletIcon className="w-3.5 h-3.5" />, decimals: 0 },
    { key: 'windSpeed', label: 'Wind Speed', unit: 'm/s', color: '#22D3EE', icon: <WindIcon className="w-3.5 h-3.5" />, decimals: 1 },
  ];
  const snapshotCards = snapshotFields.map(f => {
    const raw = sortedForecast.length ? interpolateValue(windowStart, f.key) : null;
    return { ...f, value: raw == null ? null : Number(raw).toFixed(f.decimals) };
  });

  return (
    <div className="h-screen overflow-hidden flex flex-col text-slate-100 font-sans">

      {/* ===== Fixed header (item 1 + item 2) — never part of a scrolling region ===== */}
      <div className="h-[3px] w-full shrink-0 bg-gradient-to-r from-emerald-500 via-cyan-400 to-indigo-500 bg-[length:200%_auto] animate-[gradientShift_6s_ease-in-out_infinite]" />
      <header className="shrink-0 z-30 flex items-center justify-between gap-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur px-6 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <LogoIcon className="w-9 h-9 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-lg font-bold tracking-tight text-gradient-brand truncate">{PLATFORM_NAME}</h1>
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 tracking-wide">
                <LiveDotIcon className="w-1.5 h-1.5" /> LIVE
              </span>
            </div>
            <p className="text-xs text-slate-400 truncate">
              Real-time solar &amp; wind site intelligence · <span className="text-emerald-300/90 font-medium">{formatSiteName(site)}</span>
            </p>
          </div>
        </div>

        {/* Tab switcher: live dashboard vs. the new per-site deep-dive analysis */}
        <div className="flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/70 p-1 shrink-0">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-3.5 py-1.5 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'dashboard' ? 'bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 shadow-md shadow-emerald-900/40' : 'text-slate-300 hover:text-white hover:bg-slate-700/50'}`}
          >
            Live Dashboard
          </button>
          <button
            onClick={() => setActiveTab('analysis')}
            className={`px-3.5 py-1.5 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'analysis' ? 'bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 shadow-md shadow-emerald-900/40' : 'text-slate-300 hover:text-white hover:bg-slate-700/50'}`}
          >
            Site Analysis
          </button>
          <button
            onClick={() => setActiveTab('models')}
            className={`px-3.5 py-1.5 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'models' ? 'bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 shadow-md shadow-emerald-900/40' : 'text-slate-300 hover:text-white hover:bg-slate-700/50'}`}
          >
            Model Comparison
          </button>
        </div>

        {/* "All Parameters" dropdown */}
        {activeTab === 'dashboard' && (
        <div className="relative shrink-0" ref={paramMenuRef}>
          <button
            onClick={() => setParamMenuOpen(o => !o)}
            className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/70 hover:bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-200 shadow-sm shadow-black/20 transition-colors duration-200"
          >
            {activeParam !== 'all' && (
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: activeParamMeta?.color }} />
            )}
            <span>{showingLabel}</span>
            <ChevronIcon open={paramMenuOpen} className="w-4 h-4 text-slate-400" />
          </button>

          {paramMenuOpen && (
            <div className="absolute right-0 mt-2 w-56 rounded-xl border border-slate-700 bg-slate-900 shadow-xl shadow-black/40 overflow-hidden z-40 animate-[fadeIn_0.15s_ease-in-out]">
              <button
                onClick={() => { setActiveParam('all'); setParamMenuOpen(false); }}
                className={`w-full flex items-center gap-2 px-3.5 py-2.5 text-sm text-left hover:bg-slate-800 transition-colors duration-150 ${activeParam === 'all' ? 'text-emerald-300 bg-emerald-500/10' : 'text-slate-200'}`}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-400" />
                All Parameters
              </button>
              <div className="h-px bg-slate-800" />
              {PARAMS.map(p => (
                <button
                  key={p.key}
                  onClick={() => { setActiveParam(p.key); setParamMenuOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3.5 py-2.5 text-sm text-left hover:bg-slate-800 transition-colors duration-150 ${activeParam === p.key ? 'text-emerald-300 bg-emerald-500/10' : 'text-slate-200'}`}
                >
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
        )}

        <LiveClock />
      </header>

      {/* ===== Live snapshot strip — the "real-time website" moment: current
          interpolated readings at this exact instant, ticking with the clock ===== */}
      {activeTab === 'dashboard' && (
        <div className="shrink-0 z-20 flex flex-wrap gap-3 border-b border-slate-800 bg-slate-950/60 backdrop-blur px-6 py-3">
          {snapshotCards.map(c => (
            <SnapshotCard key={c.key} label={c.label} value={c.value} unit={c.unit} color={c.color} icon={c.icon} />
          ))}
        </div>
      )}

      {/* ===== Sidebar + main content row — only this fills the remaining viewport ===== */}
      {activeTab === 'dashboard' && (
      <div className="flex flex-1 min-h-0 relative">

        {/* Sidebar toggle — stays visible whether sidebar is open or closed */}
        <button
          onClick={handleSidebarToggle}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className="absolute top-4 z-20 w-8 h-8 flex items-center justify-center rounded-full bg-slate-800 border border-slate-700 text-slate-300 hover:bg-emerald-500 hover:text-slate-950 hover:border-emerald-400 transition-all duration-300 ease-in-out shadow-md shadow-black/30"
          style={{ left: sidebarOpen ? '19.5rem' : '0.75rem' }}
        >
          <CollapseIcon open={sidebarOpen} className="w-4 h-4" />
        </button>

        <div
          className={`bg-slate-900/80 border-r border-slate-800 flex flex-col gap-4 overflow-y-auto
            transition-all duration-300 ease-in-out
            ${sidebarOpen ? 'w-80 p-6 opacity-100' : 'w-0 p-0 opacity-0'}`}
        >
          <div className="w-72 shrink-0">
            <p className="text-xs uppercase tracking-wide text-emerald-400/80 font-semibold">{PLATFORM_NAME}</p>
            <h2 className="font-display text-xl font-bold text-white">Solar &amp; Wind Operations</h2>
          </div>

          <div className="w-72 shrink-0">
            <label className="block text-sm text-slate-400 mb-1">Project Site</label>
            <select
              className="w-full bg-slate-800/70 border border-slate-700 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60 transition-shadow duration-200"
              value={site}
              onChange={(e) => setSite(e.target.value)}
            >
              {SITES.map(s => <option key={s} value={s}>{formatSiteName(s)}</option>)}
            </select>
          </div>

          <div className="card-glow w-72 shrink-0 rounded-xl border border-slate-700/60 bg-slate-800/70 p-4 shadow-sm shadow-black/20 hover:border-slate-600 transition-colors duration-200">
            <button
              onClick={() => setSolarOpen(o => !o)}
              className="w-full flex items-center justify-between text-amber-400 font-semibold"
            >
              <span className="flex items-center gap-2"><SunIcon className="w-4 h-4" /> Solar Parameters</span>
              <ChevronIcon open={solarOpen} className="w-4 h-4" />
            </button>
            <div
              className={`grid transition-all duration-300 ease-in-out ${solarOpen ? 'grid-rows-[1fr] opacity-100 mt-3' : 'grid-rows-[0fr] opacity-0'}`}
            >
              <div className="overflow-hidden flex flex-col gap-2">
                {SOLAR_PARAMS.map(p => (
                  <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={enabledParams[p.key]}
                      onChange={() => toggleParam(p.key)}
                      className="accent-emerald-500 w-4 h-4"
                    />
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="card-glow w-72 shrink-0 rounded-xl border border-slate-700/60 bg-slate-800/70 p-4 shadow-sm shadow-black/20 hover:border-slate-600 transition-colors duration-200">
            <button
              onClick={() => setWindOpen(o => !o)}
              className="w-full flex items-center justify-between text-cyan-400 font-semibold"
            >
              <span className="flex items-center gap-2"><WindIcon className="w-4 h-4" /> Wind Parameters</span>
              <ChevronIcon open={windOpen} className="w-4 h-4" />
            </button>
            <div
              className={`grid transition-all duration-300 ease-in-out ${windOpen ? 'grid-rows-[1fr] opacity-100 mt-3' : 'grid-rows-[0fr] opacity-0'}`}
            >
              <div className="overflow-hidden flex flex-col gap-2">
                {WIND_PARAMS.map(p => (
                  <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={enabledParams[p.key]}
                      onChange={() => toggleParam(p.key)}
                      className="accent-emerald-500 w-4 h-4"
                    />
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                    {p.label}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm text-slate-500 cursor-not-allowed">
                  <input type="checkbox" disabled className="w-4 h-4" /> Wind Direction (not available)
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-500 cursor-not-allowed">
                  <input type="checkbox" disabled className="w-4 h-4" /> Wind Gust (not available)
                </label>
              </div>
            </div>
          </div>

          {gridWeather && (
            <div className="w-72 shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm shadow-sm shadow-black/20 animate-[fadeIn_0.3s_ease-in-out]">
              <p className="text-emerald-300 font-semibold mb-1.5 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Grid Weather Live
              </p>
              <p className="text-slate-300">Wind Dir: {gridWeather.windDir} ({gridWeather.wind360}°)</p>
              <p className="text-slate-300">Gust: {gridWeather.windGust ?? 'No significant gust'}</p>
              <p className="text-slate-300">Cloud: {gridWeather.cloud}%</p>
              <p className="text-slate-300">Pressure: {gridWeather.pressure} hPa</p>
            </div>
          )}
          {blocked && !gridWeather && (
            <div className="card-glow w-72 shrink-0 rounded-xl border border-slate-700/60 bg-slate-800/70 p-4 text-xs text-slate-400 shadow-sm shadow-black/20">
              <p className="text-red-400 font-semibold mb-1">Grid weather blocked</p>
              <p>{blocked.windDirection}</p>
            </div>
          )}

          <div className="card-glow w-72 shrink-0 rounded-xl border border-slate-700/60 bg-slate-800/70 p-4 shadow-sm shadow-black/20 hover:border-slate-600 transition-colors duration-200">
            <p className="text-sm text-slate-300 mb-2">Upload Site Sensor CSV/XLSX</p>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload}
              className="text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-500/90 file:text-slate-950 file:px-3 file:py-1.5 file:text-xs file:font-semibold hover:file:bg-emerald-400 file:cursor-pointer file:transition-colors file:duration-200"
            />
            {fileError && <p className="text-red-400 text-xs mt-2">{fileError}</p>}
            {csvRows && !fileError && (
              <p className="text-emerald-400 text-xs mt-2">Loaded {csvRows.length} rows</p>
            )}
          </div>

          <div className="w-72 shrink-0 flex gap-2">
            <button
              onClick={() => handleFetch(false)}
              className="flex-1 bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-semibold rounded-xl py-2.5 transition-all duration-200 shadow-md shadow-emerald-900/30 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-emerald-900/40 active:translate-y-0"
            >
              Fetch
            </button>
            <button
              onClick={() => handleFetch(true)}
              title="Bypass cache and hit the backend directly"
              className="px-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 rounded-xl py-2.5 text-sm transition-all duration-200 hover:-translate-y-0.5"
            >
              <RefreshIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="w-72 shrink-0"><StatusPill status={status} /></div>
          <p className="w-72 shrink-0 text-xs text-slate-500 leading-relaxed">
            Auto-refreshes every 15 min | Axis: 05:00 → 21:00 (15-min steps) | Data fills from {pad(windowStart.getHours())}:{pad(windowStart.getMinutes())} onward, zero before that
          </p>
          {error && <p className="w-72 shrink-0 text-red-400 text-sm">{error}</p>}
        </div>

        {/* ===== Main content — the ONLY pane that scrolls ===== */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-6 transition-all duration-300 ease-in-out">

          <div className="card-glow shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 overflow-hidden hover:border-slate-700 transition-colors duration-300">
            <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3.5 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400">
                  <ChartIcon className="w-4.5 h-4.5" />
                </span>
                <h2 className="font-display text-base font-semibold text-white">Forecast Graph — {formatSiteName(site)}</h2>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                Showing: {showingLabel}
              </span>
            </div>
            <div className="bg-white p-4">
              {forecast.length > 0 ? (
                <div className="relative w-full" style={{ height: '600px' }}>
                  <Line data={chart1Data} options={chartOptions} />
                </div>
              ) : (
                <p className="text-slate-500 text-center py-20">Select parameters and click Fetch to load real QWeather data.</p>
              )}
            </div>
          </div>

          <div className="card-glow shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20 overflow-hidden hover:border-slate-700 transition-colors duration-300">
            <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3.5 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/15 text-cyan-400">
                  <CompareIcon className="w-4.5 h-4.5" />
                </span>
                <h2 className="font-display text-base font-semibold text-white">Forecast vs Actual <span className="text-slate-400 font-normal">(Temperature, GHI &amp; POA: Global/Diffuse/Direct)</span></h2>
              </div>
              {csvRows && csvRows.length > 0 && (
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-400">Parameter:</label>
                  <select
                    className="bg-slate-800 text-slate-100 rounded-lg p-1.5 text-sm border border-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/60 transition-shadow duration-200"
                    value={chart2Metric}
                    onChange={(e) => setChart2Metric(e.target.value)}
                  >
                    <option value="all">All (combined)</option>
                    <option value="temp">Temperature</option>
                    <option value="ghi">GHI</option>
                    <option value="poa">POA (All 3 vs Site)</option>
                    <option value="poaGlobal">POA Global</option>
                    <option value="poaDiffuse">POA Diffuse</option>
                    <option value="poaDirect">POA Direct</option>
                  </select>
                </div>
              )}
            </div>
            <div className="bg-white p-4">
              {chart2Data ? (
                <div className="relative w-full" style={{ height: '450px' }}>
                  <Line data={chart2Data} options={chartOptions} />
                </div>
              ) : (
                <p className="text-slate-500 text-center py-20">Upload a site sensor CSV or XLSX to see the comparison.</p>
              )}
            </div>
            {statCards.length > 0 && (
              <div className="px-5 py-4 border-t border-slate-800 bg-slate-900/40">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {statCards.map(card => (
                    <div
                      key={card.label}
                      className="rounded-xl border border-slate-700/60 bg-slate-800/70 p-3 shadow-sm shadow-black/20"
                      style={{ borderColor: `${card.color}40` }}
                    >
                      <p className="text-xs text-slate-400 mb-1 truncate">{card.label} Accuracy</p>
                      <p className="text-xl font-bold" style={{ color: card.color }}>{card.value}%</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
      )}

      {activeTab === 'analysis' && <HistoricalAnalysis />}
      {activeTab === 'models' && <ModelComparison />}
    </div>
  );
}