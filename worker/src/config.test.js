// config.js: how settings are parsed (booleans, numbers, URLs, provider checks), each case in a fresh process; then the `receipts` script checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG_URL = new URL('./config.js', import.meta.url).href;
const RECEIPTS = fileURLToPath(new URL('../../receipts', import.meta.url));

/** Load config.js in a fresh process with `env` on top of the test environment; returns what it printed and warned. */
function load(env, expr) {
  const clean = { ...process.env };
  for (const k of ['DRY_RUN', 'TRIGGER_TIMEZONE', 'SPLIT_TRANSACTIONS', 'LLM_THINKING', 'OVERWRITE_CATEGORIZED', 'SIMILAR_ITEMS']) delete clean[k];
  const r = spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)}).then((m) => console.log(JSON.stringify(${expr})))`], { env: { ...clean, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { value: JSON.parse(r.stdout), warnings: r.stderr };
}

test('bool: true/1/yes/on and false/0/no/off, in any case and padded, are read without a warning', () => {
  for (const [v, want] of [['true', true], ['TRUE', true], ['1', true], ['yes', true], ['On', true], [' true ', true], ['false', false], ['FALSE', false], ['0', false], ['no', false], ['off', false], [' false ', false]]) {
    const { value, warnings } = load({ SIMILAR_ITEMS: v }, 'm.config.similarItems');
    assert.equal(value, want, v);
    assert.equal(warnings, '', v);
  }
});

test('bool: unset gives the default, without a warning', () => {
  assert.deepEqual(load({}, '[m.config.dryRun, m.config.splits, m.config.llmThinking, m.config.similarItems]'), { value: [true, true, false, true], warnings: '' });
});

test('bool: anything else warns on stderr and uses the default', () => {
  for (const v of ['tru', 'maybe', 'enabled', '', '2', 'constructor']) {
    const { value, warnings } = load({ DRY_RUN: v }, 'm.config.dryRun');
    assert.equal(value, true, `DRY_RUN="${v}" falls back to the default, which is dry run`);
    assert.match(warnings, new RegExp(`DRY_RUN="${v}" is not true or false; using the default \\(true\\)`), v);
    assert.equal(warnings.trim().split('\n').length, 1, v);
  }
  const { value, warnings } = load({ LLM_THINKING: 'sure' }, 'm.config.llmThinking');
  assert.equal(value, false);
  assert.match(warnings, /LLM_THINKING="sure" is not true or false; using the default \(false\)/);
});

// The functions behind `./receipts mode`, cut out of the script so they can run alone.
const bashFns = (script, names = ['env_get', 'env_dry', 'settings_read', 'mode_info', 'mode', 'mode_note', 'host_timezone', 'valid_timezone']) => names.map((name) => {
  const start = new RegExp(`^${name}\\(\\) \\{.*$`, 'm').exec(script);
  assert.ok(start, `${name}() not found in receipts`);
  if (start[0].endsWith('}')) return start[0];
  return script.slice(start.index, script.indexOf('\n}\n', start.index) + 3);
}).join('\n');

/** A bin dir with just the tools the mode functions need, and no python3, to run them the no-python way. */
function noPythonBin(parent) {
  const bin = path.join(parent, 'nopy-bin');
  fs.mkdirSync(bin);
  for (const tool of ['awk', 'cat', 'tr', 'cmp', 'stat', 'head', 'sed', 'grep', 'readlink', 'bash']) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    assert.ok(found, `${tool} not found`);
    fs.symlinkSync(found, path.join(bin, tool));
  }
  return bin;
}

test('./receipts mode agrees with the worker about DRY_RUN (and reads .env the way compose does)', () => {
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-test-'));
  try {
    const modeFor = (envFile) => {
      if (envFile === null) fs.rmSync(path.join(dir, '.env'), { force: true });
      else fs.writeFileSync(path.join(dir, '.env'), envFile);
      const r = spawnSync('bash', ['-c', `${fn}\nmode`], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const cases = ['true', 'false', 'False', 'FALSE', '0', 'no', 'off', 'OFF', 'yes', '1', 'on', "'false'", '"false"', 'false # live now', 'flase', ''];
    for (const v of cases) {
      const worker = load({ DRY_RUN: v.replace(/ #.*$/, '').replace(/^(['"])(.*)\1$/, '$2') }, 'm.config.dryRun').value;
      assert.equal(modeFor(`A=1\nDRY_RUN=${v}\nB=2\n`), worker ? 'dry run' : 'live', `DRY_RUN=${v}`);
    }
    // Lines compose accepts (checked with `docker compose config`), and the value the container then gets.
    const lines = [
      ['export DRY_RUN=false', 'false'], ['  DRY_RUN=false', 'false'], ['DRY_RUN = false', 'false'], ['  export   DRY_RUN = false', 'false'],
      ['DRY_RUN: false', 'false'], ['DRY_RUN:false', 'false'], ['DRY_RUN=fa lse', 'fa lse'], ['DRY_RUN=false   ', 'false'],
      ["DRY_RUN=' false '", ' false '], ['DRY_RUN="no"  # c', 'no'], ['DRY_RUN=false\nDRY_RUN=true', 'true'], ['DRY_RUN=true\nDRY_RUN=false', 'false'],
      ['DRY_RUN=# off', '# off'], ['#DRY_RUN=false', undefined], ['XDRY_RUN=false', undefined], ['DRY_RUNX=false', undefined], ['export DRY_RUN=0\r', '0'],
    ];
    for (const [text, value] of lines) {
      const worker = load(value === undefined ? {} : { DRY_RUN: value }, 'm.config.dryRun').value;
      assert.equal(modeFor(`${text}\n`), worker ? 'dry run' : 'live', JSON.stringify(text));
    }
    assert.equal(modeFor('A=1\n'), 'dry run'); // unset
    assert.equal(modeFor(null), 'dry run'); // no .env at all
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('env_get reads values the way docker compose does (verified against `docker compose config`)', () => {
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envget-test-'));
  try {
    const get = (text, key = 'V') => {
      fs.writeFileSync(path.join(dir, '.env'), text);
      const r = spawnSync('bash', ['-c', `${fn}\nenv_get ${key}`], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.replace(/\n$/, '');
    };
    const cases = [
      ['V=x', 'x'], ['V = x', 'x'], ['V: x', 'x'], ['V:x', 'x'], ['export V=x', 'x'], ['  export   V = x y  z  ', 'x y  z'], ['  V=x', 'x'],
      ['V=x # c', 'x'], ['V=x#c', 'x#c'], ['V= # c', '# c'], ["V='a b' # c", 'a b'], ['V="a b" # c', 'a b'], ['V="a # b"', 'a # b'], ['V=" x "', ' x '],
      ["V='a'b", 'a'], ['V=', ''], ['V=a=b', 'a=b'], ['V=a:b', 'a:b'], ['V:a=b', 'a=b'], ['V = "q"', 'q'], ['V=a\tb', 'a\tb'], ['V=a b  c', 'a b  c'],
      ['V="a\\"b"', 'a"b'], ['V="a\\\\b"', 'a\\b'], ["V='a\\nb'", 'a\\nb'], ['V=1\nV=2', '2'], ['V=x\r', 'x'], ['#V=x', ''], ['XV=x\nVX=y', ''],
    ];
    for (const [text, want] of cases) assert.equal(get(`${text}\n`), want, JSON.stringify(text));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('./receipts mode and the worker resolve data/settings.json the same way (every file x .env combination)', async () => {
  const { resolveDryRun, envDisagreement } = await import('./settings.js');
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-test-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const file = path.join(dir, 'data/settings.json');
  const nopy = noPythonBin(dir);
  // Exactly what the worker and the script write (and what the older design wrote): bash without python3 reads these.
  const written = [
    '{\n  "dryRun": false,\n  "changedAt": "2026-11-06T12:00:00.000Z",\n  "changedBy": "cli"\n}\n',
    '{\n  "dryRun": true,\n  "changedAt": "2026-11-06T12:00:00.000Z",\n  "changedBy": "status page"\n}\n',
    ...[true, false].flatMap((d) => [true, false, null].map((e) => JSON.stringify({ dryRun: d, envDryRun: e, changedBy: 'cli' }, null, 2))),
    '{"dryRun":false}', '{"dryRun":true}', ' {"dryRun" : false , "changedBy":"x"} \n',
  ];
  // Anything else: python3 and the worker must agree; without python3 it must come out dry (fail closed).
  const other = [
    '{nope', '', '[]', 'null', '5', '{}', '{"dryRun":"false"}', '{"dryRun":0}', '{"dryRun":null}', '{"dryRun":false,}', '﻿{"dryRun":false}', '{"dryRun":false,"x":NaN}',
    '{"dryRun":false,"envDryRun":"x"}', '{"dryRun":false,"n":1}', '{"dryRun":false,"n":1.5,"l":[1],"o":{"a":null}}', '{"dryRun":true,"dryRun":false}', '{"dryRun":false,"dryRun":true}',
    '{"dryRun":false,"envDryRun":5}', '{"changedBy":"x","dryRun":false}', '{"dryRun":false,"changedBy":"a\\u0041"}', '{"dryRun":false}{"dryRun":true}', '{"dryRun":false} x',
  ];
  const run = (envWord, PATH) => {
    fs.writeFileSync(path.join(dir, '.env'), `DRY_RUN=${envWord}\n`);
    const r = spawnSync('bash', ['-c', `${fn}\nmode; mode_note`], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...(PATH ? { PATH } : {}) } });
    assert.equal(r.status, 0, r.stderr);
    const [mode, ...note] = r.stdout.trim().split('\n');
    return { mode, note: note.join('\n') };
  };
  const place = (content) => {
    fs.rmSync(file, { recursive: true, force: true });
    if (typeof content === 'string') fs.writeFileSync(file, content);
    else if (content?.dangling) fs.symlinkSync(path.join(dir, 'nowhere'), file);
    else if (content?.dir) fs.mkdirSync(file);
    else if (content?.link) {
      fs.writeFileSync(path.join(dir, 'real.json'), content.link);
      fs.symlinkSync(path.join(dir, 'real.json'), file);
    }
  };
  try {
    const all = [null, ...written, ...other, { dangling: true }, { dir: true }, { link: '{"dryRun":false}' }];
    for (const content of all) {
      for (const envWord of ['true', 'false']) {
        place(content);
        const worker = resolveDryRun(envWord === 'true', file, () => {});
        const wantNote = envDisagreement(worker, envWord === 'true');
        const label = `file ${JSON.stringify(content)}, DRY_RUN=${envWord}`;
        const withPython = run(envWord);
        assert.equal(withPython.mode, worker.dryRun ? 'dry run' : 'live', label);
        assert.equal(withPython.note, wantNote ?? '', `note, ${label}`);
        const without = run(envWord, nopy);
        const strict = content === null || written.includes(content) || (typeof content === 'object' && content?.link !== undefined);
        if (strict) {
          assert.equal(without.mode, worker.dryRun ? 'dry run' : 'live', `no python3, ${label}`);
          assert.equal(without.note, wantNote ?? '', `no python3 note, ${label}`);
        } else {
          assert.equal(without.mode, 'dry run', `no python3 fails closed, ${label}`);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('./receipts: host_timezone picks timedatectl, then /etc/timezone, then the /etc/localtime link, else UTC', () => {
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-test-'));
  try {
    const etc = path.join(dir, 'etc');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(etc);
    fs.mkdirSync(bin);
    const stub = (name, body) => {
      fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    };
    const noTimedatectl = noPythonBin(dir); // tools only; no timedatectl
    const tz = (PATH) => {
      const r = spawnSync('bash', ['-c', `${fn}\nhost_timezone`], { encoding: 'utf8', env: { PATH, ETC_DIR: etc, HOME: dir } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(tz(noTimedatectl), 'UTC', 'nothing to read');
    fs.symlinkSync('/usr/share/zoneinfo/Europe/Berlin', path.join(etc, 'localtime'));
    assert.equal(tz(noTimedatectl), 'Europe/Berlin', 'the localtime link');
    fs.writeFileSync(path.join(etc, 'timezone'), 'Asia/Tokyo\n');
    assert.equal(tz(noTimedatectl), 'Asia/Tokyo', '/etc/timezone beats the link');
    stub('timedatectl', 'echo "America/Denver"');
    assert.equal(tz(`${bin}:${noTimedatectl}`), 'America/Denver', 'timedatectl first');
    stub('timedatectl', 'echo "n/a"');
    assert.equal(tz(`${bin}:${noTimedatectl}`), 'Asia/Tokyo', 'n/a from timedatectl is ignored');
    stub('timedatectl', 'exit 1');
    assert.equal(tz(`${bin}:${noTimedatectl}`), 'Asia/Tokyo', 'a failing timedatectl is ignored');
    fs.writeFileSync(path.join(etc, 'timezone'), 'not a zone!\n');
    fs.rmSync(path.join(etc, 'localtime'));
    fs.symlinkSync('/somewhere/else', path.join(etc, 'localtime'));
    assert.equal(tz(noTimedatectl), 'UTC', 'garbage is never written to .env');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the status page time zone defaults to UTC (no region leaks from the code), and .env.example says UTC', () => {
  assert.equal(load({}, 'm.config.trigger.timeZone').value, 'UTC');
  assert.equal(load({ TRIGGER_TIMEZONE: 'Europe/Berlin' }, 'm.config.trigger.timeZone').value, 'Europe/Berlin');
  const example = fs.readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
  assert.match(example, /^TRIGGER_TIMEZONE=UTC$/m);
  assert.doesNotMatch(example, /America\//);
  assert.doesNotMatch(fs.readFileSync(RECEIPTS, 'utf8'), /America\//);
  assert.doesNotMatch(fs.readFileSync(fileURLToPath(new URL('./config.js', import.meta.url)), 'utf8'), /America\//);
});

test('.env.example explains the new DRY_RUN rule', () => {
  const example = fs.readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
  assert.match(example, /data\/settings\.json is the\n# switch and DRY_RUN here is ignored/);
  assert.doesNotMatch(example, /your edit wins/);
});

test('CATEGORIZER: the old values are no longer used; d1 and decider stay quiet, others warn', () => {
  for (const v of ['d1', 'decider', 'D1']) assert.equal(load({ CATEGORIZER: v }, '1').warnings, '', v);
  assert.match(load({ CATEGORIZER: 'lfm3' }, '1').warnings, /CATEGORIZER="lfm3" is no longer used/);
});

test('DECIDER_PROVIDER: local by default, remote when asked, anything else warns and stays local', () => {
  assert.deepEqual(load({}, '[m.config.decider.provider, m.config.deciderUrl]'), { value: ['local', 'http://decider-gguf:8080'], warnings: '' });
  assert.deepEqual(load({ DECIDER_PROVIDER: ' Remote ', DECIDER_API_KEY: 'k' }, 'm.config.decider.provider'), { value: 'remote', warnings: '' });
  const bad = load({ DECIDER_PROVIDER: 'cloud', DECIDER_API_KEY: 'k' }, 'm.config.decider.provider');
  assert.equal(bad.value, 'local');
  assert.match(bad.warnings, /DECIDER_PROVIDER="cloud" is not one of local\|remote; using the local decider/);
});

test('remote decider settings: URL and model defaults; the key is required and never put in an error', () => {
  const r = load({ DECIDER_PROVIDER: 'remote', DECIDER_API_KEY: 'k1' }, '[m.config.deciderUrl, m.config.decider.remoteModel, m.config.decider.apiKey]');
  assert.deepEqual(r.value, ['https://api.typesafe.ai', 'jev-latest', 'k1']);
  assert.deepEqual(load({ DECIDER_PROVIDER: 'remote', DECIDER_API_KEY: 'k1', DECIDER_URL: 'https://x.test//', DECIDER_REMOTE_MODEL: 'jev-1.14.0' }, '[m.config.deciderUrl, m.config.decider.remoteModel]').value, ['https://x.test', 'jev-1.14.0']);
  const clean = { ...process.env, DECIDER_PROVIDER: 'remote' };
  delete clean.DECIDER_API_KEY;
  const missing = spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)})`], { env: clean, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing required setting DECIDER_API_KEY/);
});

test('local decider: DECIDER_URL in .env never redirects it (D1_GGUF_URL decides), and the remote settings are ignored', () => {
  const r = load({ DECIDER_URL: 'https://api.typesafe.ai', D1_GGUF_URL: 'http://decider-gguf:8080', DECIDER_API_KEY: 'k' }, '[m.config.deciderUrl, m.config.decider.apiKey]');
  assert.deepEqual(r.value, ['http://decider-gguf:8080', '']);
  assert.equal(load({ DECIDER_URL: 'https://api.typesafe.ai' }, 'm.config.deciderUrl').value, 'http://decider-gguf:8080');
});

test('PRIVATE_WORDS: comma-separated seed list', () => {
  assert.deepEqual(load({ PRIVATE_WORDS: ' Alex, Jo ,,Sam' }, 'm.config.privacy.seedWords').value, ['Alex', 'Jo', 'Sam']);
});

test('remote decider URL: https anywhere, plain http only for this machine; anything else is a startup error that does not print the key', () => {
  const env = (url) => ({ DECIDER_PROVIDER: 'remote', DECIDER_API_KEY: 'k-secret-1', DECIDER_URL: url });
  for (const ok of ['https://api.typesafe.ai', 'http://localhost:8080', 'http://127.0.0.1:9000', 'http://[::1]:9000']) {
    assert.equal(load(env(ok), 'm.config.deciderUrl').value, ok, ok);
  }
  for (const bad of ['http://api.typesafe.ai', 'http://192.0.2.5:8080', 'ftp://x.test', 'api.typesafe.ai']) {
    const r = spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)})`], { env: { ...process.env, ...env(bad) }, encoding: 'utf8' });
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /DECIDER_URL/, bad);
    assert.ok(!r.stderr.includes('k-secret-1'));
  }
  // the local decider ignores DECIDER_URL entirely, so an http value there is not an error
  assert.equal(load({ DECIDER_URL: 'http://api.typesafe.ai' }, 'm.config.deciderUrl').value, 'http://decider-gguf:8080');
});

test('LEARNING: on (default), record and off; anything else warns and uses on; MEMORY_DIR sets the folder', () => {
  assert.deepEqual(load({}, '[m.config.learning.mode, m.config.learning.dir.endsWith("memory")]'), { value: ['on', true], warnings: '' });
  for (const v of ['on', 'record', 'off', ' RECORD ']) assert.equal(load({ LEARNING: v }, 'm.config.learning.mode').value, v.trim().toLowerCase());
  const bad = load({ LEARNING: 'maybe' }, 'm.config.learning.mode');
  assert.equal(bad.value, 'on');
  assert.match(bad.warnings, /LEARNING="maybe" is not one of on\|record\|off/);
  assert.equal(load({ MEMORY_DIR: '/x/mem' }, 'm.config.learning.dir').value, '/x/mem');
});

test('READER_PROVIDER: local by default (LLM_URL decides), remote when asked, anything else warns and stays local', () => {
  assert.deepEqual(load({}, '[m.config.reader.provider, m.config.llmUrl, m.config.llmName]'), { value: ['local', 'http://llm:8080', 'Qwen3.5-4B'], warnings: '' });
  const remote = { READER_API_KEY: 'k', READER_URL: 'https://api.openai.com/v1', READER_MODEL: 'gpt-4.1-mini' };
  assert.equal(load({ READER_PROVIDER: ' Remote ', ...remote }, 'm.config.reader.provider').value, 'remote');
  const bad = load({ READER_PROVIDER: 'cloud', ...remote }, 'm.config.reader.provider');
  assert.equal(bad.value, 'local');
  assert.match(bad.warnings, /READER_PROVIDER="cloud" is not one of local\|remote; using the local reader/);
  // remote settings are ignored while local
  assert.deepEqual(load(remote, '[m.config.reader.apiKey, m.config.reader.model]').value, ['', '']);
});

test('remote reader: URL normalized to .../v1, key and model trimmed, name shown as model (remote: host)', () => {
  const env = (url) => ({ READER_PROVIDER: 'remote', READER_API_KEY: ' k1 ', READER_URL: url, READER_MODEL: ' gpt-4.1-mini ' });
  for (const [typed, want] of [
    ['https://api.openai.com/v1', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ['https://api.openai.com', 'https://api.openai.com/v1'],
    ['https://api.openai.com/', 'https://api.openai.com/v1'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
    ['https://openrouter.ai/api', 'https://openrouter.ai/api'], // a typed path is the provider's own and stays
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://api.openai.com/v1/chat/completions/', 'https://api.openai.com/v1'],
    ['https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1'],
    ['http://localhost:9000/v1', 'http://localhost:9000/v1'],
  ]) assert.equal(load(env(typed), 'm.config.reader.url').value, want, typed);
  const r = load(env('https://openrouter.ai/api/v1'), '[m.config.reader.apiKey, m.config.reader.model, m.config.reader.host, m.config.llmName]');
  assert.deepEqual(r.value, ['k1', 'gpt-4.1-mini', 'openrouter.ai', 'gpt-4.1-mini (remote: openrouter.ai)']);
});

test('remote reader: https is required (http only for this machine); a missing URL, key or model is a startup error that never prints the key', () => {
  const full = { READER_PROVIDER: 'remote', READER_API_KEY: 'k-secret-2', READER_URL: 'https://api.openai.com/v1', READER_MODEL: 'm' };
  const fails = (env) => spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)})`], { env: env, encoding: 'utf8' });
  for (const bad of ['http://api.openai.com/v1', 'http://192.0.2.5:8080', 'ftp://x.test', 'api.openai.com']) {
    const r = fails({ ...process.env, ...full, READER_URL: bad });
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /READER_URL/, bad);
    assert.ok(!r.stderr.includes('k-secret-2'));
  }
  for (const key of ['READER_URL', 'READER_API_KEY', 'READER_MODEL']) {
    for (const blank of [undefined, '   ']) {
      const env = { ...process.env, ...full };
      if (blank === undefined) delete env[key]; else env[key] = blank;
      const r = fails(env);
      assert.notEqual(r.status, 0, key);
      assert.match(r.stderr, new RegExp(`Missing required setting ${key}`), key);
      assert.ok(!r.stderr.includes('k-secret-2'));
    }
  }
});

test('./receipts: pick_services and wait_for leave out the llm service for a cloud reader, and the decider for a hosted one', () => {
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'), ['env_get', 'env_lower', 'remote_decider', 'remote_reader', 'pick_services', 'wait_for']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-test-'));
  try {
    const pick = (envText) => {
      fs.writeFileSync(path.join(dir, '.env'), envText);
      const r = spawnSync('bash', ['-c', `${fn}\npick_services; wait_for; echo "\${SERVICES[*]}|\${WAIT_FOR[*]}"`], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(pick('A=1\n'), 'llm decider-gguf worker|receipt-llm receipt-decider-gguf');
    assert.equal(pick('DECIDER_PROVIDER=remote\n'), 'llm worker|receipt-llm');
    assert.equal(pick('READER_PROVIDER=remote\n'), 'decider-gguf worker|receipt-decider-gguf');
    assert.equal(pick('READER_PROVIDER=Remote\nDECIDER_PROVIDER=remote\n'), 'worker|');
    assert.equal(pick('READER_PROVIDER=local\n'), 'llm decider-gguf worker|receipt-llm receipt-decider-gguf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readerBase: /v1 is added only to an address with no path; any path that was typed is kept; a trailing / or /chat/completions is dropped', async () => {
  const { readerBase } = await import('./config.js');
  for (const [typed, want] of [
    ['https://api.openai.com', 'https://api.openai.com/v1'],
    ['https://api.openai.com/', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1'],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://example.test/custom/chat/completions', 'https://example.test/custom'],
    ['https://example.test/chat/completions', 'https://example.test/v1'],
    ['http://localhost:11434', 'http://localhost:11434/v1'],
    ['  https://api.openai.com/v1  ', 'https://api.openai.com/v1'],
  ]) assert.equal(readerBase(typed), want, typed);
});

test('CLOUD_NAME_SCAN: both the hosted decider and a cloud reader are refused at startup (naming both settings) unless it is true', () => {
  const both = { READER_PROVIDER: 'remote', READER_API_KEY: 'k-secret-3', READER_URL: 'https://api.openai.com/v1', READER_MODEL: 'm', DECIDER_PROVIDER: 'remote', DECIDER_API_KEY: 'd-secret-3' };
  const run = (extra) => spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)}).then((m) => console.log(JSON.stringify(m.config.privacy.cloudNameScan)))`], { env: { ...process.env, ...both, ...extra }, encoding: 'utf8' });
  const refused = run({});
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /DECIDER_PROVIDER=remote/);
  assert.match(refused.stderr, /READER_PROVIDER=remote/);
  assert.match(refused.stderr, /CLOUD_NAME_SCAN=true/);
  assert.ok(!refused.stderr.includes('k-secret-3') && !refused.stderr.includes('d-secret-3'));
  assert.notEqual(run({ CLOUD_NAME_SCAN: 'false' }).status, 0);
  for (const yes of ['true', 'TRUE', '1', 'yes']) {
    const r = run({ CLOUD_NAME_SCAN: yes });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'true');
  }
  // either one alone needs no opt-in
  assert.equal(run({ DECIDER_PROVIDER: 'local' }).status, 0);
  assert.equal(run({ READER_PROVIDER: 'local' }).status, 0);
});

const compose = (fn, script, env) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), env);
    const r = spawnSync('bash', ['-c', `set -euo pipefail\nREMOTE_OVERLAY=compose.remote-decider.yaml\nREADER_OVERLAY=compose.remote-reader.yaml\nsay() { printf '%s\\n' "$*"; }\ndie() { echo "$*" >&2; exit 1; }\n${fn}\n${script}`], { cwd: dir, encoding: 'utf8' });
    return { out: r.stdout.trim(), err: r.stderr, status: r.status, env: fs.readFileSync(path.join(dir, '.env'), 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('./receipts: base_compose strips both the hosted-decider and the cloud-reader overlay before setup compares COMPOSE_FILE', () => {
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'), ['compose_without', 'base_compose']);
  const base = (list) => compose(fn, `base_compose '${list}'`, '').out;
  assert.equal(base('compose.yaml:compose.nvidia.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml'), 'compose.yaml:compose.nvidia.yaml');
  assert.equal(base('compose.yaml:compose.remote-reader.yaml'), 'compose.yaml');
  assert.equal(base('compose.yaml:compose.remote-reader.yaml:compose.small-gpu.yaml'), 'compose.yaml:compose.small-gpu.yaml');
  assert.equal(base('compose.yaml:compose.nvidia.yaml'), 'compose.yaml:compose.nvidia.yaml');
});

test('./receipts: compose_reader_last moves the cloud-reader overlay behind the hosted-decider one and leaves other lists alone', () => {
  const fns = ['env_get', 'env_set', 'env_unset', 'compose_without', 'compose_reader_last'];
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'), fns);
  const last = (envFile) => compose(fn, 'compose_reader_last', envFile).env.match(/^COMPOSE_FILE='?([^'\n]*)'?$/m)?.[1];
  assert.equal(last('COMPOSE_FILE=compose.yaml:compose.remote-reader.yaml:compose.remote-decider.yaml\n'), 'compose.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml');
  assert.equal(last('COMPOSE_FILE=compose.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml\n'), 'compose.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml');
  assert.equal(last('COMPOSE_FILE=compose.yaml:compose.nvidia.yaml\n'), 'compose.yaml:compose.nvidia.yaml');
});

test('./receipts start: sync_reader_overlay puts the cloud-reader file in COMPOSE_FILE exactly when the reader is remote, last, and says so in one line', () => {
  const fns = ['env_get', 'env_set', 'env_unset', 'env_lower', 'remote_reader', 'compose_without', 'compose_set', 'compose_add', 'compose_remove', 'compose_reader_last', 'sync_reader_overlay'];
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'), fns);
  const sync = (envFile) => {
    const r = compose(fn, 'sync_reader_overlay', envFile);
    assert.equal(r.status, 0, r.err);
    return { lines: r.out ? r.out.split('\n') : [], file: r.env.match(/^COMPOSE_FILE='?([^'\n]*)'?$/m)?.[1] };
  };
  // remote, overlay missing: added
  let r = sync('READER_PROVIDER=remote\nCOMPOSE_FILE=compose.yaml:compose.nvidia.yaml:compose.remote-decider.yaml\n');
  assert.equal(r.file, 'compose.yaml:compose.nvidia.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml');
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /READER_PROVIDER=remote: put compose\.remote-reader\.yaml in COMPOSE_FILE/);
  // remote, no COMPOSE_FILE at all
  r = sync('READER_PROVIDER=remote\n');
  assert.equal(r.file, 'compose.yaml:compose.remote-reader.yaml');
  // remote, overlay present but not last: moved
  r = sync('READER_PROVIDER=remote\nCOMPOSE_FILE=compose.yaml:compose.remote-reader.yaml:compose.remote-decider.yaml\n');
  assert.equal(r.file, 'compose.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml');
  assert.equal(r.lines.length, 1);
  // remote and already right: nothing said
  r = sync('READER_PROVIDER=remote\nCOMPOSE_FILE=compose.yaml:compose.remote-reader.yaml\n');
  assert.deepEqual(r.lines, []);
  // local with the overlay left in COMPOSE_FILE: taken out
  r = sync('READER_PROVIDER=local\nCOMPOSE_FILE=compose.yaml:compose.nvidia.yaml:compose.remote-reader.yaml\n');
  assert.equal(r.file, 'compose.yaml:compose.nvidia.yaml');
  assert.match(r.lines[0], /took compose\.remote-reader\.yaml out/);
  r = sync('COMPOSE_FILE=compose.yaml:compose.remote-reader.yaml\n');
  assert.equal(r.file, undefined, 'back to the default when nothing else is left');
  // local and already right: nothing said
  assert.deepEqual(sync('READER_PROVIDER=local\nCOMPOSE_FILE=compose.yaml:compose.nvidia.yaml\n').lines, []);
});

test('./receipts restart: sync_decider_overlay puts the hosted-decider file in COMPOSE_FILE exactly when the decider is remote, before the reader file, and says so in one line', () => {
  const fns = ['env_get', 'env_set', 'env_unset', 'env_lower', 'remote_decider', 'compose_without', 'compose_set', 'compose_add', 'compose_remove', 'compose_reader_last', 'sync_decider_overlay'];
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'), fns);
  const sync = (envFile) => {
    const r = compose(fn, 'sync_decider_overlay', envFile);
    assert.equal(r.status, 0, r.err);
    return { lines: r.out ? r.out.split('\n') : [], file: r.env.match(/^COMPOSE_FILE='?([^'\n]*)'?$/m)?.[1] };
  };
  // switched to local after the hosted setup: the overlay comes out, once, with one line
  let r = sync('DECIDER_PROVIDER=local\nCOMPOSE_FILE=compose.yaml:compose.nvidia.yaml:compose.remote-decider.yaml\n');
  assert.equal(r.file, 'compose.yaml:compose.nvidia.yaml');
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /DECIDER_PROVIDER is not remote: took compose\.remote-decider\.yaml out/);
  // back to the default when nothing else is left
  r = sync('COMPOSE_FILE=compose.yaml:compose.remote-decider.yaml\n');
  assert.equal(r.file, undefined);
  // the cloud-reader file stays when the decider goes local
  r = sync('DECIDER_PROVIDER=local\nCOMPOSE_FILE=compose.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml\n');
  assert.equal(r.file, 'compose.yaml:compose.remote-reader.yaml');
  // remote, overlay missing: added
  r = sync('DECIDER_PROVIDER=remote\nCOMPOSE_FILE=compose.yaml:compose.nvidia.yaml\n');
  assert.equal(r.file, 'compose.yaml:compose.nvidia.yaml:compose.remote-decider.yaml');
  assert.match(r.lines[0], /DECIDER_PROVIDER=remote: put compose\.remote-decider\.yaml in COMPOSE_FILE/);
  assert.equal(r.lines.length, 1);
  // remote with the reader file already there: the reader file is still last
  r = sync('DECIDER_PROVIDER=remote\nCOMPOSE_FILE=compose.yaml:compose.remote-reader.yaml\n');
  assert.equal(r.file, 'compose.yaml:compose.remote-decider.yaml:compose.remote-reader.yaml');
  // already right: nothing said
  assert.deepEqual(sync('DECIDER_PROVIDER=remote\nCOMPOSE_FILE=compose.yaml:compose.remote-decider.yaml\n').lines, []);
  assert.deepEqual(sync('DECIDER_PROVIDER=local\nCOMPOSE_FILE=compose.yaml:compose.nvidia.yaml\n').lines, []);
});

test('./receipts: valid_reader_url accepts https and http only for this machine', () => {
  const fn = bashFns(fs.readFileSync(RECEIPTS, 'utf8'), ['valid_reader_url']);
  const ok = (u) => compose(fn, `valid_reader_url '${u}' && echo yes || echo no`, '').out === 'yes';
  for (const u of ['https://api.openai.com/v1', 'https://x.test', 'http://localhost:9000/v1', 'http://127.0.0.1:8080', 'http://[::1]:8080/v1']) assert.equal(ok(u), true, u);
  for (const u of ['http://api.openai.com/v1', 'http://192.0.2.5:8080', 'api.openai.com', 'ftp://x.test', '', 'http://localhost.evil.test/v1']) assert.equal(ok(u), false, u);
});

test('LLM_NAME: Qwen3.5-4B by default, the model name from READER_LOCAL_MODEL when that is set, LLM_NAME wins', () => {
  const name = (env) => load(env, 'm.config.llmName').value;
  assert.equal(name({}), 'Qwen3.5-4B');
  assert.equal(name({ READER_LOCAL_MODEL: 'bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF:Q4_K_M' }), 'MiMo-V2.6-Distill-Qwen-9B');
  assert.equal(name({ READER_LOCAL_MODEL: ' unsloth/Qwen3.5-4B-GGUF ' }), 'Qwen3.5-4B');
  assert.equal(name({ READER_LOCAL_MODEL: 'org/Name' }), 'Name');
  assert.equal(name({ READER_LOCAL_MODEL: '' }), 'Qwen3.5-4B');
  assert.equal(name({ READER_LOCAL_MODEL: 'org/Name-GGUF:Q8_0', LLM_NAME: 'mine' }), 'mine');
});

// The model helpers in ./receipts shared by the reader and the decider (download, presence check, offline start).
const MODEL_FNS = ['env_get', 'model_setting', 'model_file', 'pick_mmproj', 'mmproj_file', 'model_present', 'decider_model', 'decider_present',
  'reader_is_default', 'reader_pinned_dir', 'download_file', 'fetch_pinned_reader', 'say', 'die', 'reader_model', 'reader_mmproj_want', 'reader_main_file', 'reader_mmproj_file', 'reader_present', 'reader_model_args', 'export_model_env', 'reader_name'];

function withModels(files, envText, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), envText);
    for (const f of files) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    const src = fs.readFileSync(RECEIPTS, 'utf8');
    const consts = src.split('\n').filter((l) => /^DEFAULT_(READER|DECIDER)/.test(l)).join('\n');
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${consts}\n${bashFns(src, MODEL_FNS)}\n${script}`], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PINNED = 'models/models--unsloth--Qwen3.5-4B-GGUF/snapshots/e87f176479d0855a907a41277aca2f8ee7a09523';
const PINNED_ARGS = '-m /models/models--unsloth--Qwen3.5-4B-GGUF/snapshots/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q8_0.gguf'
  + ' --mmproj /models/models--unsloth--Qwen3.5-4B-GGUF/snapshots/e87f176479d0855a907a41277aca2f8ee7a09523/mmproj-BF16.gguf';

test('./receipts: with READER_LOCAL_MODEL unset the reader gets exactly the pinned model and BF16 projector files, with no --offline', () => {
  const files = [`${PINNED}/Qwen3.5-4B-Q8_0.gguf`, `${PINNED}/mmproj-BF16.gguf`, `${PINNED}/mmproj-F16.gguf`];
  assert.equal(withModels(files, 'A=1\n', 'reader_model_args'), PINNED_ARGS);
  assert.equal(withModels(files, '', 'export_model_env; echo "$READER_MODEL_ARGS|[$READER_OFFLINE]"'), `${PINNED_ARGS}|[]`);
  assert.equal(withModels(files, 'A=1\n', 'reader_present && echo yes'), 'yes');
});

test('./receipts: the default reader is downloaded from the pinned revision into the pinned snapshot folder, and a newer snapshot never shadows it', () => {
  const REV = 'e87f176479d0855a907a41277aca2f8ee7a09523';
  // curl stand-in: records the URL and creates the file named by -o
  const curl = 'curl() { local o="" u=""; while (( $# )); do case "$1" in -o) o="$2"; shift ;; http*) u="$1" ;; esac; shift; done; echo "GET $u"; : > "$o"; }';
  const out = withModels([], '', `${curl}\nfetch_pinned_reader 2>&1; reader_present && echo present; reader_model_args`);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('GET')), [
    `GET https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/${REV}/Qwen3.5-4B-Q8_0.gguf`,
    `GET https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/${REV}/mmproj-BF16.gguf`,
  ]);
  assert.match(out, /present\n-m \/models\/models--unsloth--Qwen3\.5-4B-GGUF\/snapshots\/e87f/);
  // files that are already there are not fetched again
  assert.equal(withModels([`${PINNED}/Qwen3.5-4B-Q8_0.gguf`, `${PINNED}/mmproj-BF16.gguf`], '', `${curl}\nfetch_pinned_reader`), '');
  // a different snapshot of the same repo is not the default reader
  const other = 'models/models--unsloth--Qwen3.5-4B-GGUF/snapshots/main1';
  const files = [`${other}/Qwen3.5-4B-Q8_0.gguf`, `${other}/mmproj-BF16.gguf`];
  assert.equal(withModels(files, '', 'reader_present || echo missing; reader_model_args'), `missing\n${PINNED_ARGS}`);
  // naming the same model in READER_LOCAL_MODEL is a custom choice: llama.cpp resolves it (-hf)
  assert.equal(withModels([], 'READER_LOCAL_MODEL=unsloth/Qwen3.5-4B-GGUF:Q8_0\n', 'reader_model_args'), '-hf unsloth/Qwen3.5-4B-GGUF:Q8_0');
});

test('./receipts: a reader model that is not downloaded starts with -hf offline; one projector choice per model', () => {
  assert.equal(withModels([], 'A=1\n', 'reader_present || echo missing'), 'missing');
  assert.equal(withModels([], 'READER_LOCAL_MODEL=bartowski/X-GGUF:Q4_K_M\n', 'reader_model_args; export_model_env; echo "$READER_OFFLINE"'), '-hf bartowski/X-GGUF:Q4_K_M\n--offline');
  // the default model is never loaded through -hf (that would follow `main`): not downloaded yet, it still gets the pinned paths
  assert.equal(withModels([], '', 'reader_model_args'), PINNED_ARGS);
  // a fetch with a projector chosen by name turns llama.cpp's own pick off
  assert.equal(withModels([], 'READER_LOCAL_MODEL=o/M-GGUF:Q4_K_M\nREADER_LOCAL_MMPROJ=F16\n', 'reader_model_args fetch'), '-hf o/M-GGUF:Q4_K_M --no-mmproj');
  assert.equal(withModels([], 'READER_LOCAL_MODEL=o/M-GGUF:Q4_K_M\n', 'reader_model_args fetch'), '-hf o/M-GGUF:Q4_K_M');
});

test('./receipts: a downloaded custom reader is loaded by path, with the preferred projector or the one READER_LOCAL_MMPROJ names', () => {
  const snap = 'models/models--bartowski--M-GGUF/snapshots/abc';
  const files = [`${snap}/M-Q4_K_M.gguf`, `${snap}/M-Q8_0.gguf`, `${snap}/mmproj-M-f32.gguf`, `${snap}/mmproj-M-f16.gguf`];
  const env = 'READER_LOCAL_MODEL=bartowski/M-GGUF:Q4_K_M\n';
  assert.equal(withModels(files, env, 'reader_model_args'), '-m /models/models--bartowski--M-GGUF/snapshots/abc/M-Q4_K_M.gguf --mmproj /models/models--bartowski--M-GGUF/snapshots/abc/mmproj-M-f16.gguf');
  assert.match(withModels(files, `${env}READER_LOCAL_MMPROJ=f32\n`, 'reader_model_args'), /--mmproj \/models\/.*mmproj-M-f32\.gguf$/);
  assert.match(withModels(files, `${env}READER_LOCAL_MMPROJ=mmproj-M-f16.gguf\n`, 'reader_model_args'), /--mmproj \/models\/.*mmproj-M-f16\.gguf$/);
  assert.equal(withModels(files, env, 'reader_name'), 'bartowski/M-GGUF:Q4_K_M (M-Q4_K_M.gguf, projector mmproj-M-f16.gguf)');
});

test('./receipts: a model without a projector is not a ready reader (it cannot read images), but is a present decider', () => {
  const snap = 'models/models--o--Text-GGUF/snapshots/abc';
  const env = 'READER_LOCAL_MODEL=o/Text-GGUF:Q8_0\nDECIDER_MODEL=o/Text-GGUF:Q8_0\n';
  const files = [`${snap}/Text-Q8_0.gguf`];
  assert.equal(withModels(files, env, 'reader_present || echo no-projector; decider_present && echo decider-ok'), 'no-projector\ndecider-ok');
  assert.match(withModels(files, env, 'reader_name'), /projector missing\)$/);
});

test('./receipts: decider_present keeps its rules (quant match, projector files do not count) and the setting order is environment, .env, default', () => {
  const snap = 'models/models--LiquidAI--d1-2B-GGUF/snapshots/abc';
  const files = [`${snap}/d1-2B-Q8_0.gguf`, `${snap}/mmproj-d1-2B-Q8_0.gguf`];
  assert.equal(withModels(files, '', 'decider_present && echo yes'), 'yes');
  assert.equal(withModels(files, 'DECIDER_MODEL=LiquidAI/d1-2B-GGUF:Q4_K_M\n', 'decider_present || echo no'), 'no');
  assert.equal(withModels([`${snap}/mmproj-d1-2B-Q8_0.gguf`], '', 'decider_present || echo no'), 'no');
  assert.equal(withModels([], 'DECIDER_MODEL=a/b:Q1\n', 'DECIDER_MODEL=x/y:Q2 decider_model'), 'x/y:Q2');
  assert.equal(withModels([], 'DECIDER_MODEL=a/b:Q1\n', 'decider_model'), 'a/b:Q1');
  assert.equal(withModels([], '', 'decider_model'), 'LiquidAI/d1-2B-GGUF:Q8_0');
});

test('./receipts: pick_mmproj prefers BF16, then F16, then F32, and a name or quant wins when given', () => {
  const pick = (names, want = '') => withModels([], '', `printf '%s\\n' ${names.map((n) => `'${n}'`).join(' ')} | pick_mmproj '${want}'`);
  assert.equal(pick(['a/mmproj-F32.gguf', 'a/mmproj-F16.gguf', 'a/mmproj-BF16.gguf', 'a/M-Q4.gguf']), 'a/mmproj-BF16.gguf');
  assert.equal(pick(['mmproj-F32.gguf', 'mmproj-F16.gguf']), 'mmproj-F16.gguf');
  assert.equal(pick(['mmproj-F32.gguf', 'M-Q4.gguf']), 'mmproj-F32.gguf');
  assert.equal(pick(['mmproj-F32.gguf', 'mmproj-F16.gguf'], 'f32'), 'mmproj-F32.gguf');
  assert.equal(pick(['M-Q4.gguf', 'README.md']), '');
  assert.equal(pick(['mmproj-F16.gguf'], 'Q8'), '');
});

test('siteUrl: an Actual or Nextcloud address typed without a scheme means https; a typed scheme and path are kept', async () => {
  const { siteUrl } = await import('./config.js');
  for (const [typed, want] of [
    ['budget.example.com', 'https://budget.example.com'],
    [' cloud.example.com/ ', 'https://cloud.example.com'],
    ['cloud.example.com:8443/nextcloud', 'https://cloud.example.com:8443/nextcloud'],
    ['http://host.docker.internal:5006', 'http://host.docker.internal:5006'],
    ['https://budget.example.com/', 'https://budget.example.com'],
    ['HTTPS://Budget.example.com', 'HTTPS://Budget.example.com'],
  ]) assert.equal(siteUrl(typed), want, typed);
});
