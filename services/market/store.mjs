// tiny debounced JSON file store. writes are atomic (temp file + rename) so a
// crash mid-save can never leave a half written document behind, and `flush()`
// is wired into the process exit path so nothing is lost on shutdown.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_FLUSH_DELAY_MS = 4000;

export function createJsonStore(filePath, options = {}) {
  const fallback = options.fallback ?? (() => ({}));
  const delay = options.delay ?? DEFAULT_FLUSH_DELAY_MS;
  let data = fallback();
  let dirty = false;
  let timer = null;

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (raw.trim().length > 0) {
          data = JSON.parse(raw);
          return data;
        }
      }
    } catch (error) {
      console.warn(`unable to read ${filePath}:`, error);
    }
    data = fallback();
    return data;
  }

  function get() {
    return data;
  }

  function set(next) {
    data = next;
    markDirty();
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return false;
    dirty = false;

    const tempPath = `${filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(data));
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (error) {
      dirty = true;
      console.warn(`unable to persist ${filePath}:`, error);
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      return false;
    }
  }

  function markDirty() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
    timer.unref?.();
  }

  return { load, get, set, markDirty, flush, get filePath() { return filePath; } };
}
