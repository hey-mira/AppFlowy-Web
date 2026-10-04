#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(readFileSync(resolve(root, 'scripts/notion-formula-source.json'), 'utf8'));

if (process.argv.length > 3 || !/^[a-f0-9]{40}$/.test(pin.revision)) {
  throw new Error('Usage: node scripts/prepare-notion-formula.mjs [notion-formula-checkout]; pin a full commit SHA.');
}

function run(command, args, cwd, env = process.env) {
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
}

// A local source is an explicit development override. Fresh checkouts and CI
// fetch exactly the pin, without initializing the source's AppFlowy submodule.
const localSource = process.argv[2] && resolve(process.argv[2]);
const cache = resolve(root, '.notion-formula-build');

mkdirSync(cache, { recursive: true });
const temporary = localSource ? undefined : mkdtempSync(resolve(cache, 'source-'));
const source = localSource || temporary;

try {
  if (temporary) {
    run('git', ['init', '--quiet', source], root);
    run('git', ['fetch', '--depth=1', pin.repository, pin.revision], source);
    run('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'], source);
  }

  const manifest = resolve(source, 'packages/notion-formula/package.json');

  if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).name !== '@notion-formula/sdk') {
    throw new Error(`${source} does not contain the shared @notion-formula/sdk package.`);
  }

  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

  if (!localSource && revision !== pin.revision) {
    throw new Error(`Fetched ${revision}; expected ${pin.revision}.`);
  }

  console.log(`Building @notion-formula/sdk from ${revision}${localSource ? ' (local checkout)' : ''}`);
  const sdk = resolve(source, 'packages/notion-formula');

  run('pnpm', ['install', '--frozen-lockfile'], sdk);
  run('pnpm', ['run', 'build'], sdk, {
    ...process.env,
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || resolve(cache, 'target'),
  });

  // The source owns staging and checks the complete dist before replacing an
  // existing package. Failed downloads/builds leave the working SDK in place.
  run(process.execPath, [resolve(source, 'scripts/stage-appflowy-sdk.mjs'), root], root);
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
