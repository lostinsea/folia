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

// Export for use in other modules
module.exports = {
  removeBOM,
  getFileName,
  getDirectory,
  escapeRegex,
  formatBytes
};
