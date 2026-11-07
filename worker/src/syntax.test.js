// A file that does not parse fails here, with its name, instead of failing only when something imports it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const check = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return null;
  } catch (err) {
    return String(err.stderr || err.message).trim().split('\n').slice(0, 6).join('\n');
  }
};

test('node --check on every src/*.js file', () => {
  const problems = [];
  for (const file of fs.readdirSync(here).filter((f) => f.endsWith('.js')).sort()) {
    const problem = check(process.execPath, ['--check', path.join(here, file)]);
    if (problem) problems.push(`${file} does not parse:\n${problem}`);
  }
  assert.deepEqual(problems, []);
});

test('bash -n receipts', () => {
  const problem = check('bash', ['-n', path.join(here, '..', '..', 'receipts')]);
  assert.equal(problem, null, `receipts does not parse:\n${problem}`);
});
