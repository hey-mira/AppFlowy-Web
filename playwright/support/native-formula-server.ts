import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base } from '@playwright/test';

const developmentHTML = `<!doctype html><html lang="en"><head><title>Native formula database</title></head>
<body><div id="root"></div><script type="module">
  import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
  await import('/playwright/support/native-formula.fixture.tsx');
</script></body></html>`;

type FormulaHost = { url: string; html: string };

export const test = base.extend<object, { formulaHost: FormulaHost; formulaURL: string; formulaHTML: string }>({
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
              rollupOptions: { input: 'playwright/support/native-formula.fixture.tsx' },
            },
          });
          const manifest = JSON.parse(await readFile(join(directory, '.vite/manifest.json'), 'utf8')) as Record<
            string,
            { file: string; css?: string[] }
          >;
          const entry = manifest['playwright/support/native-formula.fixture.tsx'];
          const styles = (entry.css ?? []).map((css) => `<link rel="stylesheet" href="/${css}">`).join('');
          const html = `<!doctype html><html lang="en"><head><title>Native formula database</title>${styles}</head>
<body><div id="root"></div><script type="module" src="/${entry.file}"></script></body></html>`;
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
        cacheDir: `node_modules/.vite/native-formula-${workerInfo.workerIndex}`,
        logLevel: 'error',
        optimizeDeps: { entries: ['playwright/support/native-formula.fixture.tsx'] },
        server: { host: '127.0.0.1', port: 0, strictPort: false },
      });

      try {
        await server.listen();
        await use({ url: server.resolvedUrls!.local[0], html: developmentHTML });
      } finally {
        await server.close();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  formulaURL: [async ({ formulaHost }, use) => use(formulaHost.url), { scope: 'worker' }],
  formulaHTML: [async ({ formulaHost }, use) => use(formulaHost.html), { scope: 'worker' }],
});
