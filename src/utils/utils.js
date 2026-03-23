// @ts-check
/**
 * Shared utilities. No Chrome APIs, no DOM. Safe to require() in Node.js tests.
 */

/** @returns {string} */
function generateUUID() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * @param {number|null|undefined} timestamp - Unix ms timestamp
 * @returns {string}
 */
function formatRelativeTime(timestamp) {
  if (timestamp == null) return '';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

if (typeof module !== 'undefined') {
  module.exports = { generateUUID, formatRelativeTime };
} else {
  globalThis.CRUtils = { generateUUID, formatRelativeTime };
}
