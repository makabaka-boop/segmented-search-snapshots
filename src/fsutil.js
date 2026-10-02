import { randomUUID } from 'node:crypto';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises';

async function fsyncDir(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteJson(filePath, value, fault) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;

  try {
    handle = await open(tempPath, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (fault) await fault(new Error('injected failure before atomic rename'));

    await rename(tempPath, filePath);
    renamed = true;
    await fsyncDir(directory);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* best effort */ }
    }
    if (!renamed) await rm(tempPath, { force: true });
    else error.committed = true;
    throw error;
  }
}

export { fsyncDir };
