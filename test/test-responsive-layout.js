"use strict";

require("./test-userdata-isolation");

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
require("../src/main.js");

const evidence = process.env.FOLIA_LAYOUT_EVIDENCE ||
  path.join(__dirname, "..", "tmp", "responsive-layout");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const description =
  "This final column explains how a reading session handles a document after a change, " +
  "including the actions the reader can take before the next refresh and why they matter.";
const table = [
  "| ID | Env | Owner | State | Tier | Final description |",
  "| --- | --- | --- | --- | --- | --- |",
  ...Array.from({ length: 12 }, (_, i) =>
    `| row-${i} | dev | teamalpha | pending | gold | ${description} |`),
].join("\n");
const markdown = "# Responsive reading\n\n## Table\n\n" + table + "\n\n## End\n\nEnd of document.";
const diagram = [
  "flowchart TD",
  'A["Resolve trusted resource bindings and authorize access to every requested query input"]',
  'B["Bind each query and stage using its language grammar and validate type constraints"]',
  'C{"`Each query or stage language`"}',
  'D["First explicit line<br/>Second explicit line"]',
  'E["Done"]',
  "A --> B --> C",
  "C --> D --> E",
].join("\n");
const diagramMarkdown = "# Diagram sizing\n\n```mermaid\n" + diagram + "\n```";

async function waitFor(exec, expression) {
  for (let i = 0; i < 120; i++) {
    if (await exec(expression)) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for " + expression);
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const exec = js => win.webContents.executeJavaScript(js);
  const results = [];
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  };
  try {
    await waitFor(exec, "typeof renderMarkdown==='function' && !!window.CustomTabs");
    fs.mkdirSync(evidence, { recursive: true });
    win.unmaximize();
    for (const scenario of [
      { name: "roomy-closed", width: 1500, toc: false, split: false, zoom: 100 },
      { name: "roomy-toc", width: 1500, toc: true, split: false, zoom: 100 },
      { name: "narrow-toc", width: 1000, toc: true, split: false, zoom: 100 },
      { name: "narrow-split-toc", width: 1000, toc: true, split: true, zoom: 100 },
      { name: "narrow-zoom-toc", width: 1000, toc: true, split: false, zoom: 160 },
    ]) {
      win.setSize(scenario.width, 850);
      await waitFor(exec, `Math.abs(innerWidth-${win.getContentBounds().width})<=1`);
      await exec(`if(isEditMode!==${scenario.split})document.getElementById('toggleEdit').click();
        document.documentElement.style.setProperty('--toc-width','520px');
        setIndexVisible(${scenario.toc});zoomLevel=${scenario.zoom};updateZoom();true`);
      await exec(`renderMarkdown(${JSON.stringify(markdown)},'full')`);
      await waitFor(exec, "viewer.querySelectorAll('table tbody tr').length===12");
      await sleep(450);
      const measured = await exec(`(async()=>{
        const table=viewer.querySelector('table'),cont=table.closest('.table-container');
        const wrapper=document.querySelector('.content-wrapper');
        const cell=table.tBodies[0].rows[0].cells[5];
        const s=getViewerScroller(),head=table.tHead;
        s.scrollTop=0;
        s.scrollTop+=(head.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+100;
        for(let i=0;i<45;i++){
          await new Promise(r=>requestAnimationFrame(r));
          if(Math.abs(head.getBoundingClientRect().top-s.getBoundingClientRect().top)<2)break;
        }
        const headTop=head.getBoundingClientRect().top, scrollerTop=s.getBoundingClientRect().top;
        const headPinned=Math.abs(headTop-scrollerTop)<2;
        s.scrollTop=0;cont.scrollLeft=0;
        cell.scrollIntoView({block:'center'});
        const body=cell.getBoundingClientRect(),header=head.rows[0].cells[5].getBoundingClientRect();
        const range=document.createRange();
        range.selectNodeContents(cell);
        const textRects=[...range.getClientRects()].filter(r=>r.width>1);
        const measured={
          window:innerWidth,drawer:indexPanel.getBoundingClientRect().width,
          wrapper:wrapper.getBoundingClientRect().toJSON(),
          container:cont.getBoundingClientRect().toJSON(),
          table:table.getBoundingClientRect().toJSON(),
          finalCell:body.toJSON(),
          textLines:textRects.map(r=>r.toJSON()),
          scrollWidth:cont.scrollWidth,clientWidth:cont.clientWidth,scrollLeft:cont.scrollLeft,
          breakout:cont.classList.contains('table-breakout'),
          headAligned:Math.abs(header.left-body.left)<1,
          headPinned,headTop,scrollerTop,stickyScrollTop:s.scrollTop,stickyScrollHeight:s.scrollHeight,
        };
        return measured;
      })()`);
      fs.writeFileSync(path.join(evidence, scenario.name + ".png"),
        (await win.webContents.capturePage()).toPNG());
      results.push({ scenario, measured });
      const narrowSplit = scenario.name === "narrow-split-toc";
      check(`${scenario.name} keeps the final column readable${narrowSplit ? " with an accessible narrow-pane fallback" : " without sideways scrolling"}`,
        (narrowSplit ? measured.scrollWidth > measured.clientWidth + 1 &&
          measured.scrollLeft > 0 : measured.scrollWidth <= measured.clientWidth + 1 &&
          measured.scrollLeft === 0) &&
          measured.finalCell.right <= measured.container.right + 1 &&
          measured.textLines.length >= 2 &&
          measured.textLines.every(r => r.left >= measured.finalCell.left - 1 &&
            r.right <= measured.finalCell.right + 1),
        { scroll: measured.scrollWidth - measured.clientWidth, right: measured.finalCell.right -
          measured.container.right, lines: measured.textLines.length });
      check(`${scenario.name} keeps the original header pinned and aligned`,
        measured.headPinned && measured.headAligned, measured);
      console.log(JSON.stringify(results.at(-1)));
    }
    fs.writeFileSync(path.join(evidence, "geometry.json"), JSON.stringify(results, null, 2));
    win.setSize(1000, 850);
    const splitter = await exec(`(async()=>{
      if(!isEditMode)document.getElementById('toggleEdit').click();
      setIndexVisible(true);zoomLevel=100;updateZoom();
      await renderMarkdown(${JSON.stringify(markdown)},'full');
      await new Promise(r=>setTimeout(r,250));
      applyEditorSplitRatio(0.15);applyTableBreakout();
      const table=viewer.querySelector('table'),cont=table.closest('.table-container');
      const wide={pane:viewer.getBoundingClientRect().width,
        overflow:cont.scrollWidth>cont.clientWidth+1,wrap:table.classList.contains('wrap-anyway')};
      editorSplitter.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      const reset={pane:viewer.getBoundingClientRect().width,
        overflow:cont.scrollWidth>cont.clientWidth+1,wrap:table.classList.contains('wrap-anyway')};
      applyTableBreakout();
      const prepared=table.classList.contains('wrap-anyway');
      const host=contentWrapper.getBoundingClientRect(),x=host.left+host.width*0.15;
      editorSplitter.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,buttons:1,pointerId:1}));
      document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,button:0,buttons:1,pointerId:1,clientX:x}));
      document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,buttons:0,pointerId:1}));
      const dragged={pane:viewer.getBoundingClientRect().width,
        overflow:cont.scrollWidth>cont.clientWidth+1,wrap:table.classList.contains('wrap-anyway')};
      return {wide,reset,prepared,dragged};
    })()`);
    fs.writeFileSync(path.join(evidence, "table-splitter-drag.png"),
      (await win.webContents.capturePage()).toPNG());
    check("splitter fixture crosses the wrapping threshold",
      splitter.wide.pane > splitter.reset.pane + 150 &&
        splitter.dragged.pane > splitter.reset.pane + 150 &&
        !splitter.wide.overflow && splitter.reset.overflow &&
        !splitter.dragged.overflow, splitter);
    check("splitter reset recomputes table wrapping",
      !splitter.wide.wrap && splitter.reset.wrap, splitter);
    check("splitter drag release recomputes table wrapping",
      splitter.prepared && !splitter.dragged.wrap, splitter);
    const longToken = "https://example.invalid/reference/" + "section".repeat(9);
    const codeToken = "versionIdentifier".repeat(7);
    const richTable = table.replace(description,
      `[${longToken}](${longToken}) and \`${codeToken}\` with explanatory text`);
    await exec("if(isEditMode)document.getElementById('toggleEdit').click();setIndexVisible(true);zoomLevel=100;updateZoom();true");
    win.setSize(1000, 850);
    await exec(`renderMarkdown(${JSON.stringify("# Links and code\n\n" + richTable +
      "\n\n```text\n  preserve  exact  spacing\n```")},'full')`);
    await waitFor(exec, "viewer.querySelector('table tbody a') && viewer.querySelector('table tbody code')");
    await sleep(350);
    const rich = await exec(`(async()=>{
      const container=viewer.querySelector('.table-container'),cell=viewer.querySelector('table tbody tr td:last-child');
      container.scrollLeft=container.scrollWidth;
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const fragments=[cell.querySelector('a'),cell.querySelector('code')].map(el=>{
        const range=document.createRange();range.selectNodeContents(el);
        return [...range.getClientRects()].map(r=>r.toJSON());
      });
      return {scrollWidth:container.scrollWidth,clientWidth:container.clientWidth,
        scrollLeft:container.scrollLeft,container:container.getBoundingClientRect().toJSON(),
        cell:cell.getBoundingClientRect().toJSON(),
        fragments,text:cell.textContent,preSpace:getComputedStyle(viewer.querySelector('pre')).whiteSpace};
    })()`);
    fs.writeFileSync(path.join(evidence, "table-link-code.png"),
      (await win.webContents.capturePage()).toPNG());
    check("long link and inline code remain readable without changing preformatted spacing",
      rich.text.includes(longToken) && rich.text.includes(codeToken) &&
      rich.preSpace.startsWith("pre") &&
      (rich.scrollWidth <= rich.clientWidth + 1 || rich.scrollLeft > 0) &&
      rich.cell.right <= rich.container.right + 1 &&
      rich.fragments.every(rects => rects.length > 1 &&
        rects.every(r => r.left >= rich.cell.left - 1 && r.right <= rich.cell.right + 1 &&
          r.right <= rich.container.right + 1)),
      { scrollWidth: rich.scrollWidth, clientWidth: rich.clientWidth,
        scrollLeft: rich.scrollLeft, cellRight: rich.cell.right, containerRight: rich.container.right,
        fragments: rich.fragments, preSpace: rich.preSpace });
    console.log(JSON.stringify({richTable: {scrollWidth: rich.scrollWidth,
      clientWidth: rich.clientWidth, cellRight: rich.cell.right,
      containerRight: rich.container.right, fragments: rich.fragments}}));
    const diagrams = [];
    for (const scenario of [
      { name: "diagram-roomy", width: 1500, toc: false, split: false, zoom: 100 },
      { name: "diagram-toc", width: 1500, toc: true, split: false, zoom: 100 },
      { name: "diagram-narrow", width: 850, toc: true, split: false, zoom: 100 },
      { name: "diagram-split", width: 1000, toc: true, split: true, zoom: 100 },
    ]) {
      win.setSize(scenario.width, 850);
      await sleep(300);
      await exec(`if(isEditMode!==${scenario.split})document.getElementById('toggleEdit').click();
        setIndexVisible(${scenario.toc});zoomLevel=${scenario.zoom};updateZoom();true`);
      await exec(`renderMarkdown(${JSON.stringify(diagramMarkdown)},'full')`);
      await waitFor(exec, "viewer.querySelectorAll('.mermaid svg g.node').length===5");
      await exec("document.fonts.ready");
      await sleep(250);
      const measured = await exec(`(()=>{
        const svg=viewer.querySelector('.mermaid svg');
        const nodes=[...svg.querySelectorAll('g.node')].map(node=>{
          const shape=node.querySelector('rect,polygon,path'),label=node.querySelector('.nodeLabel');
          const foreign=node.querySelector('foreignObject'),range=document.createRange();
          const fragments=[],walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);
          while(walker.nextNode()){range.selectNodeContents(walker.currentNode);
            fragments.push(...[...range.getClientRects()].filter(r=>r.width>1).map(r=>r.toJSON()))}
          return {id:node.id,text:label.textContent,shape:shape.getBoundingClientRect().toJSON(),
            foreign:foreign?.getBoundingClientRect().toJSON(),fragments,
            lines:[...new Set(fragments.map(r=>Math.round(r.top)))].length};
        });
        svg.scrollIntoView({block:'center'});
        return {window:innerWidth,reader:viewer.getBoundingClientRect().toJSON(),
          svg:svg.getBoundingClientRect().toJSON(),viewBox:svg.getAttribute('viewBox'),
          links:svg.querySelectorAll('.flowchart-link').length,nodes};
      })()`);
      fs.writeFileSync(path.join(evidence, scenario.name + ".png"),
        (await win.webContents.capturePage()).toPNG());
      diagrams.push({ scenario, measured });
      const byId = Object.fromEntries(measured.nodes.map(node =>
        [node.id.match(/flowchart-([A-E])-/)?.[1], node]));
      const nativeScale = parseFloat(measured.viewBox.split(/\s+/)[2]) / measured.svg.width;
      const nativeWidth = node => node?.shape.width * nativeScale;
      check(`${scenario.name} gives long rectangles room before wrapping`,
        byId.A?.lines === 3 && byId.B?.lines === 3 &&
          nativeWidth(byId.A) >= 260 && nativeWidth(byId.A) <= 300,
        measured.nodes.map(node => [node.id, node.lines, nativeWidth(node)]));
      check(`${scenario.name} retains explicit breaks, intrinsic short labels and native shape bounds`,
        byId.D?.lines === 2 && byId.E?.lines === 1 &&
          byId.E.shape.width < byId.A.shape.width / 2 &&
          measured.nodes.length === 5 && measured.links === 4 &&
          measured.nodes.every(node => node.fragments.length > 0 &&
            node.fragments.every(r => r.left >= node.foreign.left - 1 &&
              r.right <= node.foreign.right + 1 &&
              r.top >= node.foreign.top - 1 &&
              r.bottom <= node.foreign.bottom + 1)),
        measured.nodes.map(node => [node.id, node.lines]));
      check(`${scenario.name} bounds the decision with native Mermaid layout`,
        nativeWidth(byId.C) <= 300 && nativeWidth(byId.C) >= 210 &&
          byId.C.lines >= 1 && byId.C.lines <= 2,
        [nativeWidth(byId.C), byId.C?.lines]);
      console.log(JSON.stringify({ scenario, measured: {
        viewBox: measured.viewBox,
        nodes: measured.nodes.map(({ id, shape, lines }) => ({ id, width: shape.width, lines })),
      } }));
    }
    fs.writeFileSync(path.join(evidence, "diagrams.json"), JSON.stringify(diagrams, null, 2));
    const authoredSource = '%%{init: {"flowchart": {"wrappingWidth": 120}}}%%\n' +
      diagram + "\nstyle A stroke:#ff0000,stroke-width:3px";
    await exec("if(isEditMode)document.getElementById('toggleEdit').click();setIndexVisible(false);true");
    win.setSize(1500, 850);
    await exec(`renderMarkdown(${JSON.stringify("# Authored diagram\n\n```mermaid\n" + authoredSource + "\n```")},'full')`);
    await waitFor(exec, "viewer.querySelectorAll('.mermaid svg g.node').length===5");
    const authored = await exec(`(()=>{
      const svg=viewer.querySelector('.mermaid svg');
      const a=svg.querySelector('[id*="flowchart-A-"]');
      const d=svg.querySelector('[id*="flowchart-D-"]');
      return {labelWidth:a.querySelector('foreignObject').getBoundingClientRect().width,
        stroke:getComputedStyle(a.querySelector('rect')).stroke,
        strokeWidth:parseFloat(getComputedStyle(a.querySelector('rect')).strokeWidth),
        explicit:d.querySelector('.nodeLabel').innerHTML.includes('<br')};
    })()`);
    fs.writeFileSync(path.join(evidence, "diagram-authored.png"),
      (await win.webContents.capturePage()).toPNG());
    check("author diagram keeps its narrower wrapping, explicit break and red border",
      authored.labelWidth <= 122 && authored.explicit &&
        authored.stroke === "rgb(255, 0, 0)" && authored.strokeWidth === 3, authored);
    await exec("document.getElementById('darkModeToggle').click();true");
    await exec("whenMermaidSettled()");
    const themed = await exec(`(()=>{
      const svg=viewer.querySelector('.mermaid svg'),a=svg.querySelector('[id*="flowchart-A-"]');
      return {count:svg.querySelectorAll('g.node').length,
        width:a.querySelector('foreignObject').getBoundingClientRect().width,
        stroke:getComputedStyle(a.querySelector('rect')).stroke};
    })()`);
    fs.writeFileSync(path.join(evidence, "diagram-authored-themed.png"),
      (await win.webContents.capturePage()).toPNG());
    check("theme re-render keeps author sizing and border",
      themed.count === 5 && themed.width <= 122 && themed.stroke === "rgb(255, 0, 0)", themed);
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
    return;
  }
  // Keep Electron alive until the tracked window's shutdown diagnostic lands.
  const cleanupWindow = new BrowserWindow({ show: false });
  win.destroy();
  await sleep(50);
  console.log(`=== ${checks.filter(Boolean).length}/${checks.length} passed ===`);
  cleanupWindow.destroy();
  app.exit(checks.every(Boolean) ? 0 : 1);
});

setTimeout(() => {
  console.error("Responsive layout watchdog expired");
  app.exit(2);
}, 120000);
