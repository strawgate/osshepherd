// @ts-check
/**
 * Minimal GitHub-flavored Markdown renderer for CodeRabbit output.
 * Handles the subset of GFM that CodeRabbit actually produces:
 *   fenced code blocks (with diff highlighting), inline code, bold, italic,
 *   links, headings, lists, horizontal rules, and HTML pass-through
 *   (details/summary). No external dependencies.
 */

(function () {
  'use strict';

  const BLOCK_HTML_RE = /^<\/?(details|summary|div|table|thead|tbody|tr|th|td|blockquote)\b/i;

  /** @param {string} str */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** @param {string} str */
  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  /**
   * Process inline markdown on already-escaped text.
   * Code spans are extracted first so bold/italic don't apply inside them.
   * @param {string} escaped
   * @returns {string}
   */
  function processInline(escaped) {
    // 1. Extract inline code spans to protect their contents from bold/italic processing.
    //    NUL (\x00) bytes are used as placeholder delimiters — they never appear in
    //    normal input text and are safe as temporary tokens during the replacement pass.
    const codeSpans = [];
    let result = escaped.replace(/`([^`]+)`/g, (_, code) => {
      codeSpans.push(`<code>${code}</code>`);
      return `\x00C${codeSpans.length - 1}\x00`;
    });

    // 2. Bold **text**
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 3. Italic *text* (not inside bold)
    result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // 4. Links [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
      `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${text}</a>`
    );

    // 5. Restore code spans
    result = result.replace(/\x00C(\d+)\x00/g, (_, idx) => codeSpans[Number(idx)]);

    return result;
  }

  /**
   * Render a fenced code block. Diff blocks get line-level colouring.
   * @param {string} lang
   * @param {string} code
   * @returns {string}
   */
  function renderCodeBlock(lang, code) {
    if (lang === 'diff') {
      const lines = code.split('\n').map(line => {
        const esc = escapeHtml(line);
        if (line.startsWith('+')) return `<span class="cr-diff-add">${esc}</span>`;
        if (line.startsWith('-')) return `<span class="cr-diff-del">${esc}</span>`;
        if (line.startsWith('@@')) return `<span class="cr-diff-hunk">${esc}</span>`;
        return esc;
      });
      return `<pre class="cr-code-block cr-diff"><code>${lines.join('\n')}</code></pre>`;
    }
    const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
    return `<pre class="cr-code-block"><code${cls}>${escapeHtml(code)}</code></pre>`;
  }

  /**
   * Render markdown text to HTML.
   * @param {string} text
   * @returns {string}
   */
  function render(text) {
    if (!text) return '';

    const lines = text.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // --- HTML comment → skip ---
      if (trimmed.startsWith('<!--')) {
        let buf = line;
        while (!buf.includes('-->') && i + 1 < lines.length) { i++; buf += '\n' + lines[i]; }
        i++;
        continue;
      }

      // --- Fenced code block ---
      const fenceMatch = line.match(/^(`{3,})\s*(\S*)/);
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const lang = fenceMatch[2] || '';
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].startsWith(fence)) { codeLines.push(lines[i]); i++; }
        if (i < lines.length) i++; // skip closing fence
        out.push(renderCodeBlock(lang, codeLines.join('\n')));
        continue;
      }

      // --- Block-level HTML (details, summary, table, etc.) → pass through ---
      if (BLOCK_HTML_RE.test(trimmed)) {
        out.push(line);
        i++;
        continue;
      }

      // --- Horizontal rule ---
      if (/^[-*_]{3,}\s*$/.test(trimmed)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // --- Heading ---
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        const lvl = headingMatch[1].length;
        out.push(`<h${lvl}>${processInline(escapeHtml(headingMatch[2]))}</h${lvl}>`);
        i++;
        continue;
      }

      // --- Unordered list ---
      if (/^\s*[-*+]\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
          items.push(processInline(escapeHtml(lines[i].replace(/^\s*[-*+]\s/, ''))));
          i++;
        }
        out.push(`<ul>${items.map(it => `<li>${it}</li>`).join('')}</ul>`);
        continue;
      }

      // --- Ordered list ---
      if (/^\s*\d+[.)]\s/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
          items.push(processInline(escapeHtml(lines[i].replace(/^\s*\d+[.)]\s/, ''))));
          i++;
        }
        out.push(`<ol>${items.map(it => `<li>${it}</li>`).join('')}</ol>`);
        continue;
      }

      // --- Blank line ---
      if (!trimmed) { i++; continue; }

      // --- Paragraph (consecutive non-special lines) ---
      const paraLines = [];
      while (i < lines.length && lines[i].trim() &&
        !lines[i].match(/^`{3,}/) &&
        !BLOCK_HTML_RE.test(lines[i].trimStart()) &&
        !lines[i].trimStart().startsWith('<!--') &&
        !lines[i].match(/^#{1,6}\s/) &&
        !/^\s*[-*+]\s/.test(lines[i]) &&
        !/^\s*\d+[.)]\s/.test(lines[i]) &&
        !/^[-*_]{3,}\s*$/.test(lines[i].trim())) {
        paraLines.push(lines[i]);
        i++;
      }
      out.push(`<p>${processInline(escapeHtml(paraLines.join(' ')))}</p>`);
    }

    return out.join('\n');
  }

  const CRMarkdown = { render, escapeHtml };
  if (typeof module !== 'undefined') {
    module.exports = CRMarkdown;
  } else {
    globalThis.CRMarkdown = CRMarkdown;
  }
})();
