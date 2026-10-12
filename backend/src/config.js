import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// backend/ folder (parent of src/)
// Folder that holds data/, forecast/, historical_data/ ... (defaults to backend/; override with DATA_ROOT)
export const ROOT = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

// --- Server ---
export const PORT = parseInt(env('PORT', env('FLASK_PORT', '5001')), 10);

// --- MongoDB ---
export const MONGO_URI = env('MONGO_URI', 'mongodb://localhost:27017');
export const MONGO_DB = env('MONGO_DB', 'swara_weather');

// --- Open-Meteo (free, keyless forecast) ---
export const OPENMETEO_API_HOST = env('OPENMETEO_API_HOST', 'api.open-meteo.com');
export const OPENMETEO_FORECAST_PATH = env('OPENMETEO_FORECAST_PATH', '/v1/forecast');

// --- Open-Meteo Historical (Archive) API: commercial tier, key lives only in .env ---
export const OPENMETEO_ARCHIVE_HOST = env('OPENMETEO_ARCHIVE_HOST', 'customer-archive-api.open-meteo.com');
export const OPENMETEO_ARCHIVE_PATH = env('OPENMETEO_ARCHIVE_PATH', '/v1/archive');
export const OPENMETEO_API_KEY = env('OPENMETEO_API_KEY', '');
export const OPENMETEO_HISTORICAL_FORECAST_HOST = env(
  'OPENMETEO_HISTORICAL_FORECAST_HOST', 'customer-historical-forecast-api.open-meteo.com');
export const OPENMETEO_HISTORICAL_FORECAST_PATH = env('OPENMETEO_HISTORICAL_FORECAST_PATH', '/v1/forecast');

// NWP models compared per site (key -> Open-Meteo model id)
export const NWP_MODELS = {
  ecmwf: 'ecmwf_ifs025',
  gfs: 'gfs_seamless',
  icon: 'icon_seamless',
  gem: 'gem_seamless',
  meteofrance: 'meteofrance_seamless',
  jma: 'jma_seamless',
  best_match: 'best_match',
};

export const HISTORICAL_TIMEZONE = 'Asia/Kolkata';
export const HISTORICAL_RAW_DIR = path.join(ROOT, 'historical_data', 'raw');
export const HISTORICAL_PROCESSED_DIR = path.join(ROOT, 'historical_data', 'processed');
export const HISTORICAL_PROCESSED_15MIN_DIR = path.join(ROOT, 'historical_data_15min');
export const MODEL_BACKTEST_DIR = path.join(ROOT, 'historical_data', 'model_backtest');

// Tilt/azimuth per the site table (BHUPALPALLY and KASIPET tilt 5, others 20)
export const SITES = {
  BHUPALPALLY: { lat: 18.447931, lon: 79.877263, tilt: 5, azimuth: 180 },
  KASIPET: { lat: 19.03943918, lon: 79.43691745, tilt: 5, azimuth: 180 },
  KOTHAGUDEM: { lat: 17.52500925, lon: 80.64616743, tilt: 20, azimuth: 180 },
  OSEPL: { lat: 17.9068, lon: 76.3229, tilt: 20, azimuth: 180 },
  SIRMOUR: { lat: 24.56253056, lon: 75.09140278, tilt: 20, azimuth: 180 },
  ANJANGAON: { lat: 21.975834, lon: 75.96833, tilt: 20, azimuth: 180 },
};

export const DATA_DIR = path.join(ROOT, 'data');
export const PILOT_SITES = ['KOTHAGUDEM', 'SIRMOUR'];
export const PILOT_SITE_DISPLAY_NAMES = { KOTHAGUDEM: 'Kothagudem', SIRMOUR: 'Sirmour' };
export const CAPTURE_TIMES = ['06:55', '08:15', '09:59', '11:21', '12:55', '14:18', '15:45'];
export const SNAPSHOT_DIR = path.join(ROOT, 'forecast');
export const SNAPSHOT_HOURLY_DIR = path.join(ROOT, 'forecast_hourly');
