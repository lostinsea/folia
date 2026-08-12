// ============================================
// file-helpers.js - File Operations (Main Process)
// ============================================

const fs = require('fs');
const path = require('path');

/**
 * Supported file extensions
 */
const SUPPORTED_EXTENSIONS = {
  markdown: ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'],
  mermaid: ['.mmd', '.mermaid'],
};

// Cost model for estimateRenderUnits(). Both constants are FITTED to
// measurements in bench/BASELINE.md and should be re-derived, not adjusted by
// taste, if the renderer's cost profile changes.
//
// MS_PER_UNIT is the conservative end of the seven profiles (lists, 47us);
// the median is nearer 34us, so the estimate errs toward warning early, which
// is the correct direction for a guard. FENCED_LINE_DISCOUNT is why the `code`
// profile - 38415 of its 48019 lines inside fences - is not mistaken for the
// most expensive document in the corpus when it is nearly the cheapest.
const MS_PER_UNIT = 0.047;
const FENCED_LINE_DISCOUNT = 0.8;

// A document predicted to take longer than this to become readable is treated
// as large. At 10s this is roughly 2.1 MB of dense tables, 4.9 MB of mixed
// content, or 35 MB of prose - it targets documents that are expensive, not
// documents that are merely long.
const LARGE_DOC_BUDGET_MS = 10000;

/**
 * Check if file is a Mermaid diagram file
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isMermaidFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.mermaid.includes(ext);
}

/**
 * Check if file is a Markdown file (or viewable format: mermaid)
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isMarkdownFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.markdown.includes(ext) ||
         SUPPORTED_EXTENSIONS.mermaid.includes(ext);
}

/**
 * Wrap content in mermaid code block if it's a mermaid file
 * @param {string} content - File content
 * @param {string} filePath - Path to the file
 * @returns {string} Wrapped or original content
 */
function wrapMermaidContent(content, filePath) {
  if (isMermaidFile(filePath)) {
    // Check if already wrapped in mermaid code block
    const trimmed = content.trim();
    if (trimmed.startsWith('```mermaid') || trimmed.startsWith('~~~mermaid')) {
      return content; // Already wrapped
    }
    // Wrap in mermaid code block
    return '```mermaid\n' + content + '\n```';
  }
  return content;
}

/**
 * Remove BOM (Byte Order Mark) if present
 * @param {string} content - File content
 * @returns {string} Content without BOM
 */
function removeBOM(content) {
  if (content && content.charCodeAt(0) === 0xFEFF) {
    return content.substring(1);
  }
  return content;
}

/**
 * Estimate how much work rendering a document will be, WITHOUT parsing it.
 *
 * Byte count is not usable for this. Measured across the seven benchmark
 * profiles at an identical 1 MB, render time spans 260ms to 3353ms - a 12.9x
 * spread - because bytes measure how much text was typed, not how many nodes
 * it becomes. Counting lines instead is worse still (26.9x): a fenced code
 * block is thousands of cheap lines, a table is few but expensive ones.
 *
 * What does predict cost is block count plus table cells, with lines inside
 * fenced code discounted because they skip inline parsing. That scores 1.7x
 * across all seven profiles, including the four it was not fitted on. See
 * bench/BASELINE.md, "Byte count is the wrong trigger for the size guard".
 *
 * One O(n) character pass, 3.5-6.9 ms per MB - about 0.2% of the render it is
 * deciding whether to attempt. Fence state is tracked so that pipes inside
 * code blocks are not miscounted as table cells.
 *
 * @param {string} content - Raw markdown
 * @returns {{units: number, lines: number, fencedLines: number, pipes: number}}
 */
function estimateRenderUnits(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { units: 0, lines: 0, fencedLines: 0, pipes: 0 };
  }
  let lines = 1;
  let pipes = 0;
  let fencedLines = 0;
  let inFence = false;
  let atLineStart = true;
  let fenceRun = 0;
  let lineHasContent = false;

  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === 10) {
      lines++;
      if (inFence) fencedLines++;
      if (fenceRun >= 3) {
        inFence = !inFence;
        if (inFence) fencedLines++;
      }
      atLineStart = true;
      fenceRun = 0;
      lineHasContent = false;
      continue;
    }
    if (c === 96 && atLineStart) {
      fenceRun++;
      continue;
    }
    if ((c === 32 || c === 9) && !lineHasContent) continue;
    atLineStart = false;
    lineHasContent = true;
    if (c === 124 && !inFence) pipes++;
  }

  const units = Math.max(0, lines - FENCED_LINE_DISCOUNT * fencedLines + pipes);
  return { units, lines, fencedLines, pipes };
}

/**
 * Predicted time-to-readable in milliseconds.
 * @param {string} content - Raw markdown
 * @returns {number}
 */
function estimateRenderMs(content) {
  return estimateRenderUnits(content).units * MS_PER_UNIT;
}

/**
 * Would this document take longer than the budget to become readable?
 * @param {string} content - Raw markdown
 * @param {number} [budgetMs] - Override the default budget
 * @returns {{large: boolean, estimatedMs: number, units: number}}
 */
function isLargeDocument(content, budgetMs = LARGE_DOC_BUDGET_MS) {
  const { units } = estimateRenderUnits(content);
  const estimatedMs = units * MS_PER_UNIT;
  return { large: estimatedMs > budgetMs, estimatedMs, units };
}

/**
 * Read a markdown file with BOM removal and mermaid wrapping
 * @param {string} filePath - Path to the file
 * @param {function} callback - Callback(err, data)
 */
function readMarkdownFile(filePath, callback) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      callback(err, null);
      return;
    }
    // Remove BOM if present
    data = removeBOM(data);
    // Wrap mermaid files
    data = wrapMermaidContent(data, filePath);
    callback(null, data);
  });
}

/**
 * Send IPC result with standard format
 * @param {object} webContents - Electron webContents
 * @param {string} channel - IPC channel name
 * @param {boolean} success - Whether operation succeeded
 * @param {object} data - Additional data to send
 */
function sendIPCResult(webContents, channel, success, data = {}) {
  webContents.send(channel, { success, ...data });
}

// Export for use in other modules
module.exports = {
  SUPPORTED_EXTENSIONS,
  MS_PER_UNIT,
  FENCED_LINE_DISCOUNT,
  LARGE_DOC_BUDGET_MS,
  isMermaidFile,
  isMarkdownFile,
  wrapMermaidContent,
  removeBOM,
  estimateRenderUnits,
  estimateRenderMs,
  isLargeDocument,
  readMarkdownFile,
  sendIPCResult
};
