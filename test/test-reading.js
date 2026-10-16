"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const root = path.resolve(__dirname, "..");
const batch = process.env.FOLIA_READING_BATCH || path.join(root, "tmp", "reading-" + randomUUID());
if (!path.resolve(batch).startsWith(path.join(root, "tmp") + path.sep)) throw new Error("Project-local reading batch required");
const originalTmpdir = os.tmpdir;
os.tmpdir = () => path.join(batch, "isolation", process.argv[2] || "controller");
require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
const electron = require("electron");
if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  fs.mkdirSync(batch, { recursive: true });
  console.log("Reading evidence: " + batch);
  let total = 0;
  let passed = 0;
  const phases = process.env.FOLIA_READING_PERF ? ["screen"] : ["screen", "toc", "notes", "closed", "invalid"];
  for (const phase of phases) {
    const run = spawnSync(electron, [__filename, phase], {
      cwd: root, encoding: "utf8", timeout: 180000,
      env: { ...process.env, FOLIA_READING_BATCH: batch },
    });
    process.stdout.write(run.stdout || "");
    process.stderr.write(run.stderr || "");
    const footer = run.stdout?.match(/=== reading (\w+): (\d+)\/(\d+) passed ===/);
    if (run.error || !footer || footer[1] !== phase || Number(footer[3]) < 4 ||
        run.status !== (footer[2] === footer[3] ? 0 : 1)) {
      console.error("FAIL reading child completion  -> " + (run.error || run.status));
      process.exit(1);
    }
    passed += Number(footer[2]);
    total += Number(footer[3]);
  }
  console.log(`=== ${passed}/${total} passed ===`);
  process.exit(passed === total ? 0 : 1);
} else {
  const { app, BrowserWindow, dialog, session } = electron;
  const phase = process.argv[2];
  const profile = path.join(batch, "profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  const first = path.join(batch, "reading.md");
  const other = path.join(batch, "other.md");
  let chosen = first;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  require("../src/main.js");
  const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
  let win;
  const results = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = code => win.webContents.executeJavaScript(code);
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  };
  async function wait(label, expression) {
    for (let i = 0; i < 300; i++) {
      if (await exec(expression)) return;
      await sleep(50);
    }
    throw new Error("Timed out: " + label);
  }
  async function settle() {
    await sleep(450);
    await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
  }
  async function capture(name) {
    await settle();
    fs.writeFileSync(path.join(batch, name + ".png"), (await win.webContents.capturePage()).toPNG());
  }
  async function setView(split, zoom) {
    await exec(`if(isEditMode!==${split})document.getElementById('toggleEdit').click();true`);
    await wait("view mode", `isEditMode===${split}&&!loadingScreen.classList.contains('active')`);
    await exec(`zoomLevel=${zoom};updateZoom();true`);
    await sleep(700);
  }
  const panelState = `({toc:indexPanel.classList.contains('visible'),notes:notesPanel.classList.contains('visible'),
    inertToc:indexPanel.inert,inertNotes:notesPanel.inert,saved:localStorage.getItem('readingSidePanel'),
    focused:document.activeElement?.id,inline:localStorage.getItem('notesVisible')})`;
  function markdown() {
    const row = i => `| ${i} | A readable description with several words for row ${i}. | pending |`;
    const table = ["| Number | Description with a multiline heading | State |", "| --- | --- | --- |",
      ...Array.from({ length: 65 }, (_, i) => row(i))].join("\n");
    const wide = `<div class="table-container"><table id="wide"><thead><tr><th rowspan="2">Wide original A</th><th>Wide original B</th></tr><tr><th>Second header row</th></tr></thead><tbody>${
      Array.from({ length: 30 }, (_, i) => `<tr><td>${"unbroken".repeat(55)}</td><td>Wide row ${i}</td></tr>`).join("")
    }</tbody></table></div>`;
    return ["# Reading controls", "Opening prose.\n\n".repeat(12), "## First long table", table,
      "## Between tables", "A paragraph between the tables.\n\n".repeat(15), "## Second long table", table,
      "## Wide table", wide, "## Diagrams",
      "```mermaid\nflowchart LR\n A{Is the file ready to read?} --> B[Read]\n B -.-> C[Wait]\n C ==> D[Done]\n A ~~~ D\n linkStyle 0 stroke-width:4px\n```",
      "```mermaid\nsequenceDiagram\n participant Reader\n participant File\n Reader->>File: Read\n File-->>Reader: Content\n```",
      "```mermaid\nclassDiagram\n Reader --> File\n File ..> Content\n```",
      "```mermaid\nstateDiagram-v2\n [*] --> Reading\n Reading --> Done\n```",
      "```mermaid\nerDiagram\n READER ||--o{ FILE : reads\n```",
      "## Final section", "Ending prose.\n\n".repeat(20)].join("\n\n");
  }
  async function screen() {
    fs.writeFileSync(first, markdown());
    fs.writeFileSync(other, "# Other reading document\n\nOther content.");
    const sentinel = startErrorSentinel(win, { label: "reading" });
    let watcherSnapshot = null;
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
      if (channel === "file-changed-externally") watcherSnapshot = args[0];
      return send(channel, ...args);
    };
    await exec("document.getElementById('openFile').click();true");
    await wait("admitted mixed document", "viewer.querySelector('h1')?.textContent==='Reading controls'&&viewer.querySelectorAll('.mermaid svg').length===5&&!loadingScreen.classList.contains('active')");
    await settle();
    check("reading fixture has original tables and five actual diagrams",
      await exec("viewer.querySelectorAll('table').length===3&&viewer.querySelectorAll('.mermaid svg').length===5"));
    check("production renderer remains isolated",
      await exec("typeof require==='undefined'&&typeof process==='undefined'&&Object.isFrozen(window.folia)"));
    await exec("localStorage.setItem('notesVisible','false');document.getElementById('toggleIndex').click();true");
    let state = await exec(panelState);
    if (!process.env.FOLIA_READING_PERF) check("TOC user intent persists without changing inline notes", state.toc && !state.notes && state.saved === "toc" && state.inline === "false", state);
    await exec("document.getElementById('toggleNotes').click();true");
    state = await exec(panelState);
    if (!process.env.FOLIA_READING_PERF) check("Notes replaces TOC and persists only the final drawer", !state.toc && state.notes && state.inertToc && !state.inertNotes && state.saved === "notes", state);
    await exec("document.getElementById('closeNotes').click();true");
    state = await exec(panelState);
    if (!process.env.FOLIA_READING_PERF) check("explicit Notes close saves closed and removes hidden controls", !state.toc && !state.notes && state.inertNotes && state.saved === "closed", state);
    if (!process.env.FOLIA_READING_PERF) {
      const transient = await exec(`(()=>{
        const saved=localStorage.getItem('readingSidePanel');setIndexVisible(true);closeNotesPanel();
        return {saved,after:localStorage.getItem('readingSidePanel')};
      })()`);
      check("programmatic panel changes do not overwrite saved user intent", transient.saved === transient.after, transient);
      const unavailable = await exec(`(()=>{
        const original=Storage.prototype.setItem;let warned=false;
        const warn=console.warn;console.warn=(...args)=>{warned=true;warn(...args)};
        Storage.prototype.setItem=function(){throw new Error('deliberate storage refusal')};
        try{document.getElementById('toggleNotes').click();return {warned,open:notesPanel.classList.contains('visible')}}
        finally{Storage.prototype.setItem=original;console.warn=warn}
      })()`);
      check("unavailable preference storage warns without disabling the drawer", unavailable.warned && unavailable.open, unavailable);
      await exec("document.getElementById('closeNotes').click();true");
    }
    await exec("document.getElementById('toggleIndex').click();true");
    const cases = [];
    for (const split of [false, true]) for (const zoom of [100, 200]) {
      await setView(split, zoom);
      for (const index of [0, 1]) {
        const value = await exec(`(async()=>{
          const t=viewer.querySelectorAll('table')[${index}],h=t.tHead,s=getViewerScroller();
          window.__readingHeader=h;s.scrollTop=0;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const top=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s);
          s.scrollTop=top+200;await new Promise(r=>setTimeout(r,150));
          const a=h.getBoundingClientRect(),b=s.getBoundingClientRect(),cells=[...h.rows[0].cells],row=t.tBodies[0].rows[0];
          const pinned=Math.abs(a.top-b.top)<2;
          const aligned=cells.every((c,i)=>Math.abs(c.getBoundingClientRect().left-row.cells[i].getBoundingClientRect().left)<1);
          s.scrollTop+=(t.getBoundingClientRect().bottom-b.top-a.height*.5)/scrollerScale(s);
          await new Promise(r=>setTimeout(r,150));
          const end=h.getBoundingClientRect(),bottom=t.getBoundingClientRect().bottom;
          return {split:${split},zoom:${zoom},index:${index},pinned,aligned,original:h===window.__readingHeader,
            end:Math.abs(end.bottom-bottom)<2,delta:a.top-b.top,endDelta:end.bottom-bottom};
        })()`);
        cases.push(value);
      }
    }
    if (!process.env.FOLIA_READING_PERF) check("actual table headers pin align and release at their own ends across scrollowners and zoom",
      cases.every(c => c.pinned && c.aligned && c.original && c.end), cases);
    await setView(false, 100);
    win.setSize(850, 800);
    await settle();
    const horizontal = await exec(`(async()=>{
      const t=viewer.querySelector('#wide'),h=t.tHead,c=t.closest('.table-container'),s=getViewerScroller();
      s.scrollTop=0;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+100;
      c.scrollLeft=240;await new Promise(r=>setTimeout(r,150));
      const a=h.rows[0].cells[0].getBoundingClientRect(),b=t.tBodies[0].rows[0].cells[0].getBoundingClientRect();
      return {overflow:c.scrollWidth>c.clientWidth+100,moved:c.scrollLeft,aligned:Math.abs(a.left-b.left)<1,pinned:Math.abs(h.getBoundingClientRect().top-s.getBoundingClientRect().top)<2};
    })()`);
    if (!process.env.FOLIA_READING_PERF) check("wide pinned original headers follow horizontal scrolling in a narrow drawer layout",
      horizontal.overflow && horizontal.moved > 100 && horizontal.aligned && horizontal.pinned, horizontal);
    await capture("sticky-narrow");
    if (!process.env.FOLIA_READING_PERF) {
      await exec("getViewerScroller().scrollTop=0;true");
      await settle();
      const point = await exec(`(()=>{
        const s=getViewerScroller(),h=viewer.querySelector('thead');
        s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+80;
        const r=s.getBoundingClientRect();return {x:Math.round(r.right-80),y:Math.round(r.top+250)};
      })()`);
      await settle();
      const before = await exec("getViewerScroller().scrollTop");
      win.webContents.sendInputEvent({ type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: -180 });
      await settle();
      const wheel = await exec(`({before:${before},after:getViewerScroller().scrollTop,header:viewer.querySelector('thead').getBoundingClientRect().top,port:getViewerScroller().getBoundingClientRect().top})`);
      check("native wheel scroll keeps the original long-table header pinned",
        wheel.after > wheel.before + 50 && Math.abs(wheel.header - wheel.port) < 2, wheel);
      await capture("sticky-original-wheel");
      const nested = `<td colspan="3"><div class="table-container"><table id="nested-reading"><thead><tr><th>Inner original header</th></tr></thead><tbody>${
        Array.from({ length: 25 }, (_, i) => `<tr><td>Nested row ${i}</td></tr>`).join("")
      }</tbody></table></div></td>`;
      await exec(`getViewerScroller().scrollTop=0;const row=viewer.querySelector('tbody').insertRow(2);row.id='reading-nested-row';row.innerHTML=${JSON.stringify(nested)};true`);
      await settle();
      await exec(`getViewerScroller().scrollTop+=(viewer.querySelector('#nested-reading thead').getBoundingClientRect().top-getViewerScroller().getBoundingClientRect().top)/scrollerScale(getViewerScroller())+100;true`);
      await settle();
      const inner = await exec("Math.abs(viewer.querySelector('#nested-reading thead').getBoundingClientRect().top-getViewerScroller().getBoundingClientRect().top)<2");
      await exec(`getViewerScroller().scrollTop+=(viewer.querySelector('#nested-reading').getBoundingClientRect().bottom-getViewerScroller().getBoundingClientRect().top)/scrollerScale(getViewerScroller())+60;true`);
      await settle();
      check("nested tables pin their own header and resume the enclosing table afterward",
        inner && await exec("Math.abs(viewer.querySelector('table').tHead.getBoundingClientRect().top-getViewerScroller().getBoundingClientRect().top)<2"));
      await exec("document.getElementById('reading-nested-row').remove();true");
      await settle();
    }
    const measurements = [];
    for (const [split, zoom] of [[false, 100], [true, 200]]) {
      await setView(split, zoom);
      await settle();
      const work = await exec(`(async()=>{
      const s=getViewerScroller(),original=Element.prototype.getBoundingClientRect,query=Element.prototype.querySelectorAll,raf=window.requestAnimationFrame;
      let geometry=0,scans=0;
      const costs=[],longTasks=[];
      const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())longTasks.push(e.duration)});
      observer.observe({type:'longtask',buffered:false});
      window.requestAnimationFrame=callback=>raf(time=>{const start=performance.now();callback(time);if(callback.name==='flush')costs.push(performance.now()-start)});
      Element.prototype.getBoundingClientRect=function(...args){if(this.closest?.('#viewer')||this.classList?.contains('index-item'))geometry++;return original.apply(this,args)};
      Element.prototype.querySelectorAll=function(...args){if(this===viewer)scans++;return query.apply(this,args)};
      const frames=[],callbacks=[];let previous=performance.now();
      try{for(let i=0;i<90;i++){const begin=performance.now();s.scrollTop=(s.scrollHeight-s.clientHeight)*(i%30)/29;
        await new Promise(r=>requestAnimationFrame(r));const now=performance.now();frames.push(now-previous);previous=now;callbacks.push(now-begin);}
        frames.sort((a,b)=>a-b);costs.sort((a,b)=>a-b);
        return {geometry,scans,p95:frames[Math.floor(frames.length*.95)],median:frames[Math.floor(frames.length*.5)],
          callbackCount:costs.length,callbackP95:costs[Math.floor(costs.length*.95)]??0,longTasks};
      }finally{Element.prototype.getBoundingClientRect=original;Element.prototype.querySelectorAll=query;window.requestAnimationFrame=raf;observer.disconnect()}
    })()`);
      measurements.push({ split, zoom, ...work });
      console.log("READING_PERF " + JSON.stringify(measurements.at(-1)));
    }
    if (!process.env.FOLIA_READING_PERF) check("settled table and open TOC scrolling performs no geometry reads or viewer scans", measurements.every(work => work.geometry === 0 && work.scans === 0), measurements);
    if (process.env.FOLIA_READING_PERF) {
      check("matched scroll measurement is nonempty", measurements.length === 2 && measurements.every(work => work.p95 > 0));
      check("matched baseline has a real overflowing document", await exec("getViewerScroller().scrollHeight>getViewerScroller().clientHeight+1000"));
      check("matched measurement keeps all original table nodes", await exec("viewer.querySelectorAll('table').length===3"));
      await sentinel.stop();
      return;
    }
    await setView(true, 160);
    win.setSize(1500, 950);
    await settle();
    await exec(`const s=getViewerScroller(),h=viewer.querySelector('thead');s.scrollTop=0;true`);
    await settle();
    await exec(`getViewerScroller().scrollTop+=(viewer.querySelector('thead').getBoundingClientRect().top-getViewerScroller().getBoundingClientRect().top)/scrollerScale(getViewerScroller())+150;true`);
    await settle();
    await capture("sticky-split-zoom");
    const printPosition = await exec("getViewerScroller().scrollTop");
    win.webContents.debugger.attach("1.3");
    try {
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
      await settle();
      check("print keeps semantic headers in natural flow without animated displacement",
        await exec("getComputedStyle(viewer.querySelector('thead')).transform==='none'&&getComputedStyle(viewer.querySelector('thead')).display==='table-header-group'"));
    } finally {
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "" });
      win.webContents.debugger.detach();
    }
    await settle();
    await exec(`getViewerScroller().scrollTop=${printPosition};true`);
    await settle();
    await win.webContents.printToPDF({ printBackground: true }).then(pdf => fs.writeFileSync(path.join(batch, "reading.pdf"), pdf));
    await settle();
    const pdfState = await exec("({top:getViewerScroller().scrollTop,header:viewer.querySelector('thead').getBoundingClientRect().top,port:getViewerScroller().getBoundingClientRect().top,animations:viewer.querySelector('thead').getAnimations().length})");
    check("PDF export contains bytes and screen header tracking resumes", fs.statSync(path.join(batch, "reading.pdf")).size > 10000 &&
      Math.abs(pdfState.header - pdfState.port) < 2, pdfState);
    await exec("viewer.querySelector('#first-long-table').click();true");
    await settle();
    check("collapsing a pinned table retires its animation", await exec("!viewer.querySelector('table').checkVisibility()&&viewer.querySelector('thead').getAnimations().length===0"));
    await exec("viewer.querySelector('#first-long-table').click();true");
    await settle();
    await setView(false, 100);
    win.setSize(1280, 850);
    await exec("getViewerScroller().scrollTop=getViewerScroller().scrollHeight;true");
    const zoomCases = [];
    for (const [round, dark] of [true, false, true].entries()) {
      await setView(false, 100);
      await exec(`if(document.body.classList.contains('dark-mode')!==${dark})document.getElementById('darkModeToggle').click();true`);
      await wait("themed diagrams", "viewer.querySelectorAll('.mermaid svg').length===5&&!loadingScreen.classList.contains('active')");
      await settle();
      const lines = await exec(`(()=>{
        const svgs=[...viewer.querySelectorAll('.mermaid svg')],width=el=>parseFloat(getComputedStyle(el).strokeWidth);
        const flow=svgs[0],sequence=svgs[1],normal=[...flow.querySelectorAll('.edge-thickness-normal')];
        return {dark:document.body.classList.contains('dark-mode'),flow:normal.map(width),
          other:svgs.slice(2).map(svg=>[...svg.querySelectorAll('.edge-thickness-normal:not(.edge-thickness-thick):not(.edge-thickness-invisible),.relation,.relationshipLine')].map(width)),
          message:[...sequence.querySelectorAll('.messageLine0,.messageLine1')].map(width),
          lifeline:[...sequence.querySelectorAll('.actor-line')].map(width),
          dashed:[...svgs[0].querySelectorAll('.flowchart-link')].some(e=>getComputedStyle(e).strokeDasharray!=='none'),
          thick:[...flow.querySelectorAll('.edge-thickness-thick')].map(width),
          invisible:[...flow.querySelectorAll('.edge-thickness-invisible')].map(width),
          authored:normal.some(e=>width(e)===4),
          markers:svgs.every(svg=>[...svg.querySelectorAll('[marker-end]')].every(e=>{const m=e.getAttribute('marker-end').match(/#([^)"']+)/);return !m||!!svg.querySelector('[id="'+CSS.escape(m[1])+'"]')}))};
      })()`);
      check(`Mermaid ${dark ? "dark" : "light"} pass ${round + 1} keeps authored edges dashes invisible edges and markers`,
        lines.dark === dark && lines.authored && lines.dashed && lines.invisible.every(w => w === 0) && lines.thick.every(w => w >= 3) && lines.markers &&
        lines.other.every(widths=>widths.length>0&&widths.every(w=>w===(dark?2:1))) &&
        lines.message.length >= 2 && lines.message.every(w => w === (dark ? 2 : 1.5)) &&
        lines.lifeline.every(w => w === 2), lines);
      await exec("viewer.querySelector('#diagrams').scrollIntoView();true");
      await capture(dark ? "mermaid-dark" : "mermaid-light");
      const native = await exec("[...viewer.querySelectorAll('.mermaid svg')].map(svg=>svg.getAttribute('viewBox'))");
      await setView(false, 200);
      await exec("viewer.querySelector('#diagrams').scrollIntoView();true");
      zoomCases.push(await exec(`(()=>{
        const svgs=[...viewer.querySelectorAll('.mermaid svg')],native=${JSON.stringify(native)};
        return svgs.length===5&&svgs.every((svg,i)=>svg.getAttribute('viewBox')===native[i]&&svg.getBoundingClientRect().height>20);
      })()`));
      await capture(dark ? "mermaid-dark-zoom" : "mermaid-light-zoom");
    }
    check("Mermaid high zoom preserves all five staged SVG geometries in both themes", zoomCases.length === 3 && zoomCases.every(Boolean));
    await exec("viewer.querySelectorAll('.mermaid-maximize-btn')[1].click();true");
    let popup;
    for (let i = 0; i < 100; i++) {
      popup = BrowserWindow.getAllWindows().find(window => window !== win);
      if (popup && await popup.webContents.executeJavaScript("!!document.querySelector('.messageLine0')").catch(() => false)) break;
      await sleep(50);
    }
    if (!popup) throw new Error("Mermaid popup did not open");
    try {
      const popState = await popup.webContents.executeJavaScript(`({
        widths:[...document.querySelectorAll('.messageLine0,.messageLine1')].map(line=>parseFloat(getComputedStyle(line).strokeWidth)),
        isolated:typeof require==='undefined'&&typeof process==='undefined'})`);
      const pdf = await popup.webContents.printToPDF({ printBackground: true });
      fs.writeFileSync(path.join(batch, "mermaid-popup.pdf"), pdf);
      fs.writeFileSync(path.join(batch, "mermaid-popup.png"), (await popup.webContents.capturePage()).toPNG());
      check("dark Mermaid popout and PDF retain stronger messages without privileged page globals",
        popState.widths.length === 2 && popState.widths.every(width => width === 2) && popState.isolated && pdf.length > 1000, popState);
    } finally { popup.close(); }
    await setView(false, 100);
    await exec("document.getElementById('closeIndex').click();getViewerScroller().scrollTop=0;true");
    await settle();
    fs.writeFileSync(first, markdown() + "\n\nExternal version one");
    await wait("actual watcher notice", "document.getElementById('fileUpdateToast').classList.contains('show')");
    const formerOwnerEvent = watcherSnapshot;
    check("visible notice came from the actual affected document watcher", formerOwnerEvent?.path === first && !!formerOwnerEvent?.watcher?.owner, formerOwnerEvent);
    check("watcher notice leaves original document bytes until Reload", await exec("!viewer.textContent.includes('External version one')"));
    await sleep(11000);
    check("File Updated remains visible beyond its former ten-second expiry", await exec("document.getElementById('fileUpdateToast').classList.contains('show')"));
    await capture("persistent-file-update");
    fs.writeFileSync(first, markdown() + "\n\nExternal version two");
    await sleep(1600);
    check("rapid updates retain one actionable notice", await exec("document.querySelectorAll('#fileUpdateToast.show').length===1&&!viewer.textContent.includes('External version two')"));
    await exec("document.getElementById('dismissFileUpdateBtn').click();true");
    check("explicit Dismiss hides the notice and resets suppression", await exec("!document.getElementById('fileUpdateToast').classList.contains('show')&&!fileUpdateNotificationShown"));
    fs.writeFileSync(first, markdown() + "\n\nExternal version three");
    await wait("subsequent actual notice", "document.getElementById('fileUpdateToast').classList.contains('show')");
    const dirty = await exec(`(()=>{
      window.__readingClean=window.originalMarkdown;window.__readingConfirm=window.confirm;
      window.originalMarkdown='# Reading controls\\n\\nUNSAVED_READER_CHANGE';
      window.CustomTabs.updateTabContent(window.originalMarkdown,true);window.setUnsavedState(true);
      window.__readingConfirms=0;window.confirm=()=>{window.__readingConfirms++;return false};
      document.getElementById('reloadFileBtn').click();return true;
    })()`);
    await sleep(250);
    check("declined dirty Reload keeps the notice and unsaved bytes", dirty && await exec("window.__readingConfirms===1&&window.originalMarkdown.includes('UNSAVED_READER_CHANGE')&&hasUnsavedChanges&&document.getElementById('fileUpdateToast').classList.contains('show')"));
    await exec("window.confirm=()=>true;true");
    await exec("document.getElementById('reloadFileBtn').click();true");
    await wait("accepted newest reload", "viewer.textContent.includes('External version three')&&!document.getElementById('fileUpdateToast').classList.contains('show')&&!loadingScreen.classList.contains('active')");
    check("Reload reads the newest version and dismisses only its notice", true);
    await exec("window.confirm=window.__readingConfirm;true");
    fs.writeFileSync(first, markdown() + "\n\nExternal version four");
    await wait("notice before departure", "document.getElementById('fileUpdateToast').classList.contains('show')");
    chosen = other;
    await exec("document.getElementById('openFile').click();true");
    await wait("other admitted document", "viewer.querySelector('h1')?.textContent==='Other reading document'");
    check("committed departure dismisses the previous document notice", await exec("!document.getElementById('fileUpdateToast').classList.contains('show')&&!fileUpdateNotificationShown"));
    send("file-changed-externally", formerOwnerEvent);
    fs.writeFileSync(first, markdown() + "\n\nBackground version five");
    await sleep(1600);
    check("background file changes and former-owner events cannot show a notice over another document",
      await exec("viewer.querySelector('h1')?.textContent==='Other reading document'&&!document.getElementById('fileUpdateToast').classList.contains('show')&&!fileUpdateNotificationShown"));
    fs.writeFileSync(other, "# Other reading document\n\nVISIBLE_OTHER_VERSION_TWO");
    await wait("visible other file notice", "document.getElementById('fileUpdateToast').classList.contains('show')");
    await exec("document.getElementById('reloadFileBtn').click();true");
    await wait("owner-bound other Reload", "viewer.textContent.includes('VISIBLE_OTHER_VERSION_TWO')&&!document.getElementById('fileUpdateToast').classList.contains('show')");
    check("Reload after navigation affects only the visible affected document",
      fs.readFileSync(first, "utf8").includes("Background version five") &&
      await exec("window.currentFilePath===" + JSON.stringify(other)));
    fs.writeFileSync(other, "# Other reading document\n\nVISIBLE_OTHER_VERSION_THREE");
    await wait("notice before active owner close", "document.getElementById('fileUpdateToast').classList.contains('show')");
    await exec("(async()=>{await window.CustomTabs.closeTab(window.CustomTabs.getActiveTabId());return true})()");
    await wait("replacement document after close", "viewer.querySelector('h1')?.textContent==='Reading controls'&&!loadingScreen.classList.contains('active')");
    check("closing the affected document clears its notice before showing a replacement",
      await exec("!document.getElementById('fileUpdateToast').classList.contains('show')&&!fileUpdateNotificationShown&&viewer.textContent.includes('Background version five')"));
    fs.writeFileSync(first, markdown() + "\n\nVisible final version");
    await wait("last owner notice", "document.getElementById('fileUpdateToast').classList.contains('show')");
    await exec("(async()=>{await window.CustomTabs.closeTab(window.CustomTabs.getActiveTabId());return true})()");
    await wait("real Welcome after last close", "window.CustomTabs.getTabs().length===0&&!!viewer.querySelector('.welcome')");
    check("last affected close clears notice and header animations on Welcome",
      await exec("!document.getElementById('fileUpdateToast').classList.contains('show')&&!fileUpdateNotificationShown&&!viewer.querySelector('table')"));
    chosen = other;
    await exec("document.getElementById('openFile').click();true");
    await wait("document reopened for restart", "viewer.querySelector('h1')?.textContent==='Other reading document'&&!loadingScreen.classList.contains('active')");
    win.webContents.send = send;
    const alive = await proveSentinelAlive(win, sentinel);
    check("reading error sentinel proves both channels alive", alive.console && alive.dom, alive);
    const errors = await sentinel.stop();
    check("reading features produce no renderer or visible document errors", errors.hits.length === 0, errors.hits);
    await exec("document.getElementById('toggleIndex').click();true");
  }
  async function restart() {
    const expected = phase === "invalid" ? "closed" : phase;
    const state = await exec(panelState);
    check(`${phase} restores actual drawer visibility across process exit`, state.toc === (expected === "toc") && state.notes === (expected === "notes"), state);
    check(`${phase} restore preserves hidden drawer accessibility`, state.inertToc === (expected !== "toc") && state.inertNotes === (expected !== "notes"), state);
    check(`${phase} restore never focuses a drawer`, !["closeIndex", "closeNotes", "notesSearchInput"].includes(state.focused), state);
    check(`${phase} restart restores the actual admitted document`, await exec("viewer.querySelector('h1')?.textContent==='Other reading document'"));
    if (phase === "toc") await exec("document.getElementById('toggleNotes').click();true");
    if (phase === "notes") await exec("document.getElementById('closeNotes').click();true");
    if (phase === "closed") await exec("localStorage.setItem('readingSidePanel','invalid');true");
  }
  app.whenReady().then(async () => {
    await sleep(1500);
    win = BrowserWindow.getAllWindows()[0];
    win.setSize(1280, 850);
    let failed = false;
    try {
      await wait("production ready", "typeof window.CustomTabs?.getTabs==='function'&&typeof renderMarkdown==='function'");
      if (phase === "screen") await screen();
      else {
        await wait("real saved document restoration", "viewer.querySelector('h1')?.textContent==='Other reading document'&&!loadingScreen.classList.contains('active')");
        await restart();
      }
    } catch (error) {
      failed = true;
      check("reading harness reaches completion", false, error.stack || String(error));
      if (win && !win.isDestroyed()) await capture("FAILED-" + phase);
    }
    session.defaultSession.flushStorageData();
    const summary = `=== reading ${phase}: ${results.filter(Boolean).length}/${results.length} passed ===`;
    app.once("quit", () => console.log(summary));
    app.once("will-quit", () => app.exit(failed || results.some(ok => !ok) ? 1 : 0));
    app.quit();
  });
  setTimeout(() => { console.error("Reading watchdog expired"); app.exit(2); }, 160000);
}
