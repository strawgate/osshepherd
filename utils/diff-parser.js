// @ts-check
/**
 * Parses a unified diff string into an array of file objects.
 * No Chrome APIs, no DOM. Safe to require() in Node.js tests.
 */

/**
 * @typedef {Object} ParsedFile
 * @property {string}  filename
 * @property {string}  diff
 * @property {boolean} newFile
 * @property {boolean} deletedFile
 */

/**
 * @param {string} diff
 * @returns {ParsedFile[]}
 */
function parseDiff(diff) {
  const files = [];
  if (!diff || !diff.trim()) return files;

  const chunks = diff.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const match = lines[0].match(/^a\/(.+)\s+b\/(.+)$/);
    if (!match) continue;
    files.push({
      filename: match[2],
      diff: 'diff --git ' + chunk,
      newFile: chunk.includes('\nnew file mode'),
      deletedFile: chunk.includes('\ndeleted file mode'),
    });
  }
  return files;
}

if (typeof module !== 'undefined') {
  module.exports = { parseDiff };
} else {
  globalThis.CRDiffParser = { parseDiff };
}
