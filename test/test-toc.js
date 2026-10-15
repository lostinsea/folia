"use strict";
const { app, BrowserWindow, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
require("./test-userdata-isolation");
const { tempDir, releaseTempDir, captureScreenshot, startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
require("../src/main.js");

const directory = tempDir("folia-toc-");
const first = path.join(directory, "outline.md");
const second = path.join(directory, "other.md");
const tailFile = path.join(directory, "tail.md");
const nestedFile = path.join(directory, "nested.md");
const parts = ["# TOC Alpha", "Opening paragraph."];
for (let i = 0; i < 64; i++) {
  parts.push(`## Section ${i}`);
  parts.push(("A readable paragraph explains document navigation and rendering. ").repeat(30));
  if (i === 2) parts.push("```mermaid\nflowchart LR\n A[Read] --> B[Render] --> C[Scroll]\n```");
  if (i === 20) parts.push('<img id="toc-reflow-image" alt="Reflow witness" style="display:block">');
  if (i % 8 === 0) parts.push(`### Nested ${i}`, "Nested content.\n\n".repeat(12));
}
const markdown = parts.join("\n\n");
fs.writeFileSync(first, markdown);
fs.writeFileSync(second, "# TOC Other\n\n" + parts.slice(2, 32).join("\n\n"));
fs.writeFileSync(tailFile, "# End fixture\n\n" + "A long paragraph.\n\n".repeat(90) + "## Before tail\n\nShort.\n\n## Final tail\n\nEnd.");
const nestedHeadings = [
  "# Multi outline", "## Parent", "### Nested child", "#### Deep section",
  "##### Deeper section", "###### Deepest section", "## Second branch",
  "##### Skipped levels", "###### Skipped child", "### Return to child", "# Ending",
];
fs.writeFileSync(nestedFile, nestedHeadings.map(h =>
  h + "\n\n" + ("A long nested section keeps its heading above the viewport while reading.\n\n").repeat(35)).join("\n\n"));
let selectedFile = first;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFile] });
let win;
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = code => win.webContents.executeJavaScript(code);
const frames = () => exec("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))");
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
async function wait(label, expression) {
  for (let i = 0; i < 300; i++) {
    if (await exec(expression)) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for " + label);
}
async function settle() { await sleep(200); await frames(); }
async function setView(split, zoom) {
  await exec(`if(isEditMode!==${split}) document.getElementById('toggleEdit').click();true`);
  await wait("real view mode", `isEditMode===${split} && contentWrapper.classList.contains('split-view')===${split} && !loadingScreen.classList.contains('active')`);
  await exec(`zoomLevel=${zoom};updateZoom();true`);
  await sleep(600);
}
const ORACLE = `(() => {
  const s=getViewerScroller(),scale=scrollerScale(s),line=s.getBoundingClientRect().top+20*scale;
  const hs=[...viewer.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter(h=>h.checkVisibility({visibilityProperty:true,opacityProperty:true}))
    .map((h,i)=>({h,i,top:h.getBoundingClientRect().top})).sort((a,b)=>a.top-b.top||a.i-b.i);
  let expected=hs[0]?.h;
  for(const h of hs) if(h.top<=line+scale) expected=h.h;
  if(s.scrollHeight>s.clientHeight&&s.scrollTop>=s.scrollHeight-s.clientHeight-2) expected=hs.at(-1)?.h;
  const active=[...indexList.querySelectorAll('.index-item.active')];
  return {expected:expected?.id||null,active:active[0]?.dataset.headerId||null,
    count:active.length,current:active[0]?.getAttribute('aria-current'),top:s.scrollTop,
    max:s.scrollHeight-s.clientHeight,focus:document.activeElement?.id};
})()`;
async function oracle() { await settle(); return exec(ORACLE); }
const matches = value => value.expected === value.active && value.count === (value.expected ? 1 : 0) &&
  (!value.expected || value.current === "location");

async function run() {
  await wait("production renderer", "typeof window.CustomTabs?.getTabs === 'function' && typeof renderMarkdown === 'function'");
  win.setSize(1280, 850);
  win.focus();
  win.webContents.focus();
  const sentinel = startErrorSentinel(win, { label: "toc" });
  await exec("document.getElementById('openFile').click(); true");
  await wait("actual admitted document", "viewer.querySelector('h1')?.textContent==='TOC Alpha' && viewer.querySelectorAll('.mermaid svg').length===1 && !loadingScreen.classList.contains('active')");
  await sleep(1300);
  await exec("document.getElementById('toggleIndex').click(); true");
  let state = await oracle();
  check("TOC opens with exactly one current heading before any outline click", matches(state), state);
  const layout = await exec(`(() => {
    const p=indexPanel.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
    const hit=document.elementFromPoint(s.right-4,s.top+s.height/2);
    return {left:p.left,right:p.right,scrollerLeft:s.left,hitPanel:indexPanel.contains(hit),
      buttons:[...indexList.children].every(e=>e.tagName==='BUTTON'),inert:indexPanel.inert,
      expanded:toggleIndexBtn.getAttribute('aria-expanded'),label:indexPanel.getAttribute('aria-labelledby')};
  })()`);
  check("TOC is on the left beside the document with the scrollbar exposed",
    layout.left >= -1 && layout.right <= layout.scrollerLeft + 1 && !layout.hitPanel, layout);
  check("TOC exposes keyboard buttons a named navigation region and expanded state",
    layout.buttons && !layout.inert && layout.expanded === "true" && layout.label === "indexTitle", layout);

  const scrollCases = [];
  for (const split of [false, true]) {
    for (const zoom of [100, 200]) {
      await setView(split, zoom);
      for (const fraction of [0, .12, .8, .35, 1, .01]) {
        await exec(`getViewerScroller().scrollTop=(getViewerScroller().scrollHeight-getViewerScroller().clientHeight)*${fraction}; true`);
        const value = await oracle();
        scrollCases.push({ split, zoom, fraction, ...value });
      }
    }
  }
  check("TOC tracks forward backward fast jumps long sections top and end in both scrollers and zooms",
    scrollCases.every(matches) && scrollCases.every(c => c.max > 1000) &&
      scrollCases.filter(c => c.fraction === .8).every(c => c.top > 1000), scrollCases);

  await setView(false, 100);
  const work = await exec(`(async () => {
    const original=Element.prototype.getBoundingClientRect,rects=Element.prototype.getClientRects;
    let reads=0;
    function counted(el){return /^H[1-6]$/.test(el.tagName)||el.classList.contains('index-item');}
    Element.prototype.getBoundingClientRect=function(...args){if(counted(this))reads++;return original.apply(this,args);};
    Element.prototype.getClientRects=function(...args){if(counted(this))reads++;return rects.apply(this,args);};
    const focus=document.activeElement,s=getViewerScroller();
    try {
      for(let i=0;i<24;i++){
        s.scrollTop=(s.scrollHeight-s.clientHeight)*(i%8)/7;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      }
      return {reads,sameFocus:document.activeElement===focus,top:s.scrollTop,max:s.scrollHeight-s.clientHeight};
    } finally {Element.prototype.getBoundingClientRect=original;Element.prototype.getClientRects=rects;}
  })()`);
  check("settled TOC scrolling reads no heading or outline row geometry and never moves focus",
    work.reads === 0 && work.sameFocus && work.top > work.max - 2, work);

  const clickCases = [];
  for (const split of [false, true]) {
    await setView(split, 160);
    win.focus();
    win.webContents.focus();
    await exec("indexList.querySelector('[data-header-id=\"section-35\"]').focus({preventScroll:true});true");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await sleep(900);
    clickCases.push(await oracle());
  }
  check("native Enter on a TOC button navigates and the scrolled section becomes current",
    clickCases.every(c => matches(c) && c.active === "section-35"), clickCases);

  const collapsed = await exec(`(async () => {
    const header=viewer.querySelector('#section-32');header.click();
    await new Promise(r=>setTimeout(r,250));
    const nested=viewer.querySelector('#nested-32');
    const hidden=!nested.checkVisibility();
    indexList.querySelector('[data-header-id="nested-32"]').click();
    await new Promise(r=>setTimeout(r,900));
    return {hidden,visible:nested.checkVisibility()};
  })()`);
  state = await oracle();
  check("TOC navigation expands a genuinely hidden descendant and tracks its heading",
    collapsed.hidden && collapsed.visible && matches(state) && state.active === "nested-32", { collapsed, state });

  await setView(true, 100);
  await exec(`(() => {
    const s=getViewerScroller(),h=viewer.querySelector('#section-40');
    s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+40;
    s.style.overflowAnchor='none';
    return true;
  })()`);
  const beforeImage = await oracle();
  await exec(`(() => {
    const img=viewer.querySelector('#toc-reflow-image');
    window.__tocImageLoaded=false;img.addEventListener('load',()=>{window.__tocImageLoaded=true;},{once:true});
    img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="3000"><rect width="300" height="3000" fill="#7a9db0"/></svg>');
    return true;
  })()`);
  await wait("real late image load", "window.__tocImageLoaded===true && viewer.querySelector('#toc-reflow-image').naturalHeight===3000");
  const afterImage = await oracle();
  check("stationary split-view image reflow changes the expected heading and refreshes the highlight",
    beforeImage.expected !== afterImage.expected && matches(afterImage), { beforeImage, afterImage });

  const equalHeight = await exec(`(async () => {
    const s=getViewerScroller(),before=viewer.querySelector('#section-8').nextElementSibling;
    const after=viewer.querySelector('#section-56').nextElementSibling;
    after.style.paddingBottom='2500px';
    await new Promise(r=>setTimeout(r,300));
    const h=viewer.querySelector('#section-40');
    s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+40;
    await new Promise(r=>setTimeout(r,300));
    window.__tocBeforeEqual=${ORACLE};
    const height=s.scrollHeight,client=s.clientHeight;
    after.style.paddingBottom='';before.style.paddingBottom='2500px';
    await new Promise(r=>setTimeout(r,300));
    return {height,afterHeight:s.scrollHeight,client,afterClient:s.clientHeight};
  })()`);
  const afterEqual = await oracle();
  const beforeEqual = await exec("window.__tocBeforeEqual");
  check("equal-total-height split-view reflow changes the expected heading without changing either extent",
    Math.abs(equalHeight.height - equalHeight.afterHeight) <= 1 &&
      equalHeight.client === equalHeight.afterClient &&
      beforeEqual.expected !== afterEqual.expected && matches(afterEqual), { equalHeight, beforeEqual, afterEqual });

  await exec("viewer.style.overflowAnchor='';contentWrapper.style.overflowAnchor='';true");
  const anchorCases = [];
  for (const split of [false, true]) {
    await setView(split, 130);
    await exec(`(() => {
      const s=getViewerScroller(),p=viewer.querySelector('#section-44').nextElementSibling.querySelector('p');
      const r=p.getBoundingClientRect(),sr=s.getBoundingClientRect();
      s.scrollTop+=(r.top+r.height/2-(sr.top+sr.height/2))/scrollerScale(s);
      window.__tocReadingParagraph=p;return true;
    })()`);
    await settle();
    await exec("document.getElementById('closeIndex').click();true");
    await settle();
    const closed = await exec(`(() => {
      const r=window.__tocReadingParagraph.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
      return Math.abs(r.top+r.height/2-(s.top+s.height/2));
    })()`);
    await exec("document.getElementById('toggleIndex').click();true");
    await settle();
    const opened = await exec(`(() => {
      const r=window.__tocReadingParagraph.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
      return Math.abs(r.top+r.height/2-(s.top+s.height/2));
    })()`);
    anchorCases.push({ split, closed, opened });
  }
  check("opening and closing the left drawer preserves a mid-paragraph reading position",
    anchorCases.every(c => c.closed < 24 && c.opened < 24), anchorCases);

  await exec("document.getElementById('toggleNotes').click();true");
  await settle();
  const notes = await exec("({notes:notesPanel.classList.contains('visible'),toc:indexPanel.classList.contains('visible'),inert:indexPanel.inert})");
  await exec("document.getElementById('toggleIndex').click();true");
  await settle();
  const toc = await exec("({notes:notesPanel.classList.contains('visible'),toc:indexPanel.classList.contains('visible')})");
  check("TOC and All Notes use the confirmed one-left-drawer-at-a-time behavior",
    notes.notes && !notes.toc && notes.inert && toc.toc && !toc.notes, { notes, toc });
  await exec("closeNotesPanel();setIndexVisible(true);true");

  await setView(false, 100);
  selectedFile = second;
  await exec("document.getElementById('openFile').click();true");
  await wait("other tab", "viewer.querySelector('h1')?.textContent==='TOC Other'");
  state = await oracle();
  check("opening another real admitted tab replaces old TOC membership", matches(state) &&
    await exec("indexList.children.length===viewer.querySelectorAll('h1,h2,h3,h4,h5,h6').length"), state);
  await exec(`(() => {
    const tab=window.CustomTabs.getTabs().find(t=>t.filePath===${JSON.stringify(first)});
    document.querySelector('[data-tab-id="'+tab.id+'"]').click();
    return true;
  })()`);
  await wait("restored first tab DOM", "viewer.querySelector('h1')?.textContent==='TOC Alpha'");
  await sleep(1300);
  state = await oracle();
  check("returning to a tab recomputes its highlight after reading-position restoration", matches(state), state);
  fs.writeFileSync(first, markdown.replace("# TOC Alpha", "# TOC Reloaded"));
  await exec("document.getElementById('refreshBtn').click();true");
  await wait("actual reload DOM", "viewer.querySelector('h1')?.textContent==='TOC Reloaded'");
  state = await oracle();
  check("real reload refreshes heading labels and the current section", matches(state) &&
    await exec("indexList.firstElementChild.textContent==='TOC Reloaded'"), state);

  await setView(false, 100);
  win.setMinimumSize(400, 300);
  win.setSize(600, 650);
  await sleep(600);
  state = await oracle();
  const narrow = await exec(`(() => {
    const p=indexPanel.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
    return {width:innerWidth,panel:p.width,document:s.width,separate:p.right<=s.left+1};
  })()`);
  check("a narrow window keeps the left outline and document usable without overlap",
    narrow.separate && narrow.panel <= narrow.width * .4 + 1 && narrow.document > 200 && matches(state), { narrow, state });
  await captureScreenshot(win, "toc-left-narrow");
  win.setSize(1280, 850);
  await exec("getViewerScroller().scrollTop=0;true");
  await settle();
  await captureScreenshot(win, "toc-left-top");
  await exec("getViewerScroller().scrollTop=(getViewerScroller().scrollHeight-getViewerScroller().clientHeight)*.45;true");
  await settle();
  const visibleActive = await exec(`(() => {
    const item=indexList.querySelector('.active'),r=item?.getBoundingClientRect(),l=indexList.getBoundingClientRect();
    return {active:item?.textContent,top:r?.top,bottom:r?.bottom,listTop:l.top,listBottom:l.bottom};
  })()`);
  check("the active TOC row is revealed inside its own scrollport", visibleActive.top >= visibleActive.listTop - 1 &&
    visibleActive.bottom <= visibleActive.listBottom + 1, visibleActive);
  const beforeHeight = await oracle();
  win.setSize(1280, 550);
  await sleep(600);
  const afterHeight = await oracle();
  const afterHeightRow = await exec(`(() => {
    const item=indexList.querySelector('.active'),r=item?.getBoundingClientRect(),l=indexList.getBoundingClientRect();
    return {top:r?.top,bottom:r?.bottom,listTop:l.top,listBottom:l.bottom};
  })()`);
  check("height-only resizing keeps the same active row visible with refreshed outline bounds",
    matches(afterHeight) && beforeHeight.active === afterHeight.active &&
    afterHeightRow.top >= afterHeightRow.listTop - 1 && afterHeightRow.bottom <= afterHeightRow.listBottom + 1,
    {beforeHeight,afterHeight,afterHeightRow});
  win.setSize(1280, 850);
  await settle();
  await captureScreenshot(win, "toc-left-scrolled");
  await exec("document.getElementById('darkModeToggle').click();true");
  await sleep(800);
  await captureScreenshot(win, "toc-left-other-theme");

  await exec("indexList.querySelector('.active').focus({preventScroll:true});true");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await settle();
  const closed = await exec("({inert:indexPanel.inert,visible:indexPanel.classList.contains('visible'),focus:document.activeElement.id,expanded:toggleIndexBtn.getAttribute('aria-expanded')})");
  check("Escape closes the outline makes it inert and returns focus to the visible menu button",
    closed.inert && !closed.visible && closed.focus === "menuBtn" && closed.expanded === "false", closed);
  const hiddenWork = await exec(`(async () => {
    const original=Element.prototype.getBoundingClientRect;let reads=0;
    Element.prototype.getBoundingClientRect=function(...args){if(/^H[1-6]$/.test(this.tagName)||this.classList.contains('index-item'))reads++;return original.apply(this,args);};
    try {for(let i=0;i<12;i++){getViewerScroller().scrollTop=i*150;await new Promise(r=>requestAnimationFrame(r));}return reads;}
    finally{Element.prototype.getBoundingClientRect=original;}
  })()`);
  check("a hidden TOC performs no heading or row geometry work while scrolling", hiddenWork === 0, hiddenWork);
  await exec("document.getElementById('toggleIndex').click();true");
  state = await oracle();
  check("reopening the TOC calculates a fresh highlight at the current position", matches(state), state);
  selectedFile = nestedFile;
  await exec("document.getElementById('openFile').click();true");
  await wait("admitted mixed-level fixture", "viewer.querySelector('h1')?.textContent==='Multi outline' && !loadingScreen.classList.contains('active')");
  await sleep(1300);
  const hierarchy = await exec(`Array.from({length:6},(_,i)=>{
    const level=i+1,headers=[...viewer.querySelectorAll('h'+level)],rows=[...indexList.querySelectorAll('.level-'+level)];
    return {level,headers:headers.length,rows:rows.length,padding:rows.map(r=>parseFloat(getComputedStyle(r).paddingLeft))};
  })`);
  check("mixed-level TOC preserves every H1-H6 heading and its hierarchy indentation",
    hierarchy.every(h=>h.headers>0 && h.headers===h.rows && h.padding.every(p=>p===h.level*12)), hierarchy);
  const nestedCases = [];
  for (const split of [false, true]) {
    for (const zoom of [100, 200]) {
      await setView(split, zoom);
      for (const id of ["multi-outline","parent","nested-child","deep-section","deeper-section","deepest-section",
        "skipped-levels","skipped-child","return-to-child","parent","deepest-section","nested-child"]) {
        await exec(`(() => {
          const h=viewer.querySelector('#'+${JSON.stringify(id)}),s=getViewerScroller();
          s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)-18;
          return true;
        })()`);
        nestedCases.push({split,zoom,id,...await oracle()});
      }
      const gap = await exec(`(() => {
        const h=viewer.querySelector('#deepest-section'),s=getViewerScroller();
        s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+250;
        return {headingTop:h.getBoundingClientRect().top,scrollerTop:s.getBoundingClientRect().top};
      })()`);
      nestedCases.push({split,zoom,id:"deepest-section",longGap:gap,...await oracle()});
    }
  }
  check("mixed-level tracking follows actual H1-H6 headings forward backward and by jumps across skipped levels and long sections",
    nestedCases.every(c=>matches(c) && c.active===c.id) && nestedCases.filter(c=>c.longGap).length===4 &&
    nestedCases.filter(c=>c.longGap).every(c=>c.longGap.headingTop<c.longGap.scrollerTop), nestedCases);
  await setView(false, 100);
  const nestedClicks = [];
  for (const id of ["multi-outline","parent","nested-child","deep-section","deeper-section","deepest-section","skipped-levels","skipped-child"]) {
    await exec(`indexList.querySelector('[data-header-id="${id}"]').click();true`);
    nestedClicks.push({id,...await oracle()});
  }
  check("mixed-level TOC clicks keep H1-H6 and skipped-level targets current",
    nestedClicks.every(c=>matches(c) && c.active===c.id), nestedClicks);
  selectedFile = tailFile;
  await exec("document.getElementById('openFile').click();true");
  await wait("admitted tail fixture", "viewer.querySelector('h1')?.textContent==='End fixture' && !loadingScreen.classList.contains('active')");
  await sleep(1300);
  const tailCases = [];
  for (const split of [false, true]) {
    for (const zoom of [100, 200]) {
      await setView(split, zoom);
      await exec("getViewerScroller().scrollTop=getViewerScroller().scrollHeight;true");
      tailCases.push({split,zoom,...await oracle()});
    }
  }
  check("a short final section becomes current at the actual bottom in both scrollers and zooms",
    tailCases.every(c => matches(c) && c.active === "final-tail" && c.max > 1000), tailCases);
  await setView(false, 100);
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
  const print = await exec("({margin:getComputedStyle(contentWrapper).marginLeft,panel:getComputedStyle(indexPanel).display})");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "" });
  win.webContents.debugger.detach();
  check("printing with the TOC open hides the drawer without reserving blank left space",
    print.margin === "0px" && print.panel === "none", print);
  await exec("renderMarkdown('Plain document without headings.','full')");
  await settle();
  check("a no-heading render clears stale TOC entries and current state",
    await exec("indexList.querySelectorAll('.index-item,.active,[aria-current]').length===0 && !!indexList.querySelector('.index-empty')"));
  await exec("renderMarkdown('# Short\\n\\nShort body.','full')");
  state = await oracle();
  check("a short nonoverflowing document still has one correct current heading", matches(state), state);
  await exec("viewer.replaceChildren(document.createTextNode('Unavailable preview'));true");
  await settle();
  check("direct error-style DOM replacement retires old headings without a render handoff",
    await exec("!indexList.querySelector('.index-item,.active,[aria-current]')"));
  const alive = await proveSentinelAlive(win, sentinel);
  check("TOC error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
  const errors = await sentinel.stop();
  check("TOC scenarios introduce no renderer or visible document errors", errors.hits.length === 0, errors.hits);
}

app.whenReady().then(async () => {
  await sleep(1800);
  win = BrowserWindow.getAllWindows()[0];
  try { await run(); }
  catch (error) {
    check("TOC harness reaches completion", false, String(error.stack || error));
    console.log("TOC diagnostic", await exec("({heading:viewer.querySelector('h1')?.textContent,edit:contentWrapper.className,active:window.CustomTabs.getActiveTabId(),tabs:window.CustomTabs.getTabs().map(t=>({id:t.id,name:t.filename,dirty:t.hasUnsavedChanges}))})"));
    if (win && !win.isDestroyed()) await captureScreenshot(win, "toc-FAILED");
  }
  const summary = `=== ${results.filter(r => r.ok).length}/${results.length} passed ===`;
  app.once("quit", () => console.log(summary));
  app.once("will-quit", () => {
    releaseTempDir(directory);
    app.exit(results.every(r => r.ok) ? 0 : 1);
  });
  app.quit();
});
setTimeout(() => { console.error("TOC watchdog expired"); app.exit(2); }, 180000);
