// Render real native controls with the shipped CSS and synthetic values only.
// node --env-file=worker/test.env worker/test/dropdown-theme-checks.mjs
// Inspect the generated page in light/dark mode at desktop and phone widths.
import fs from 'node:fs';
import { workspaceFixtures } from './workspace-fixtures.js';
import { layout } from '../src/panel-layout.js';

const fixture = await workspaceFixtures();
try {
  const lightNative = process.argv.includes('--light-native-menus');
  const category = fixture.renderReceipt().match(/<select\b[^>]*name="c0"[^]*?<\/select>/)[0];
  const settings = [...fixture.settingsSectionsHtml.matchAll(/<select\b[^>]*>[^]*?<\/select>/g)].map((m) => m[0]);
  const renamed = (html, id, expanded = false) => html.replace(/\s(?:id|name|aria-describedby|aria-label)="[^"]*"/g, '')
    .replace('<select', `<select id="${id}"${expanded ? ' size="10"' : ''}`);
  const groups = '<optgroup label="Other categories"><option>Household (excluded)</option><option>Transport (excluded)</option></optgroup>';
  const fullCategory = category.replace('</select>', `${groups}</select>`);
  const body = `<h2>Category selection</h2><div class="dropdown-proof"><section><div class="workspace-editor"><label for="category-closed">Category</label>${renamed(fullCategory, 'category-closed')}</div><label for="category-expanded">Expanded native category list</label>${renamed(fullCategory, 'category-expanded', true)}</section><section><label for="account-closed">Cash account</label>${renamed(settings[0], 'account-closed')}<label for="preference-expanded">Expanded native preference list</label>${renamed(settings[1], 'preference-expanded', true)}</section></div>`;
  let html = layout({ active: 'status', key: 'fixture-key', body });
  html = html.replace('</head>', '<style>.dropdown-proof{display:grid;grid-template-columns:1fr 1fr;gap:24px}.dropdown-proof label{margin-top:20px}.dropdown-proof select[size]{height:auto}@media(max-width:600px){.dropdown-proof{grid-template-columns:1fr}}</style></head>')
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function () { (${checks.toString()})(${lightNative}); });</script></body>`);
  if (lightNative) html = html.replace('</head>', '<style>select{color-scheme:light}</style></head>');
  const file = `/tmp/receipt-dropdown-theme-checks${lightNative ? '-light-native' : ''}.html`;
  fs.writeFileSync(file, html);
  console.log(file);
} finally { fixture.cleanup(); }

function checks(lightNative) {
  const failures = [];
  const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const luminance = (value) => rgb(value).map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  const ratio = (foreground, background) => {
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  const theme = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
  const controls = [...document.querySelectorAll('.dropdown-proof select')];
  let minimum = Infinity;
  for (const select of controls) {
    if (getComputedStyle(select).colorScheme !== (lightNative ? 'light' : theme)) failures.push('Native scheme mismatch: ' + select.id);
    if (getComputedStyle(select).backgroundColor === 'rgba(0, 0, 0, 0)') failures.push('Transparent select surface: ' + select.id);
    for (const option of select.querySelectorAll('option,optgroup')) {
      const css = getComputedStyle(option);
      if (css.backgroundColor === 'rgba(0, 0, 0, 0)' || css.backgroundColor === 'transparent') failures.push('Transparent menu surface: ' + option.textContent);
      const contrast = ratio(css.color, css.backgroundColor);
      minimum = Math.min(minimum, contrast);
      if (contrast < 4.5) failures.push('Unreadable menu text: ' + option.textContent + ' ratio=' + contrast);
    }
  }
  const select = document.getElementById('category-expanded');
  select.value = 'Daily / Gifts';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  if (select.value !== 'Daily / Gifts') failures.push('Category selection stopped working');
  const option = select.selectedOptions[0], css = getComputedStyle(option);
  if (ratio(css.color, css.backgroundColor) < 4.5) failures.push('Selected category unreadable');
  if (document.documentElement.scrollWidth > innerWidth) failures.push('Horizontal overflow');
  console.log('DROPDOWN_THEME_RESULT ' + JSON.stringify({ theme, lightNative, width: innerWidth, controls: controls.length, minimumContrast: Number(minimum.toFixed(2)), failures }));
  if (failures.length) console.error(failures.join('; '));
}
