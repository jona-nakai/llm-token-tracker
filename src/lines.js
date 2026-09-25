import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 4 * 1024 * 1024;

// Calls onLine(line, index) for every non-empty line. Reads in fixed-size
// chunks so multi-hundred-MB session logs never become a single string.
export function forEachLine(path, onLine) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let index = 0;
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (bytes === 0) break;
      pending += decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      let newline;
      while ((newline = pending.indexOf('\n', start)) !== -1) {
        const line = pending.slice(start, newline);
        start = newline + 1;
        if (line.trim()) onLine(line, index);
        index += 1;
      }
      pending = pending.slice(start);
    }
    pending += decoder.end();
    if (pending.trim()) onLine(pending, index);
  } finally {
    closeSync(fd);
  }
}

export function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
