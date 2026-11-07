// private-umask.js: a process that imports it creates 0600 files and 0700 folders, checked in a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

test('private-umask: files and folders created afterwards, by any code, are 0600 and 0700', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'umask-'));
  try {
    const script = `
      process.umask(0o022);
      await import(${JSON.stringify(path.join(dir, 'private-umask.js'))});
      const fs = await import('node:fs');
      fs.mkdirSync(${JSON.stringify(path.join(tmp, 'd'))});
      fs.writeFileSync(${JSON.stringify(path.join(tmp, 'd', 'f'))}, 'x');
      console.log(process.umask().toString(8));
    `;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script]).toString().trim(), '77');
    assert.equal(fs.statSync(path.join(tmp, 'd')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(tmp, 'd', 'f')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('every entry script imports private-umask.js before anything else', () => {
  for (const name of ['index', 'check', 'replay', 'describe-categories', 'item-test', 'keyword-cli', 'list-categories']) {
    const imports = fs.readFileSync(path.join(dir, `${name}.js`), 'utf8').split('\n').filter((l) => /^import /.test(l));
    assert.equal(imports[0], "import './private-umask.js';", name);
  }
});
