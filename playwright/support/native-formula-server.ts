import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base } from '@playwright/test';

function developmentHTML(entry: string) {
  return `<!doctype html><html lang="en"><head><title>Native formula database</title></head>
<body><div id="root"></div><script type="module">
  import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
  await import('/${entry}');
</script></body></html>`;
}

type FormulaHost = { url: string; html: string };

export function createNativeFormulaTest(entry: string) {
  return base.extend<object, { formulaHost: FormulaHost; formulaURL: string; formulaHTML: string }>({
    formulaHost: [
      // Playwright requires dependency destructuring even without dependencies.
      // eslint-disable-next-line no-empty-pattern
      async ({}, use, workerInfo) => {
        if (process.env.FORMULA_FIXTURE_PRODUCTION === '1') {
          const { build, preview } = await import('vite');
          const directory = await mkdtemp(join(tmpdir(), 'native-formula-production-'));

          try {
            await build({
              logLevel: 'warn',
              build: {
                outDir: directory,
                emptyOutDir: true,
                manifest: true,
                rollupOptions: { input: entry },
              },
            });
            const manifest = JSON.parse(await readFile(join(directory, '.vite/manifest.json'), 'utf8')) as Record<
              string,
              { file: string; css?: string[] }
            >;
            const builtEntry = manifest[entry];
            const styles = (builtEntry.css ?? []).map((css) => `<link rel="stylesheet" href="/${css}">`).join('');
            const html = `<!doctype html><html lang="en"><head><title>Native formula database</title>${styles}</head>
<body><div id="root"></div><script type="module" src="/${builtEntry.file}"></script></body></html>`;
            const server = await preview({
              logLevel: 'error',
              build: { outDir: directory },
              preview: { host: '127.0.0.1', port: 0, strictPort: false },
            });

            try {
              await use({ url: server.resolvedUrls!.local[0], html });
            } finally {
              await new Promise<void>((resolve, reject) =>
                server.httpServer.close((error) => (error ? reject(error) : resolve()))
              );
            }
          } finally {
            await rm(directory, { recursive: true, force: true });
          }

          return;
        }

        const { createServer } = await import('vite');
        const server = await createServer({
          cacheDir: `node_modules/.vite/native-formula-${createHash('sha256')
            .update(entry)
            .digest('hex')
            .slice(0, 12)}-${workerInfo.workerIndex}`,
          logLevel: 'error',
          optimizeDeps: { entries: [entry] },
          server: { host: '127.0.0.1', port: 0, strictPort: false },
        });

        try {
          await server.listen();
          await use({ url: server.resolvedUrls!.local[0], html: developmentHTML(entry) });
        } finally {
          await server.close();
        }
      },
      { scope: 'worker', timeout: 180_000 },
    ],
    formulaURL: [async ({ formulaHost }, use) => use(formulaHost.url), { scope: 'worker' }],
    formulaHTML: [async ({ formulaHost }, use) => use(formulaHost.html), { scope: 'worker' }],
  });
}

export const test = createNativeFormulaTest('playwright/support/native-formula.fixture.tsx');
