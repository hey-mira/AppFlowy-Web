import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// pnpm's Jest shim supplies the dependency search paths used by the CJS suites.
const pnpm = process.env.npm_execpath;
const executable = pnpm ? process.execPath : 'pnpm';
const prefix = pnpm ? [pnpm] : [];
// pnpm can forward its argument separator to the script.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const inspection = args.some((arg) => /^--(?:help|version|showConfig|listTests)(?:=|$)/.test(arg) || arg === '-h' || arg === '-v');
const profiles = [
  { config: 'jest.config.cjs', esm: false },
  { config: 'jest.formula-slate.config.cjs', esm: true },
];
let matched = false;
let exitCode = 0;

for (const { config, esm } of profiles) {
  const command = [...prefix, '--silent', 'exec', 'jest', '--config', join(root, config), ...args];
  const env = esm
    ? { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--experimental-vm-modules'].filter(Boolean).join(' ') }
    : process.env;

  if (!inspection) {
    const discovery = spawnSync(executable, [...command, '--listTests', '--json'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });

    if (discovery.error || discovery.status !== 0) {
      process.stdout.write(discovery.stdout ?? '');
      process.stderr.write(discovery.stderr ?? String(discovery.error ?? 'Test discovery failed'));
      exitCode = discovery.status || 1;
      continue;
    }

    if (JSON.parse(discovery.stdout).length === 0) continue;
  }

  matched = true;
  const result = spawnSync(executable, command, { cwd: root, env, stdio: 'inherit' });

  if (result.error) console.error(result.error);
  if (result.status !== 0) exitCode = result.status || 1;
}

if (!matched && exitCode === 0 && !args.includes('--passWithNoTests')) {
  console.error('No tests found');
  exitCode = 1;
}

process.exitCode = exitCode;
