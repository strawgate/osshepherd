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

  const BLOCK_HTML_RE = /^<\/?(details|summary|table|thead|tbody|tr|th|td|blockquote)\b/i;

  const URL_ATTRS_RE = /href|src|action|formaction|background|poster|cite|ping/i;

  // Explicit raster MIME types allowed in data: URLs. SVG is excluded because
  // data:image/svg+xml can embed <script> and event-handler attributes.
  const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);/i;

  /** Returns true if a URL is safe (https?, mailto, tel, ftp, relative, or raster data:image). */
  function isSafeUrl(url) {
    const t = url.trim();
    return /^(https?|mailto|tel|ftp):/i.test(t) ||
           /^[/?#.]/.test(t) ||
           SAFE_DATA_IMAGE_RE.test(t) ||
           t === '';
  }

  /** Strip event-handler, style, and unsafe URL-bearing attributes from a block-HTML line. */
  function sanitizeBlockHtml(line) {
    return line
      .replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+on\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\s+on\w+\s*=\s*\S+/gi, '')
      .replace(/\s+style\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+style\s*=\s*'[^']*'/gi, '')
      .replace(/\s+style\s*=\s*\S+/gi, '')
      .replace(/\s+(\w[\w-]*)\s*=\s*"([^"]*)"/gi, (match, attr, val) =>
        URL_ATTRS_RE.test(attr) && !isSafeUrl(val) ? '' : match)
      .replace(/\s+(\w[\w-]*)\s*=\s*'([^']*)'/gi, (match, attr, val) =>
        URL_ATTRS_RE.test(attr) && !isSafeUrl(val) ? '' : match);
  }

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

    // 4. Links [text](url) — allowlist safe schemes; block data:, vbscript:, etc.
    //    `text` is safe here: processInline is always called with escapeHtml()-pre-escaped input,
    //    so user-supplied < > are entities. The only raw HTML in `text` at this step is
    //    our own <strong>/<em>/<code> injections from steps 2-3 above (intentional, controlled).
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
      const t = url.trim();
      const safe = /^(https?|mailto|tel|ftp):/i.test(t) || /^[/?#.]/.test(t) || t === '';
      return `<a href="${escapeAttr(safe ? url : '')}" target="_blank" rel="noopener">${text}</a>`;
    });

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
        out.push(sanitizeBlockHtml(line));
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
