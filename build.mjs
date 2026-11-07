/**
 * Build script. Produces a directory that loads unpacked, per target.
 *
 * esbuild is used directly rather than through a bundler plugin because an
 * extension has several unrelated entry points with different output
 * formats, and that is simpler to state than to configure.
 *
 * `--watch` rebuilds on every save, but not through esbuild's own watch mode:
 * that one polls the file system (https://esbuild.github.io/api/#watch), and
 * with a context per entry point it polled once per entry, all day, whether
 * anything changed or not. Here a single fs.watch on src/, which macOS serves
 * from FSEvents, wakes the process only when a file under it changes, and
 * every context then rebuilds incrementally. Build configuration (this file,
 * manifest.config.js, tsconfig.json) is read once at start, as before: a
 * change there needs a restart.
 */
import * as esbuild from 'esbuild';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync, watch as watchFiles } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestFor } from './manifest.config.js';
import { iconPng } from './tools/make-icons.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const targets = process.argv.includes('--firefox') ? ['firefox'] : ['chromium'];

/** Content scripts cannot be modules, so they are bundled as an IIFE. */
const ENTRIES = [
  { in: 'src/background/index.ts', out: 'background', format: 'esm' },
  { in: 'src/content/index.ts', out: 'content', format: 'iife' },
  { in: 'src/options/main.ts', out: 'options', format: 'iife' },
  { in: 'src/action/main.ts', out: 'action', format: 'iife' },
  { in: 'src/panel/main.ts', out: 'panel', format: 'iife' },
];

const PAGES = ['options.html', 'action.html', 'panel.html'];

async function buildTarget(target) {
  const outdir = join(root, 'dist', target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, 'icons'), { recursive: true });

  const options = {
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    target: ['chrome116', 'firefox128'],
    legalComments: 'none',
    logLevel: 'warning',
    define: { __DEV__: String(watch) },
  };

  const contexts = [];
  for (const entry of ENTRIES) {
    if (!existsSync(join(root, entry.in))) continue;
    const config = {
      ...options,
      entryPoints: [join(root, entry.in)],
      outfile: join(outdir, `${entry.out}.js`),
      format: entry.format,
    };
    if (watch) {
      contexts.push(await esbuild.context(config));
    } else {
      await esbuild.build(config);
    }
  }

  await writeFile(
    join(outdir, 'manifest.json'),
    JSON.stringify(manifestFor(target), null, 2) + '\n',
  );

  for (const size of [16, 32, 48, 128]) {
    await writeFile(join(outdir, 'icons', `${size}.png`), iconPng(size));
  }

  const result = { outdir, contexts };
  if (watch) await emit(result);
  else await copyPages(outdir);
  return result;
}

async function copyPages(outdir) {
  for (const page of PAGES) {
    const src = join(root, 'src', 'pages', page);
    if (existsSync(src)) await cp(src, join(outdir, page));
  }
}

/**
 * Everything a save under src/ can change: each bundle, and the pages copied
 * beside them. Every context is rebuilt even when one fails, so a broken
 * entry leaves the others current. esbuild prints its errors itself; a page
 * that cannot be copied is printed here. Never throws, so a failed save
 * cannot stop the watcher: it waits for the next one.
 */
async function emit({ outdir, contexts }) {
  const outcomes = await Promise.allSettled(contexts.map((ctx) => ctx.rebuild()));
  let copied = true;
  try {
    await copyPages(outdir);
  } catch (error) {
    console.error(error);
    copied = false;
  }
  return copied && outcomes.every((outcome) => outcome.status === 'fulfilled');
}

const results = [];
for (const target of targets) results.push(await buildTarget(target));

for (const { outdir } of results) {
  console.log(`${watch ? 'watching' : 'built'} → ${outdir}`);
}

if (!watch) process.exit(0);

// One rebuild at a time. Saves that land during one are folded into a single
// rebuild after it, and a burst of events from one save (editors write a
// temporary file and rename it) is folded by the short delay before starting.
let building = false;
let again = false;
let timer;

async function rebuildAll() {
  if (building) {
    again = true;
    return;
  }
  building = true;
  do {
    again = false;
    const started = Date.now();
    const ok = (await Promise.all(results.map(emit))).every(Boolean);
    const took = Date.now() - started;
    console.log(ok ? `rebuilt in ${took} ms` : `rebuild failed in ${took} ms; watching for the fix`);
  } while (again);
  building = false;
}

watchFiles(join(root, 'src'), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(rebuildAll, 50);
});
