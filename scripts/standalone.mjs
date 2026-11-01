/**
 * Copy the single-file production build to a stable, directly openable location.
 * `npm run build:standalone` -> atmos-sim-standalone.html (works over file:// too).
 */
import { readFile, writeFile, stat } from 'node:fs/promises';

const src = new URL('../dist/index.html', import.meta.url);
const out = new URL('../atmos-sim-standalone.html', import.meta.url);

const html = await readFile(src);
await writeFile(out, html);
const { size } = await stat(out);
console.log(`wrote atmos-sim-standalone.html (${(size / 1024).toFixed(0)} kB) — open it directly in a browser`);
