// ============================================
// notification-helpers.js - Toast & Notification Functions
// ============================================

/**
 * Show a toast notification
 * @param {HTMLElement} toastElement - The toast container element
 * @param {HTMLElement|null} messageElement - The message element inside toast (optional)
 * @param {string} message - The message to display
 * @param {number} duration - Duration in ms (0 for no auto-hide)
 */
function showToast(toastElement, messageElement, message, duration = 3000) {
  if (messageElement) {
    messageElement.textContent = message;
  }
  toastElement.classList.add('show');

  if (duration > 0) {
    setTimeout(() => {
      toastElement.classList.remove('show');
    }, duration);
  }
}

/**
 * Hide a toast notification
 * @param {HTMLElement} toastElement - The toast container element
 */
function hideToast(toastElement) {
  toastElement.classList.remove('show');
}

/**
 * Show the loading screen overlay
 * @param {HTMLElement} loadingElement - The loading screen element
 */
function showLoadingScreen(loadingElement) {
  loadingElement.classList.add('active');
}

/**
 * Hide the loading screen overlay
 * @param {HTMLElement} loadingElement - The loading screen element
 */
function hideLoadingScreen(loadingElement) {
  loadingElement.classList.remove('active');
}

// Export for use in other modules
module.exports = {
  showToast,
  hideToast,
  showLoadingScreen,
  hideLoadingScreen
};
