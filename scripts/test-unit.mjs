import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const jest = join(root, 'node_modules/jest/bin/jest.js');
// pnpm can forward its argument separator to the script.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const inspection = args.some((arg) => /^--(?:help|version|showConfig|listTests)(?:=|$)/.test(arg) || arg === '-h' || arg === '-v');
const profiles = [
  { config: 'jest.config.cjs', flags: [] },
  { config: 'jest.formula-slate.config.cjs', flags: ['--experimental-vm-modules'] },
];
let matched = false;
let exitCode = 0;

for (const { config, flags } of profiles) {
  const command = [...flags, jest, '--config', join(root, config), ...args];

  if (!inspection) {
    const discovery = spawnSync(process.execPath, [...command, '--listTests', '--json'], {
      cwd: root,
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
  const result = spawnSync(process.execPath, command, { cwd: root, stdio: 'inherit' });

  if (result.error) console.error(result.error);
  if (result.status !== 0) exitCode = result.status || 1;
}

if (!matched && exitCode === 0 && !args.includes('--passWithNoTests')) {
  console.error('No tests found');
  exitCode = 1;
}

process.exitCode = exitCode;
