import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Copy a few data folders into a temp DATA_ROOT so tests never touch real data. */
export function makeTempRoot(folders = ['data', 'historical_data', 'historical_data_15min', 'forecast']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swara-'));
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const f of folders) {
    if (fs.existsSync(path.join(here, f))) fs.cpSync(path.join(here, f), path.join(root, f), { recursive: true });
  }
  return root;
}
