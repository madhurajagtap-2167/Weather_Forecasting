import { createApp } from './app.js';
import { PORT } from './config.js';
import { getDb } from './db.js';
import { startScheduler } from './services/scheduler.js';

const app = createApp();

app.listen(PORT, async () => {
  console.log(`Swara Weather API (Express) listening on http://localhost:${PORT}`);
  await getDb(); // connect to MongoDB (falls back to CSV files if unavailable)
  if (process.env.DISABLE_SCHEDULER !== 'true') startScheduler();
});
