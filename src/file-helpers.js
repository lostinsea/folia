// ============================================
// file-helpers.js - File Operations (Main Process)
// ============================================

const fs = require('fs');
const fileHelpersCore = require('./file-helpers-core');
const { removeBOM, wrapMermaidContent } = fileHelpersCore;

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

// Preserve the main-process API while browser consumers load only the pure core.
module.exports = {
  ...fileHelpersCore,
  readMarkdownFile,
  sendIPCResult
};
