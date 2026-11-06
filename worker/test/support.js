// Test support for modules that import @actual-app/api or webdav, which are installed only in the Docker image.
// Import this file first, then load the module under test with a dynamic import():
//   import '../test/support.js';
//   const { chooseAction } = await import('./index.js');
// It swaps both packages for empty stand-ins (an empty budget: no accounts, payees or transactions).
import fs from 'node:fs';
import { register, syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

const STUBS = {
  '@actual-app/api': `
    const empty = async () => [];
    export default { init: async () => {}, downloadBudget: async () => {}, shutdown: async () => {}, getAccounts: empty,
      getPayees: empty, getCategories: empty, getCategoryGroups: empty, getRules: empty, getTransactions: empty,
      updateTransaction: async () => {} };`,
  webdav: 'export const createClient = () => ({});',
};
const hooks = `
  const stubs = ${JSON.stringify(STUBS)};
  export async function resolve(specifier, context, next) {
    if (specifier in stubs) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    return next(specifier, context);
  }`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

// actual.js reads the installed API version from node_modules.
const realRead = fs.readFileSync;
mock.method(fs, 'readFileSync', (file, ...rest) => {
  if (String(file).endsWith('node_modules/@actual-app/api/package.json')) return JSON.stringify({ version: '26.8.0' });
  return realRead(file, ...rest);
});
syncBuiltinESMExports();
