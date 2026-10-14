(function () {
  // ============================================
  // utils.js - Shared Utility Functions
  // ============================================

  /**
   * Remove BOM (Byte Order Mark) if present at start of content
   * @param {string} content - The content to process
   * @returns {string} Content without BOM
   */
  function removeBOM(content) {
    if (content && content.charCodeAt(0) === 0xFEFF) {
      return content.substring(1);
    }
    return content;
  }

  /**
   * Get filename from a file path (cross-platform)
   * @param {string} filePath - The full file path
   * @returns {string} Just the filename
   */
  function getFileName(filePath) {
    if (!filePath) return '';
    return filePath.split(/[\\/]/).pop();
  }

  /**
   * Get directory from a file path (cross-platform)
   * @param {string} filePath - The full file path
   * @returns {string} The directory path
   */
  function getDirectory(filePath) {
    if (!filePath) return '';
    const parts = filePath.split(/[\\/]/);
    parts.pop();
    return parts.join('/');
  }

  // Lexical correlation only. Main's admitted descriptors and fresh checks
  // supply physical identity; this never probes a path or resolves from CWD.
  function normaliseDocumentPath(filePath) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
      return null;
    }
    const windows = typeof navigator !== 'undefined' &&
      /^Win/.test(navigator.platform);
    const separator = windows ? '\\' : '/';
    const source = windows ? filePath.replace(/\//g, '\\') : filePath;
    let root;
    if (windows) {
      const drive = /^[a-z]:\\/i.exec(source);
      const share = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.exec(source);
      root = drive ? drive[0] : share ? share[0].replace(/\\?$/, '\\') : null;
    } else {
      root = source.startsWith('/') ? '/' : null;
    }
    if (!root) return null;
    const parts = [];
    for (const part of source.slice(root.length).split(separator)) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    let resolved = root + parts.join(separator);
    if (parts.length && source.endsWith(separator)) resolved += separator;
    return Object.freeze({
      resolved,
      spelling: windows ? resolved.toLowerCase() : resolved,
    });
  }

  /**
   * Escape special regex characters in a string
   * @param {string} string - The string to escape
   * @returns {string} Escaped string safe for use in RegExp
   */
  function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Format bytes to human readable string
   * @param {number} bytes - Number of bytes
   * @returns {string} Formatted string (e.g., "1.5 MB")
   */
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  const utils = {
    removeBOM,
    getFileName,
    getDirectory,
    normaliseDocumentPath,
    escapeRegex,
    formatBytes
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = utils;
  }
  if (typeof window !== 'undefined') {
    window.FoliaUtils = utils;
  }
})();
