// Saved readings for replay (--save-readings / --readings): <name>.read.json, plus the older <name>.lfm3-read.json
// files that may still be in a folder. Other *-read.json files are not picked up.
const SUFFIXES = ['.read.json', '.lfm3-read.json'];

/** From a folder listing: [{ file, name }] sorted by name, one per base name (.read.json wins over .lfm3-read.json). */
export function readingFiles(fileNames) {
  const byName = new Map();
  for (const file of fileNames) {
    const suffix = SUFFIXES.find((s) => file.endsWith(s));
    if (!suffix) continue;
    const name = file.slice(0, -suffix.length);
    if (!byName.has(name) || suffix === SUFFIXES[0]) byName.set(name, { file, name });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const readingFileName = (name) => `${name}${SUFFIXES[0]}`;
