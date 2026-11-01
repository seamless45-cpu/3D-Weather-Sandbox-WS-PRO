/**
 * Copy the single-file production build to stable, directly openable locations:
 *   atmos-sim-standalone.html  (open from disk / share as one file)
 *   docs/index.html            (served by GitHub Pages from main:/docs)
 */
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';

const src = new URL('../dist/index.html', import.meta.url);
const targets = [
  new URL('../atmos-sim-standalone.html', import.meta.url),
  new URL('../docs/index.html', import.meta.url),
];

const html = await readFile(src);
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
for (const out of targets) await writeFile(out, html);
const { size } = await stat(targets[0]);
console.log(
  `wrote atmos-sim-standalone.html + docs/index.html (${(size / 1024).toFixed(0)} kB) — ` +
    'open the HTML file directly or serve docs/ as a static site',
);
