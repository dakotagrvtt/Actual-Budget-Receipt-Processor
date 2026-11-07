// Everything the worker writes under its data directory is private to its user: directories 0700, files 0600.
import fs from 'node:fs/promises';
import path from 'node:path';

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/** mkdir -p with mode 0700 for the directories it creates. */
export const mkdirPrivate = (dir) => fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR });

/** Write a file that only its owner can read (the mode applies when the file is created: write a new temp file, then rename it over the old one). */
export const writePrivate = (file, data) => fs.writeFile(file, data, { mode: PRIVATE_FILE });

/**
 * Make `root` and everything under it private: directories 0700, files 0600 (an owner execute bit is kept, so installed tools
 * still run). Symbolic links are left alone, and so is anything that can't be changed (read-only mount, another owner).
 * Returns how many entries were changed.
 */
export async function repairPermissions(root) {
  let changed = 0;
  const fix = async (p, st) => {
    const want = st.isDirectory() ? PRIVATE_DIR : st.mode & 0o100 ? 0o700 : PRIVATE_FILE;
    if ((st.mode & 0o777) === want) return;
    try {
      await fs.chmod(p, want);
      changed++;
    } catch { /* not ours to change */ }
  };
  const walk = async (dir) => {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      const st = await fs.lstat(p).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await fix(p, st);
        await walk(p);
      } else if (st.isFile()) await fix(p, st);
    }
  };
  const st = await fs.lstat(root).catch(() => null);
  if (!st || !st.isDirectory()) return 0;
  await fix(root, st);
  await walk(root);
  return changed;
}
