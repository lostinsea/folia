(function () {
// ============================================
// mermaid-config.js - Mermaid Theme Configuration
// ============================================

/**
 * Label type size for every diagram type, in CSS pixels.
 *
 * One step above the 13px body copy in styles.css: diagram labels sit on top of
 * shapes and connector lines, so they need slightly more weight than running
 * text to stay legible. Declared once because it has to be repeated in three
 * places (top-level `fontSize`, and `fontSize` in each theme's variables) that
 * must not drift apart.
 */
const MERMAID_FONT_PX = 14;

/**
 * Light theme variables for Mermaid diagrams
 */
const MERMAID_LIGHT_THEME = {
  primaryColor: '#279EA7',
  primaryTextColor: '#1F3244',
  primaryBorderColor: '#279EA7',
  lineColor: '#279EA7',
  secondaryColor: '#1F3244',
  tertiaryColor: '#f5f5f5',
  background: '#ffffff',
  mainBkg: '#ffffff',
  secondBkg: '#f5f5f5',
  textColor: '#1F3244',
  border1: '#d0d0d0',
  border2: '#d0d0d0',
  fontSize: MERMAID_FONT_PX + 'px',
  fontFamily: 'Fira Code Local, Fira Code, Segoe UI, Calibri, Arial, sans-serif'
};

/**
 * Dark theme variables for Mermaid diagrams
 */
const MERMAID_DARK_THEME = {
  primaryColor: '#3DBDC6',
  primaryTextColor: '#e8e8e8',
  primaryBorderColor: '#3DBDC6',
  lineColor: '#3DBDC6',
  secondaryColor: '#2d2d2d',
  tertiaryColor: '#1a1a1a',
  background: '#242424',
  mainBkg: '#242424',
  secondBkg: '#2d2d2d',
  textColor: '#e8e8e8',
  border1: '#404040',
  border2: '#404040',
  fontSize: MERMAID_FONT_PX + 'px',
  fontFamily: 'Fira Code Local, Fira Code, Segoe UI, Calibri, Arial, sans-serif'
};

/**
 * Layout geometry shared by every diagram type.
 *
 * Mermaid's defaults draw large shapes around small text: measured on a
 * representative flowchart the label covered only 39.9% of its node box, and a
 * sequence-diagram actor box was 150x65px to hold the word "User" (6.3% fill).
 * A diagram therefore consumed a lot of screen space while still being hard to
 * read - the two complaints are the same problem seen from opposite ends.
 *
 * The instinctive fix - just raise the font size - measurably makes it worse:
 * at 15px with default spacing the flowchart canvas grew 19% while the fill
 * ratio moved only 39.9% -> 42.8%, because mermaid sizes shapes from the text
 * plus fixed padding. The effective levers are the padding and spacing
 * constants, and for sequence diagrams the fixed actor box `width`/`height`.
 *
 * These values were chosen from a measured sweep (see the commit for the full
 * table). Against mermaid's defaults they give, per diagram:
 *   flowchart  fill 39.9% -> 59.5%, canvas area -21.2%
 *   sequence   fill  6.3% ->  9.3%, canvas area -44.2%
 *   class      fill 49.6% -> 61.8%, canvas area -14.2%
 * with no label overflowing its shape in any tested diagram.
 */
const MERMAID_FLOWCHART = {
  // Default 15. This is the gap between a label and its shape edge, and is the
  // single biggest contributor to oversized boxes.
  padding: 6,
  nodeSpacing: 32, // default 50
  rankSpacing: 38, // default 50
  // A single flowchart budget also applies to process boxes: 160 forced
  // ordinary prose into narrow stacks even when the reading pane had room.
  // Native layout still sizes short labels to their text and bounds long ones.
  wrappingWidth: 260,
  htmlLabels: true,
};

const MERMAID_SEQUENCE = {
  // Actor boxes are a fixed size in mermaid, not text-derived, so they are the
  // whole reason a one-word participant gets a 150x65 box.
  width: 118, // default 150
  height: 42, // default 65
  actorMargin: 32, // default 50
  boxTextMargin: 3,
  boxMargin: 8,
  actorFontSize: 15,
  messageFontSize: 14,
  noteFontSize: 13,
};

// Geometry only: labels, markers, chart data and fill-only symbols are not borders.
const MERMAID_BOUNDARIES = [
  ':is(rect,polygon,path,circle,ellipse,line,polyline).label-container',
  '.node > .outer-path > path', '.node > .divider > :is(path,line)',
  '.node > :is(.row-rect-even,.row-rect-odd) > path',
  '.cluster > rect', 'g.classGroup > rect', 'g.stateGroup > rect',
  '.statediagram-cluster rect.outer', '.statediagram-cluster rect.inner',
  '.statediagram-state > g > :is(line,rect).divider',
  '.statediagram-note > g.label-container > path',
  'rect.actor', 'line.actor-line', 'rect.note', 'rect[class^="activation"]',
  'g:is(.actor-top,.actor-bottom) > :is(circle,line,path)',
  'g:is(.actor-top,.actor-bottom) > g > path',
  'polygon.labelBox', 'line.loopLine', 'rect.rect',
  'rect.task', 'rect.journey-section', 'line.task-line',
  '.tag-label-bkg', '.branchLabelBkg', 'path.node-bkg',
  'path.pieCircle', 'circle.pieOuterCircle', '.architecture-groups .node-bkg',
  'rect.packetBlock', 'rect.treemapSection', 'rect.treemapLeaf',
  'rect.treeView-highlight-bg', '.em-box > rect', '.em-swimlane > rect',
  'path.ishikawa-head', 'rect.ishikawa-label-box', '.venn-circle',
  'rect.cynefinItem', 'rect.cynefinItemOverflow', 'path.cynefinBoundary',
  'path.cynefinCliff', 'path.cynefinConfusion',
  '.wardley-node > circle:not([class])', '.wardley-node > rect',
  '.wardley-annotation > circle', '.wardley-annotations-box > rect', 'rect.wardley-pipeline-box',
  '.railroad-terminal > rect', '.railroad-nonterminal > rect',
  '.railroad-comment > ellipse', '.railroad-special > rect',
].join(',');

const MERMAID_CONNECTORS = [
  'path.edge-thickness-normal', 'path.relationshipLine', 'path.relation', 'path.transition',
  ':is(line,path).messageLine0', ':is(line,path).messageLine1',
  '.architecture-edges path.edge', 'line.task-line', 'line.treeView-node-line',
  'path.em-relation', 'line.branch',
  '.ishikawa line:is(.ishikawa-spine,.ishikawa-branch,.ishikawa-sub-branch)',
  'line.wardley-link', 'line.wardley-pipeline-evolution-link', 'path.railroad-line',
].join(',');

function hasMermaidBoundaryStyle(config) {
  return Object.entries(config || {}).some(([key, value]) =>
    key === 'theme' || key === 'themeCSS' || /border|stroke|color|style|edgeWidth|lineThickness/i.test(key) ||
    (key === 'look' && value === 'handDrawn') ||
    (value && typeof value === 'object' && hasMermaidBoundaryStyle(value)));
}

function hasDefaultMermaidActorClasses(group) {
  return [...group.classList].every(name => ['actor', 'actor-man', 'actor-top', 'actor-bottom'].includes(name));
}

function hasInlineMermaidStroke(element, svg, property, type) {
  for (let node = element; node && node !== svg; node = node.parentElement) {
    const value = node.style.getPropertyValue(property);
    if (!value) continue;
    // Mermaid 11.17 writes its own actorBorder inline on special participant
    // groups. Body syntax cannot style these primitives; custom classes and
    // primitive-local or important declarations are still left to the author.
    const generatedActor = type === 'sequence' && property === 'stroke' && node !== element &&
      node.matches('g.actor-top,g.actor-bottom') && hasDefaultMermaidActorClasses(node) &&
      !node.style.getPropertyPriority(property) &&
      (value === '#404040' || value === 'rgb(64, 64, 64)');
    if (!generatedActor) return true;
  }
  return false;
}

/**
 * Set dark border and connector defaults once, before the SVG is displayed.
 * Authored theme settings and inline/class styles keep ownership of their ink.
 */
function applyMermaidDarkBoundaries(svg, parsed) {
  if (hasMermaidBoundaryStyle(parsed.config)) return;
  const type = parsed.diagramType.toLowerCase();
  const boundaries = new Set(svg.querySelectorAll(MERMAID_BOUNDARIES));
  const connectors = new Set(svg.querySelectorAll(MERMAID_CONNECTORS));
  if (type === 'quadrantchart') {
    svg.querySelectorAll('g.border > line').forEach(element => boundaries.add(element));
  }
  if (type === 'c4') {
    svg.querySelectorAll(':scope > g:not([class]) > rect').forEach(element => boundaries.add(element));
    svg.querySelectorAll(':is(line,path):is([marker-start],[marker-end])').forEach(element => connectors.add(element));
  }
  if (type === 'timeline') {
    svg.querySelectorAll('.lineWrapper > line[stroke-width="2"]').forEach(element => connectors.add(element));
  }
  const changes = [];
  for (const element of new Set([...boundaries, ...connectors])) {
    if (element.closest('defs,marker,.state-start,.state-end,.statediagram-start,.statediagram-end')) continue;
    const normalConnector = connectors.has(element);
    if (normalConnector && element.matches('.edge-thickness-thick,.edge-thickness-invisible,[class*="edge-depth-"]')) continue;
    const participant = type === 'sequence' && element.closest('g.actor-top,g.actor-bottom');
    if (participant && !hasDefaultMermaidActorClasses(participant)) continue;
    const style = getComputedStyle(element);
    const width = parseFloat(style.strokeWidth);
    if (!Number.isFinite(width) || width <= 0 || (!normalConnector && width >= 3) ||
        style.stroke === 'none' || style.strokeOpacity === '0' || style.opacity === '0') continue;
    // Quadrant borders are the one default emitted as inline CSS. Their authored
    // configuration was checked above; ordinary inline SVG styling still wins.
    const quadrant = type === 'quadrantchart' && element.matches('g.border > line');
    const ownWidth = !quadrant && hasInlineMermaidStroke(element, svg, 'stroke-width', type);
    // C4 container commands write authored colors as presentation attributes,
    // indistinguishable from the default. Widen those borders without recoloring.
    const ownColor = (!quadrant && hasInlineMermaidStroke(element, svg, 'stroke', type)) ||
      (type === 'c4' && element.hasAttribute('stroke'));
    const rgb = style.stroke.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    const neutral = rgb && Math.max(...rgb.slice(1).map(Number)) < 128 &&
      Math.max(...rgb.slice(1).map(Number)) - Math.min(...rgb.slice(1).map(Number)) < 12;
    changes.push({
      element, width: ownWidth ? null : normalConnector ? 1.5 : Math.max(width, 1.5),
      color: boundaries.has(element) && !ownColor && neutral
    });
  }
  // Read styles first, then write. This never runs during scrolling or on cache hits.
  for (const { element, width, color } of changes) {
    if (width !== null) element.style.setProperty('stroke-width', width + 'px');
    if (color) element.style.setProperty('stroke', '#74818f');
  }
}

/**
 * Get full Mermaid configuration object
 * @param {boolean} isDark - Whether dark mode is enabled
 * @returns {object} Mermaid configuration object
 */
function getMermaidConfig(isDark) {
  return {
    startOnLoad: true,
    theme: isDark ? 'dark' : 'default',
    // Declared at the top level as well as in themeVariables: mermaid uses the
    // top-level value for layout maths and themeVariables for the emitted CSS,
    // and leaving the top-level one unset let some diagram types fall back to
    // their own default (sequence diagrams rendered at 16px while flowcharts
    // rendered at 13px, an inconsistency visible side by side in one document).
    fontSize: MERMAID_FONT_PX,
    themeCSS: '.nodeLabel { overflow-wrap: anywhere; }',
    themeVariables: isDark ? MERMAID_DARK_THEME : MERMAID_LIGHT_THEME,
    flowchart: MERMAID_FLOWCHART,
    sequence: MERMAID_SEQUENCE
  };
}

const mermaidConfig = {
  MERMAID_LIGHT_THEME,
  MERMAID_DARK_THEME,
  MERMAID_FLOWCHART,
  MERMAID_SEQUENCE,
  MERMAID_FONT_PX,
  getMermaidConfig,
  applyMermaidDarkBoundaries
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = mermaidConfig;
}
if (typeof window !== 'undefined') {
  window.FoliaMermaidConfig = mermaidConfig;
}
})();
