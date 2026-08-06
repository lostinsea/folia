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
  isMermaidFile,
  isMarkdownFile,
  wrapMermaidContent,
  removeBOM,
  readMarkdownFile,
  sendIPCResult
};
