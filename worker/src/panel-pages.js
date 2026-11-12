// The HTML of the control panel, by page. The pages live in their own modules; this is the one place trigger.js and the tests
// import them from. Pure functions: data in, string out; trigger.js fetches the data and serves the page. Everything
// user-controlled goes through escape().
export { escape, layout, withFrame, currentFrame, CSP } from './panel-layout.js';
export { statusPage, goLivePage, cleanNav, navQuery, orderFor, receiptNav } from './panel-status.js';
export { archivedPage, archiveAllPage, archivedNav } from './panel-archive-page.js';
export { receiptPage, whatToDo, dateUsed, taxLine } from './panel-receipt-page.js';
export { categoriesPage, keywordsPage, learnedPage } from './panel-lists.js';
export { settingsPage, settingsSection, SETTINGS_SECTIONS, cleanFrom } from './panel-settings-page.js';
export { privacyPage } from './panel-privacy-page.js';
