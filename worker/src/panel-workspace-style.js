// The approved ledger workspace. Legacy component rules stay available to secondary pages.
export const WORKSPACE_CSS = `
.app-header-actions{flex-shrink:0}.app-header summary{white-space:nowrap}.app-header .header-more>summary{padding-inline:9px}
.workspace-ready [data-preview-fragment] [data-commit-button]{display:none}.workspace-ready [data-preview-fragment] form[data-commit]>details{margin-top:12px}.workspace-editor .preview-choices{display:flex;gap:8px;flex-wrap:wrap}.workspace-ready [data-cash-preview] form{display:none}.app-dialog-body [data-cash-preview] form{display:block}.app-dialog-body [data-commit-button]{display:inline-flex!important}.app-dialog-body .standard-page{padding:0}.app-dialog:has(#settings-page){width:min(760px,calc(100% - 32px))}.app-dialog-body #settings-page .settings-heading{display:none}
/* Native popup menus need an opaque surface; a transparent select cannot supply it. */
select option,select optgroup{background-color:var(--surface);color:var(--fg)}
select option:checked{background-color:var(--accent);color:var(--accent-fg)}
select option:disabled{color:var(--muted)}
select option:disabled:checked{background-color:var(--surface);color:var(--muted)}
@media(forced-colors:active){select option,select optgroup{background-color:Canvas;color:CanvasText}select option:checked{background-color:Highlight;color:HighlightText}select option:disabled{color:GrayText}}
body,body.wide{max-width:none;margin:0;padding:0;background:var(--bg);font-size:15px;line-height:1.45}
button,.btn,input,select,textarea{border-radius:6px}button,.btn{font-size:13px;min-height:40px;margin:0;font-weight:600}button.plain,.btn.plain{color:var(--fg)}
button.link{font-size:12px;color:var(--muted)}
.app-header{display:flex;align-items:center;justify-content:flex-end;gap:16px;padding:12px 24px;border-bottom:1px solid var(--line)}

.app-header-actions{display:flex;align-items:center;gap:8px}.app-header details{position:relative}.app-header summary{cursor:pointer;list-style:none;min-height:40px;display:flex;align-items:center;padding:0 12px;border:1px solid var(--line);font-weight:600;font-size:13px}.app-header summary::-webkit-details-marker{display:none}
.header-menu{position:absolute;right:0;top:calc(100% + 6px);background:var(--surface);border:1px solid var(--line);z-index:20;min-width:230px;padding:8px;box-shadow:0 8px 20px #0001}
.header-menu a{display:block;padding:9px;color:var(--fg);text-decoration:none}.header-menu a:hover{background:color-mix(in srgb,var(--fg) 4%,var(--bg))}
.header-upload{min-width:min(340px,calc(100vw - 32px));padding:16px}.header-upload p{font-size:12px;color:var(--muted)}.header-upload .btn{width:100%}
.app-main{min-width:0}.standard-page{max-width:960px;margin:auto;padding:30px 32px}.standard-page>h2:first-child{font-size:32px;letter-spacing:-1px;margin-top:0}
.notice{border:0;border-bottom:1px solid var(--line);border-radius:8px;margin:0;padding:16px 32px;background:transparent}.notice.err{color:var(--bad)}.notice.warn{color:var(--warn)}
.workspace-shell{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:660px}
.queue-rail{min-width:0;border-right:1px solid var(--line)}
.workspace-detail{min-width:0;padding:30px 32px}.workspace-title{display:flex;justify-content:space-between;gap:20px;align-items:baseline}.workspace-title h2{font-size:26px;line-height:1.2;font-weight:650;letter-spacing:normal;margin:0}.workspace-total{font-size:26px;font-weight:700;letter-spacing:normal;white-space:nowrap;font-variant-numeric:tabular-nums}.workspace-meta{font-size:13px;color:var(--muted);margin-top:12px}.workspace-back{display:none;color:var(--muted);font-size:12px;text-decoration:none;margin-bottom:18px}
.receipt-grid.has-resolution>.workspace-editor{grid-column:2;grid-row:1}.receipt-grid.has-resolution>.receipt-photos{grid-column:1;grid-row:1}
.receipt-grid{grid-template-columns:minmax(210px,260px) minmax(0,1fr);gap:32px;align-items:start}.receipt-photos{position:static;max-height:none;overflow:visible}.workspace-section-title{font-size:12px!important;text-transform:uppercase;letter-spacing:1px;font-weight:600;color:var(--muted);margin:0 0 16px!important}.photo{border:0;border-radius:8px;margin:0 0 12px}.receipt-photo-wrap{background:color-mix(in srgb,var(--fg) 4%,var(--bg));padding:10px}.receipt-photo-toggle>summary{display:none}
.editor-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.editor-heading h2{margin:0!important}.receipt-more{position:relative}.receipt-more>summary{cursor:pointer;border:1px solid var(--line);padding:10px 12px;list-style:none;font-size:13px;font-weight:600}.receipt-more-panel{position:absolute;right:0;top:calc(100% + 4px);z-index:10;min-width:260px;max-width:calc(100vw - 48px);padding:12px;background:var(--surface);border:1px solid var(--line);box-shadow:0 8px 20px #0001}.receipt-more-panel form{margin:0}.receipt-more-panel button,.receipt-more-panel a{display:block;width:100%;text-align:left;justify-content:flex-start;background:none;border:0;color:var(--fg);padding:9px 8px;min-height:40px;text-decoration:none}.receipt-more-panel p{font-size:12px;color:var(--muted)}
.workspace-editor .scroll{overflow:visible}

.workspace-editor .item-note{font-size:12px;color:var(--muted)}.workspace-editor .item-note>summary{cursor:pointer;font-size:12px;color:var(--muted);min-height:24px}.workspace-editor .item-note p{font-size:12px;margin:4px 0}.workspace-editor .item-edit-hint{font-size:12px;color:var(--muted);margin-top:4px}.workspace-editor .item-edit-hint button{font-size:12px;text-decoration:underline;background:none;border:0;color:var(--muted);padding:0;min-height:24px;font-weight:400}
.workspace-editor details.how{border:0;border-top:1px solid var(--line);border-radius:8px;padding:0;margin:0}.workspace-editor details.how>summary{font-size:12px;color:var(--muted);font-weight:500}.workspace-editor>form>p:last-child{margin:24px 0 0}.editor-actions{border-top:1px solid var(--line);margin-top:24px;padding-top:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.editor-actions p{margin:0;color:var(--muted);font-size:12px}.editor-actions .buttons{margin-left:auto;display:flex;gap:8px}.editor-message{font-size:13px;color:var(--muted);margin:10px 0}.editor-message[role=alert]{color:var(--bad)}
.split-preview details{margin-top:12px;font-size:12px;color:var(--muted)}.split-preview summary{cursor:pointer;min-height:24px}.split-preview .banner{font-size:12px;border:0;border-radius:8px;background:var(--warnbg)}.commit-preview{margin-top:16px}.commit-preview>form{margin-top:12px}.commit-preview details{font-size:12px}.preview-choices{display:flex;flex-wrap:wrap;gap:8px}.preview-choices form{margin:0}
.workspace-details{border-top:1px solid var(--line);margin-top:24px;padding-top:12px;color:var(--muted);font-size:12px}.workspace-details summary{cursor:pointer;min-height:32px}.workspace-details .how{border:0;padding:0}.workspace-details h2{font-size:14px}
.status-overview{padding:30px 32px}.status-overview h2{font-size:32px;letter-spacing:-1px;margin:0 0 12px}.status-overview .statusbar{margin-bottom:24px}.status-advanced{margin-top:24px}.status-advanced>summary{font-size:13px;cursor:pointer;min-height:40px}.status-overview .actions-bar{display:none}.status-overview .banner{border-radius:8px}
.settings-page{max-width:760px}.settings-heading{font-size:26px;font-weight:650;letter-spacing:normal}.settings-intro{display:none}.settings-shortcuts{display:none}.settings-grid{display:block}.settings-card{border:0;border-top:1px solid var(--line);padding:0;border-radius:8px}.settings-card>summary{margin:0;padding:16px 0;min-height:52px;list-style-position:inside}.settings-card-description{display:inline;font-size:13px;margin-left:8px}.settings-save{padding:16px 0}.setting-options>summary{font-size:12px}.settings-page .setting{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,190px);gap:6px 18px;padding:16px 0;border-top:1px solid var(--line)}.settings-page .setting>label{align-self:center;font-size:14px}.settings-page .setting>input,.settings-page .setting>select{font-size:14px;min-height:36px;border-radius:6px}.settings-page .setting .check{display:contents}.settings-page .setting .check label{grid-column:1;grid-row:1}.settings-page .setting .check input[type=checkbox]{grid-column:2;grid-row:1;justify-self:end}.settings-page .setting-hint,.settings-page .setting-options{grid-column:1/-1;margin:0;font-size:12px}.settings-page .setting-options .help{max-width:65ch}.settings-page .setting.wide{grid-template-columns:minmax(0,1fr)}.settings-page .setting.wide>*{grid-column:1}.settings-page details.how{border:0;border-top:1px solid var(--line);border-radius:8px;padding:0}.settings-page .settings-section-label{font-size:12px;text-transform:uppercase;letter-spacing:1px}.settings-everyday{padding:0 0 24px}.settings-everyday>form{margin:0}.settings-everyday .settings-save{border:0}.settings-rules-links{display:flex;gap:16px;flex-wrap:wrap;font-size:13px}
.banner,.card,.todo,.how{border-radius:8px}.pill{border-radius:4px}.pill{background:none!important;color:var(--muted)!important;padding:0}.todo{background:none!important}.standard-page nav{margin:0}
.app-dialog{width:min(560px,calc(100% - 32px));max-height:calc(100% - 32px);padding:20px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg)}.app-dialog::backdrop{background:#0006}.app-dialog-head{display:flex;justify-content:space-between;align-items:center;gap:16px;position:sticky;top:0;background:var(--surface);padding-bottom:12px}.app-dialog-head h2{margin:0;font-size:20px}.app-dialog-body{font-size:14px}.app-dialog-body table{font-size:13px}.app-dialog-body form{margin-top:12px}
@media(max-width:1023px){.receipt-grid.has-resolution>.workspace-editor,.receipt-grid.has-resolution>.receipt-photos{grid-column:auto;grid-row:auto}.workspace-shell{display:block;min-height:0}.workspace-shell.has-receipt>.queue-rail{display:none}.queue-rail{border-right:0;padding:24px 16px;max-width:760px;margin:auto}.workspace-detail{padding:20px 16px}.receipt-grid{grid-template-columns:minmax(0,1fr)}.status-overview{display:block;padding:20px 16px 24px}.status-landing{display:none}.standard-page{padding:24px 16px}.app-header{padding:12px 16px}.app-header-actions{gap:6px}.app-header summary,.app-header .btn{padding:0 9px}.receipt-grid{gap:18px}.workspace-editor .scroll{overflow:hidden}}
@media(max-width:719px){.workspace-title{display:block}.workspace-title h2{font-size:32px;letter-spacing:-1.2px}.workspace-total{display:block;margin-top:8px;font-size:28px}.workspace-meta{margin-top:8px}.settings-card-description{display:block;margin-left:0}.app-header .header-more>summary{font-size:12px}.workspace-details table{font-size:12px}}

/* Visible controls and keyboard access share the same treatment in both themes. */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.skip-link{position:absolute;left:16px;top:8px;transform:translateY(-200%);z-index:100;background:var(--surface);color:var(--fg);padding:12px 16px;border:2px solid var(--focus)}.skip-link:focus{transform:none}
.app-header nav{margin:0;padding:0;border:0;flex-wrap:wrap;justify-content:flex-end}.app-header nav a.btn{border-bottom-width:1px;color:var(--fg)}
.app-header summary,.app-header .btn,button,.btn,.receipt-more>summary,.receipt-more-panel a,.receipt-more-panel button,.workspace-details>summary,.workspace-back{min-height:44px}
.app-header summary,.app-header .btn{border-color:var(--control)}
.workspace-back{align-content:center}.workspace-editor input.amt,.workspace-editor select.pick,.settings-page .setting>input,.settings-page .setting>select{min-height:44px;height:auto;border-bottom-color:var(--control)}
.workspace-editor input.amt,.workspace-editor select.pick{height:44px;font-size:14px}.workspace-editor input[aria-invalid=true]{border-bottom-color:var(--bad)}
.workspace-editor select.pick{background-color:var(--surface)}

.workspace-editor .item-edit-hint button,.workspace-editor .item-edit-hint a{display:inline-flex;align-items:center;min-height:44px;padding-inline:4px}
button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.app-dialog-head{z-index:1}.app-dialog-body :focus-visible{scroll-margin-block:76px}
button.small,button.link,.btn.small,.workspace-editor .item-note>summary,.split-preview summary,.settings-page .setting-options>summary{min-height:44px}
.settings-page .setting-options>summary{line-height:1.5;padding-block:10px}
.settings-page .setting input[type=checkbox]{width:24px;height:24px;min-height:24px;align-self:center}.settings-page .setting .check label{display:flex;align-items:center;min-height:44px}
.workspace-title h2{overflow-wrap:anywhere}.app-dialog-body{overflow-wrap:anywhere}
@media(max-width:1023px){.workspace-editor .scroll{overflow:visible}.workspace-editor input.amt,.workspace-editor select.pick,.settings-page input,.settings-page select,.settings-page textarea,.resolution-fields input,.resolution-fields select{font-size:16px}}
@media(forced-colors:active){.queue-row[aria-current=page]{outline:2px solid Highlight}.workspace-editor input.amt,.workspace-editor select.pick{border-bottom:1px solid ButtonText}}
/* Approved shapes and token aliases also cover the legacy secondary pages. */
button,.btn,input[type=text],input[type=date],input[type=password],input[type=number],select,textarea,.app-header summary,.receipt-more>summary{border-radius:6px;border-color:var(--line-strong)}
.workspace-editor input.amt,.workspace-editor select.pick{border:1px solid var(--line-strong);border-radius:6px;background:var(--card)}
.banner,.card,.todo,details.how,.notice,.workspace-status,.settings-card,.app-dialog,.header-menu,.receipt-more-panel,.split-preview .banner{border-radius:8px}
.workspace-editor input[aria-invalid=true]{border-bottom:2px solid var(--bad);color:var(--bad);background:var(--badbg)}
.tag,.badge,.chip,.pill{border-radius:4px}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) img.photo{filter:brightness(.85)}}
:root[data-theme="dark"] img.photo{filter:brightness(.85)}


/* P6: the Items & categories card, its rows, the split (an SVG bar and a legend) and the action footer. */
.workspace-editor{container:editor / inline-size;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--card);box-shadow:var(--shadow)}
.edhead{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:6px}
.card-title{margin:0;font-size:18px;letter-spacing:0;font-weight:650}
.bulk-categories{display:flex;align-items:center;margin:0}.workspace-editor .bulk-categories select.pick{width:auto;min-width:180px;max-width:100%}
.quiet-note{margin:0 0 8px;font-size:13.5px;color:var(--muted)}.quiet-note b{display:block}.quiet-note .notice{margin:0;padding:0;border:0;color:var(--muted);font-size:13.5px}
.workspace-editor table.items{font-size:14px}.workspace-editor .items thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.workspace-editor .items,.workspace-editor .items tbody{display:block}
.workspace-editor .items tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.workspace-editor .items tr:first-child{border-top:0}
.workspace-editor .items td{display:block;min-width:0;padding:0;border:0;overflow-wrap:anywhere}
.workspace-editor .items td:nth-child(1){grid-column:1;grid-row:1}.workspace-editor .items td:nth-child(2){display:none}.workspace-editor .items td:nth-child(3){grid-column:2;grid-row:1;text-align:right}.workspace-editor .items td:nth-child(4){grid-column:1/-1;grid-row:2}
.workspace-editor .items select.pick{width:100%;height:44px}
.workspace-editor .items input.amt{width:110px;height:44px;text-align:right}
.workspace-editor .items .tax-code{display:block}
.workspace-editor .items tr.chg{box-shadow:inset 3px 0 0 var(--accent);padding-left:10px}
.workspace-editor .nm{font-weight:600}
.workspace-editor .sub{margin-top:2px;font-size:13.5px;color:var(--muted)}
.nsure{display:inline-block;margin-right:6px;padding:1px 8px;border:1px solid var(--line);border-radius:4px;background:var(--attn-soft);color:var(--attn-fg);font-size:12px;font-weight:700}
.workspace-editor .item-edit-hint{margin-top:2px}.workspace-editor .item-edit-hint button.linkbtn,.workspace-editor .item-edit-hint a{display:inline-flex;align-items:center;min-height:44px;padding:0 2px;font-size:13.5px}
.linkbtn{border:0;background:none;color:var(--accent);font-weight:700;text-decoration:underline;cursor:pointer}
.workspace-editor details.add-line{margin:6px 0 0;border:0;border-top:1px solid var(--line)}.workspace-editor details.add-line>summary{color:var(--accent);font-size:14px;font-weight:700}
.split-preview{margin-top:10px;padding-top:12px;border-top:1px solid var(--line)}
.split-preview h3{display:flex;justify-content:space-between;gap:12px;margin:0 0 8px;font-size:15px}.split-preview h3 span{font-weight:400}
.split-bar{display:block;width:100%;height:16px;overflow:hidden;border-radius:4px;background:var(--line)}
.split-bar rect{stroke:var(--card);stroke-width:2px;vector-effect:non-scaling-stroke}
.split-bar .c0,.sw.c0{fill:var(--c0);background:var(--c0)}.split-bar .c1,.sw.c1{fill:var(--c1);background:var(--c1)}.split-bar .c2,.sw.c2{fill:var(--c2);background:var(--c2)}.split-bar .c3,.sw.c3{fill:var(--c3);background:var(--c3)}
.split-bar .c4,.sw.c4{fill:var(--c4);background:var(--c4)}.split-bar .c5,.sw.c5{fill:var(--c5);background:var(--c5)}.split-bar .c6,.sw.c6{fill:var(--c6);background:var(--c6)}.split-bar .c7,.sw.c7{fill:var(--c7);background:var(--c7)}
.split-parts{list-style:none;margin:8px 0 0;padding:0;display:block}
.split-parts li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:8px;align-items:center;padding:4px 0;font-size:14px}
.split-parts .sw{display:block;width:12px;height:12px;border-radius:2px}
.split-parts strong{min-width:64px;text-align:right;font-variant-numeric:tabular-nums}
.split-preview .live-note{margin:6px 0 0;font-size:13.5px;color:var(--muted)}
.editor-actions{margin-top:14px;padding-top:12px}.editor-actions p:empty,.editor-lead p:empty{display:none}.editor-lead{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.editor-lead>*{margin-top:14px}.editor-lead p{margin-bottom:0;color:var(--muted);font-size:12px}.editor-lead .inline-label{margin:14px 0 0;font-size:14px;font-weight:600}.editor-lead a{margin-top:14px;display:inline-flex;align-items:center;min-height:44px}.editor-lead select,.editor-lead input[type=text]{width:auto;min-width:160px;max-width:100%}
.editor-actions .buttons{align-items:center;flex-wrap:wrap}
.editor-actions .inline-label{margin:0;font-size:14px;font-weight:600}.editor-actions select,.editor-actions input[type=text]{width:auto;min-width:160px;max-width:100%}
.editor-actions button[data-editor-save]{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.editor-actions button[data-editor-save]:disabled{opacity:.55}
.locked-actions{border-top:1px solid var(--line)}
@container editor (min-width:540px){.workspace-editor .items tr{grid-template-columns:minmax(180px,1fr) 110px 210px;gap:4px 14px}.workspace-editor .items td:nth-child(4){grid-column:3;grid-row:1}}
/* P5: the receipt page. Title row with a quiet More, one status banner, the image beside the card (a peek above it on narrower screens). */
.workspace-title{align-items:center}.title-side{display:flex;align-items:center;gap:12px}
.receipt-more>summary::after{content:' \\25BE'}
.workspace-back{display:none;align-items:center;margin-bottom:8px;font-weight:600;color:var(--accent)}
@media(max-width:1023px){.workspace-back{display:inline-flex}}
.status-banner{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;margin:16px 0;padding:14px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font-size:15px}
.status-banner.t-attn{background:var(--attn-soft)}.status-banner.t-ok{background:var(--ok-soft)}
.status-banner .ic{flex:none;width:28px;height:28px}.status-banner .ic svg{display:block;width:28px;height:28px}
.ic-attn{color:var(--attn-dot)}.ic-ok{color:var(--ok-dot)}.ic-muted{color:var(--muted)}
.status-banner .tx{flex:1 1 260px;min-width:0}
.status-banner h2.status-lead{margin:0;font-size:16.5px;line-height:1.3;font-weight:600}
.status-banner .status-note{margin:2px 0 0;font-size:14px;color:var(--muted)}.status-banner .error-detail{color:var(--bad)}
.status-banner .acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto}.status-banner .acts form{margin:0}
.status-banner .acts button,.status-banner .acts .btn{background:var(--card);color:var(--text);border:1px solid var(--line-strong)}
.status-banner .acts button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.status-banner .why{flex-basis:100%}.status-banner .why>summary{font-weight:600;color:var(--muted)}
.waitrow{margin:0 0 16px}
/* P8: the inline cash confirmation (the server's forms, shown in place once asked for) and Check now in place. */
.cash-confirm,.cash-cancel{display:none}.workspace-ready [data-cash-preview][data-confirming] form{display:block}.workspace-ready [data-cash-preview][data-confirming] .cash-confirm{display:block;margin:12px 0 0;font-weight:600}.workspace-ready [data-cash-preview][data-confirming] .cash-cancel{display:inline-flex;margin-top:12px}
.status-banner .check-status:empty{display:none}.locked-consequence{font-weight:600}
/* P9: the Settings overview (a card with a chevron per section) and the section pages (← Settings, Done). */
.settings-cards{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:8px}
.settings-link{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px;padding:12px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);text-decoration:none}
.settings-link:hover{border-color:var(--line-strong)}.settings-link-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.settings-link .settings-card-title{font-weight:600}.settings-link .settings-card-description{display:block;margin:0;font-size:13.5px;color:var(--muted)}
.settings-link .chev{flex:none;width:20px;height:20px;color:var(--muted)}
.settings-back{display:inline-flex;align-items:center;min-height:44px;font-weight:600;color:var(--accent);text-decoration:none}
.settings-done{margin:32px 0 0}.settings-panel{border-top:0}.settings-panel>.settings-card-description{margin:0 0 8px;color:var(--muted)}.settings-advanced{margin:8px 0 16px}
/* P10: Appearance (per-device theme and accent). */
.settings-appearance .field{margin:0 0 20px}.settings-appearance .field>span{display:block;font-weight:600;margin-bottom:8px}
.pref-options{display:flex;flex-wrap:wrap;gap:8px}
.pref-choice{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;background:var(--card);color:var(--text);border:1px solid var(--line-strong)}
.pref-choice[aria-pressed=true]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);background:var(--accent-soft)}
.swatch{width:16px;height:16px;border-radius:50%;border:1px solid var(--line-strong);flex:none}
.swatch-blue{background:#2159c9}.swatch-teal{background:#0b7a75}.swatch-violet{background:#6d3fd1}.swatch-rose{background:#c2255c}.swatch-graphite{background:#3a4150}
/* P7: Previous / Next receipt within the group the receipt was opened from. */
.next-row{border:0;padding:0;margin-inline:0;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px;margin-top:12px}.next-row.waitrow{justify-content:flex-start;margin:0 0 16px}
.next-row .btn{min-height:44px}.next-row .prev-link{display:inline-flex;align-items:center}
.photo-toggle,.photo-full{margin:4px 0 8px}
.app-dialog.photo-dialog{width:min(1200px,calc(100% - 32px))}
.photo-tools{display:flex;align-items:center;gap:8px;margin-bottom:8px}.photo-zoom-readout{min-width:4ch;font-size:13px;font-variant-numeric:tabular-nums}
.photo-stage{height:calc(100vh - 11rem);overflow:hidden;touch-action:none;position:relative}.photo-stage.can-pan{cursor:grab}.photo-stage.panning{cursor:grabbing;user-select:none}
.photo-canvas{transform-origin:0 0;will-change:transform}.photo-canvas .receipt-photo-wrap{max-height:none;overflow:visible}.photo-canvas img.photo{max-height:calc(100vh - 11rem);width:auto;max-width:100%;margin:0 auto;-webkit-user-drag:none}
@media(max-width:1023px){.photo-full{display:none}}
.editor-actions .next-row{margin:0}
@media(max-width:719px){.editor-actions .buttons{flex-wrap:wrap;align-items:center}.editor-actions .next-row .prev-link{display:none}.editor-actions .next-row{margin-left:auto}.editor-actions #acct{max-width:100%}}
@media(max-width:1023px){.receipt-photo-wrap.peek{position:relative;max-height:160px;overflow:hidden}.receipt-photo-wrap.peek::after{content:"";position:absolute;left:0;right:0;bottom:0;height:60px;background:linear-gradient(transparent,var(--bg))}}
@media(max-width:719px){.title-side{margin-top:8px}}
/* P4: the receipts list pane (Receipts, search, Review and Waiting groups, Filed toggle, alerts, Activity link) and the "Pick a receipt" landing. */
.workspace-shell{grid-template-columns:300px minmax(0,1fr)}
.queue-rail{display:flex;flex-direction:column;background:var(--bg);padding:14px 10px 16px}
.queue-rail h2{display:block;margin:0;padding:0 4px 10px;font-size:20px;letter-spacing:0}
.queue-alerts{margin-bottom:10px}.queue-alerts .banner.live{margin:0 0 8px;background:var(--card);border-color:var(--line);color:var(--text);font-size:13.5px}.queue-alerts .banner b{margin-bottom:2px}
.queue-filter{padding:0 0 4px}.queue-filter input[type=search]{width:100%;min-height:44px;padding:0 12px;border:1px solid var(--line-strong);border-radius:6px;background:var(--card);color:var(--text);font-size:16px}
.queue-heading{display:flex;align-items:baseline;gap:8px;margin:14px 4px 2px;font-size:14px;font-weight:700}
.queue-count{color:var(--muted);font-weight:600}
.queue-filed{margin:14px 0 0}.queue-filed>summary{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 4px;font-size:14px;font-weight:700;cursor:pointer;list-style:none}.queue-filed>summary::-webkit-details-marker{display:none}.queue-filed>summary::after{content:'\\25B8';color:var(--muted)}.queue-filed[open]>summary::after{content:'\\25BE'}
.queue-list{list-style:none;margin:0;padding:0}.queue-empty{margin:6px 4px 0;color:var(--muted);font-size:13.5px}
.queue-row{display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:2px 10px;min-height:44px;margin-top:6px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);text-decoration:none}
.queue-row:hover{border-color:var(--line-strong);background:var(--card)}
.queue-row[aria-current=page]{border-color:var(--accent);background:var(--accent-soft)}
.queue-row .dot{grid-row:1;width:10px;height:10px;margin-top:6px;border-radius:50%}
.r-attn .dot{background:var(--attn-dot)}.r-ok .dot{background:var(--ok-dot)}.r-wait .dot{border:2px solid var(--line-strong)}
.queue-store{grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.queue-amount{grid-column:3;white-space:nowrap;font-weight:600;font-variant-numeric:tabular-nums}
.queue-sub{grid-column:2;display:block;margin:0;font-size:13.5px;font-weight:500;color:var(--muted)}.r-attn .queue-sub{color:var(--text);font-weight:600}
.queue-date{grid-column:3;white-space:nowrap;text-align:right;font-size:13px;color:var(--muted)}
.queue-draft{grid-column:2/4;font-size:12.5px;font-weight:700;color:var(--accent)}
.queue-activity{display:flex;align-items:center;min-height:44px;margin:10px 0 0;padding:0 4px;border:1px solid transparent;border-radius:8px;font-size:14px;font-weight:400;color:var(--text);text-decoration:none}.queue-activity[aria-current=page]{border-color:var(--accent);background:var(--accent-soft)}
.status-landing{display:flex;align-items:center;justify-content:center}
@media(max-width:1023px){.status-landing{display:none}}.pick-pane{max-width:360px;text-align:center}.pick-pane h2{margin:0 0 6px;font-size:20px}
.status-overview h2{font-size:24px;letter-spacing:0}
.workspace-ready .reveal-only:not([open]):not(.revealed){display:none}
/* The Archive list pane: "← Receipts", search, sort, and rows with Restore beside them (no status dot). */
.archive-sort{display:flex;gap:6px;margin:6px 0 0}.archive-sort select{flex:1 1 0;min-width:0;min-height:44px;padding:0 8px;border:1px solid var(--line-strong);border-radius:6px;background:var(--card);color:var(--text);font-size:14px}
.archive-item{display:flex;align-items:center;gap:6px;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.archive-item.open{border-color:var(--accent);background:var(--accent-soft)}
.archive-item .queue-row{flex:1 1 auto;min-width:0;grid-template-columns:minmax(0,1fr) auto;margin:0;border:0;background:transparent}
.archive-item .queue-store,.archive-item .queue-sub{grid-column:1}.archive-item .queue-amount{grid-column:2;grid-row:1}
.archive-item form{flex:none;margin:0 8px 0 0}
.archive-landing{padding:30px 32px}.archive-landing .pick-pane{margin:40px auto 24px}
@media(max-width:1023px){.archive-prompt{display:none}.archive-landing{padding:0 16px 24px;max-width:760px;margin:auto}.archive-shell>.queue-rail{padding-bottom:8px}}
.archived-items td:last-child{overflow-wrap:anywhere}
/* P3: the app frame. Brand, three tabs (the current one underlined on the bar's bottom edge), the tonal Add receipt, the Dry run chip, and a bottom tab bar on a phone. */
.app-header{display:flex;align-items:center;justify-content:flex-start;gap:14px;padding:0 24px;min-height:56px;background:var(--card)}
.app-brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:20px;white-space:nowrap;margin-right:6px;color:var(--text);text-decoration:none}
.app-brand:hover,.app-brand:focus-visible{text-decoration:underline;text-underline-offset:4px}
.app-tabs{display:flex;flex-wrap:nowrap;gap:4px;align-self:stretch;margin:0;padding:0;border:0}
.app-tabs a{gap:6px;padding:0 14px;color:var(--text);font-weight:600;border-bottom:0;border-radius:0}
.app-tabs a:hover{color:var(--accent)}
.app-tabs a.on,.app-tabs a[aria-current=page]{color:var(--accent);font-weight:600;box-shadow:inset 0 -3px 0 var(--accent)}
.app-header-actions{margin-left:auto;gap:12px}
.app-header .header-add>summary{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.dry-chip{display:inline-flex;align-items:center;min-height:32px;padding:0 10px;border-radius:4px;border:1px solid var(--line);background:var(--sunken);color:var(--muted);font-size:12px;font-weight:600;text-decoration:none}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:4px;background:var(--attn-dot);color:var(--attn-badge-fg);font-size:12px;font-weight:700;line-height:1}
.tabs{display:none}
@media(max-width:719px){
.app-tabs{display:none}
.app-header{padding:0 14px}
.tabs{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:10;margin:0;padding:4px 6px calc(4px + env(safe-area-inset-bottom));gap:0;flex-wrap:nowrap;background:var(--card);border:0;border-top:1px solid var(--line);min-height:calc(56px + env(safe-area-inset-bottom))}
.tabs a{flex:1;position:relative;flex-direction:column;justify-content:center;gap:2px;min-height:48px;padding:0;border-bottom:0;border-radius:6px;color:var(--muted);font-size:13px;font-weight:600}
.tabs a.on,.tabs a[aria-current=page]{color:var(--accent);background:var(--accent-soft)}
.tab-icon{width:22px;height:22px}
.tabs .badge{position:absolute;top:2px;left:calc(50% + 6px)}
body,body.wide{padding-bottom:calc(64px + env(safe-area-inset-bottom))}
}

/* Phone layout: keep the amount beside the title and keep More on the same row. */
@media(max-width:719px){
.workspace-title{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px 12px;align-items:center}
.workspace-title h2,.settings-heading{font-size:22px;letter-spacing:normal;font-weight:650}
.title-side{display:contents;margin:0}
.workspace-total{display:block;margin:0;font-size:24px;font-weight:700;letter-spacing:normal}
.title-side .receipt-more{grid-column:3;justify-self:end;margin:0}
.workspace-meta{margin-top:4px;overflow-wrap:anywhere}
.workspace-detail,.workspace-editor,.receipt-photos,.receipt-grid{min-width:0}
.workspace-editor{padding:12px}
.workspace-editor .items td,.workspace-editor .nm,.workspace-editor .sub{overflow-wrap:anywhere}
.workspace-editor .items input.amt{width:90px;max-width:100%}
.workspace-editor .item-edit-hint button.linkbtn,.workspace-editor .item-edit-hint a{display:inline-flex;align-items:center;min-height:44px}
.editor-actions{position:sticky;bottom:calc(56px + env(safe-area-inset-bottom));z-index:4;background:var(--card);padding:12px;margin:14px -12px -12px;border-radius:0 0 8px 8px}
.editor-actions .buttons{max-width:100%;gap:8px}
.editor-actions button{min-height:44px;white-space:normal}
.workspace-editor{scroll-margin-bottom:calc(180px + env(safe-area-inset-bottom))}
.workspace-editor .items tr{scroll-margin-bottom:calc(180px + env(safe-area-inset-bottom))}
.app-header{gap:8px;flex-wrap:wrap}.app-brand{font-size:18px;margin-right:0}.app-header-actions{gap:6px}
.workspace-details{overflow-wrap:anywhere}.workspace-details .scroll{max-width:100%;overflow-x:auto}
}
/* Round B: shared Settings cards and responsive workspace spacing. */
.settings-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}.settings-cards{gap:12px}
.settings-card,.settings-page details.how,.settings-everyday{border:1px solid var(--line);border-radius:8px;background:var(--card);padding:0 16px;margin:0}
.settings-page details.how{margin-top:12px}
.settings-card>summary,details.how>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:0;margin:0;list-style:none;font-weight:600}
.settings-card>summary::-webkit-details-marker,details.how>summary::-webkit-details-marker{display:none}
.settings-card>summary::after,details.how>summary::after{content:"";flex:none;width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);margin-right:4px;color:var(--muted)}
.settings-card[open]>summary::after,details.how[open]>summary::after{transform:rotate(45deg)}
.settings-card[open]>summary,.settings-page details.how[open]>summary{border-bottom:1px solid var(--line);margin-bottom:0}
.settings-card .setting:first-of-type,.settings-everyday .setting:first-of-type{border-top:0}
.settings-page .setting{padding:12px 0}.settings-page .setting>input,.settings-page .setting>select{align-self:center}
.workspace-back,.settings-back{font-size:15px;font-weight:600;color:var(--accent);min-height:44px;margin:0 0 8px;text-decoration:none}
.workspace-editor details.add-line,.workspace-editor details.how{border-radius:0}
.keyword-add{margin-top:12px}
@media(max-width:719px){.settings-page .setting{grid-template-columns:minmax(0,1fr)}.settings-page .setting:has(.check){grid-template-columns:minmax(0,1fr) auto}.settings-page .setting>input,.settings-page .setting>select{width:100%}}
@media(min-width:1024px){
.workspace-shell{min-height:calc(100dvh - 56px)}.workspace-detail{max-width:1080px}
.settings-page .setting-options>summary{min-height:28px;padding-block:4px}
.status-landing{align-items:flex-start;padding:96px 32px 30px}.status-landing .pick-pane,.archive-landing .pick-pane{width:100%;max-width:360px;margin:0 auto 24px}.archive-landing{padding-top:96px}
.archive-shell{grid-template-columns:360px minmax(0,1fr)}.archive-sort select:first-of-type{flex:3 1 0}.archive-sort select:last-of-type{flex:2 1 0}
}
@media(min-width:1280px){.receipt-grid{grid-template-columns:minmax(240px,340px) minmax(0,1fr)}}
.page-error{margin:0 0 12px;font-size:14px;font-weight:600}
.actual-link{color:var(--muted);text-decoration:underline;text-underline-offset:2px}.actual-link:hover,.actual-link:focus-visible{color:var(--accent)}
.header-actual{color:var(--muted);display:inline-flex;align-items:center;min-height:40px;padding:0 6px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap}
.status-banner .acts .actual-link{align-self:center;padding:8px 4px}
.connection-actual{margin:0 0 8px}
`;
