// Edits data/web-settings.json (the Settings tab's file) from the command line. Used by ./receipts exclude so that a value it
// writes to .env is not hidden by an older one set on the status page.
// Usage: docker compose run --rm --no-deps worker node src/web-settings-cli.js unset KEY [KEY...]
//   get    print each key's current value, from the status page if it set one, else .env, as "value<TAB>KEY<TAB>value" lines
//          (the tag tells them from other output). Secrets and keys outside the Settings tab are refused.
//   unset  remove those keys from the file, so the .env value applies again; prints one "unset KEY" line for each key that was set
import './private-umask.js';
import { SETTINGS_BY_KEY, isSecret } from './web-settings-schema.js';
import { loadOverrides, unsetOverrides, effectiveSetting } from './web-settings.js';

const [command, ...keys] = process.argv.slice(2);
if (!['get', 'unset'].includes(command) || keys.length === 0) {
  console.error('usage: node src/web-settings-cli.js get|unset KEY [KEY...]');
  process.exit(2);
}
const unknown = keys.filter((k) => !SETTINGS_BY_KEY.has(k));
if (unknown.length) {
  console.error(`not a setting of the Settings tab: ${unknown.join(', ')}`);
  process.exit(2);
}
if (command === 'get') {
  const secrets = keys.filter(isSecret);
  if (secrets.length) {
    console.error(`${secrets.join(', ')}: a password is never printed`);
    process.exit(2);
  }
  const overrides = loadOverrides();
  for (const key of keys) console.log(`value\t${key}\t${effectiveSetting(key, overrides).value}`);
  process.exit(0);
}
if (loadOverrides().damaged) {
  console.error('data/web-settings.json is damaged; reset it from the status page (Settings, Reset all to .env)');
  process.exit(1);
}
for (const key of await unsetOverrides(keys)) console.log(`unset ${key}`);
