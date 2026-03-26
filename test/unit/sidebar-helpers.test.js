'use strict';

/**
 * Tests for pure helper functions in sidebar.js.
 *
 * Strategy: extract the function source from sidebar.js and eval it in a
 * controlled scope, similar to the vm approach in background-messages.test.js
 * but simpler since these are standalone pure functions.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Extract helper functions from sidebar.js source
// ---------------------------------------------------------------------------

const sidebarSrc = fs.readFileSync(
  path.resolve(__dirname, '../../src/sidebar.js'),
  'utf8',
);

/**
 * Pull a named function (and any leading const used by it) out of the source
 * and eval it so we can call it directly.
 */
function extractFunction(name) {
  const re = new RegExp(`^function ${name}\\b[\\s\\S]*?^\\}`, 'm');
  const m = sidebarSrc.match(re);
  if (!m) throw new Error(`Could not extract function "${name}" from sidebar.js`);
  return m[0];
}

// Build a mini module that exposes the four helpers
const helperCode = [
  extractFunction('severityRank'),
  extractFunction('stripAIHeader'),
  extractFunction('parseEffort'),
  extractFunction('parseSummaryMeta'),
  'module.exports = { severityRank, stripAIHeader, parseEffort, parseSummaryMeta };',
].join('\n');

const helperModule = { exports: {} };
new Function('module', 'exports', helperCode)(helperModule, helperModule.exports);

const { severityRank, stripAIHeader, parseEffort, parseSummaryMeta } = helperModule.exports;

// ---------------------------------------------------------------------------
// severityRank
// ---------------------------------------------------------------------------

describe('severityRank', () => {
  it('maps critical to 0', () => {
    assert.equal(severityRank('critical'), 0);
  });

  it('maps high to 1', () => {
    assert.equal(severityRank('high'), 1);
  });

  it('maps major to 1', () => {
    assert.equal(severityRank('major'), 1);
  });

  it('maps medium to 2', () => {
    assert.equal(severityRank('medium'), 2);
  });

  it('maps minor to 2', () => {
    assert.equal(severityRank('minor'), 2);
  });

  it('maps low to 3', () => {
    assert.equal(severityRank('low'), 3);
  });

  it('maps trivial to 4', () => {
    assert.equal(severityRank('trivial'), 4);
  });

  it('returns 5 for unknown severity', () => {
    assert.equal(severityRank('unknown'), 5);
  });

  it('returns 5 for undefined', () => {
    assert.equal(severityRank(undefined), 5);
  });

  it('returns 5 for null', () => {
    assert.equal(severityRank(null), 5);
  });

  it('returns 5 for empty string', () => {
    assert.equal(severityRank(''), 5);
  });
});

// ---------------------------------------------------------------------------
// parseEffort
// ---------------------------------------------------------------------------

describe('parseEffort', () => {
  it('parses "Estimated code review effort: 3 [High]" format', () => {
    const text = 'Some preamble.\nEstimated code review effort: 3 [High]\nMore text.';
    assert.equal(parseEffort(text), 'high');
  });

  it('parses "Estimated code review effort: 2 [Medium]" format', () => {
    const text = 'Estimated code review effort: 2 [Medium]';
    assert.equal(parseEffort(text), 'medium');
  });

  it('parses "Estimated code review effort: 1 [Low]" format', () => {
    const text = 'Estimated code review effort: 1 [Low]';
    assert.equal(parseEffort(text), 'low');
  });

  it('parses "Estimated code review effort: 1 [Trivial]" format', () => {
    const text = 'Estimated code review effort: 1 [Trivial]';
    assert.equal(parseEffort(text), 'trivial');
  });

  it('parses bare word format "Estimated code review effort: High"', () => {
    const text = 'Estimated code review effort: High';
    assert.equal(parseEffort(text), 'high');
  });

  it('parses bare word format "Estimated code review effort: low"', () => {
    const text = 'Estimated code review effort: low';
    assert.equal(parseEffort(text), 'low');
  });

  it('maps "minimal" to "trivial"', () => {
    const text = 'Estimated code review effort: Minimal';
    assert.equal(parseEffort(text), 'trivial');
  });

  it('returns null for null input', () => {
    assert.equal(parseEffort(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseEffort(''), null);
  });

  it('returns null for text without effort line', () => {
    assert.equal(parseEffort('Just a normal summary with no effort.'), null);
  });

  it('returns null for unrecognized effort level', () => {
    const text = 'Estimated code review effort: 5 [Extreme]';
    assert.equal(parseEffort(text), null);
  });

  it('returns null for numeric-only unrecognized effort', () => {
    const text = 'Estimated code review effort: 99';
    assert.equal(parseEffort(text), null);
  });
});

// ---------------------------------------------------------------------------
// stripAIHeader
// ---------------------------------------------------------------------------

describe('stripAIHeader', () => {
  it('removes the AI-generated summary header', () => {
    const text = '## AI-generated summary of changes\n\nThis is the actual summary.';
    assert.equal(stripAIHeader(text), 'This is the actual summary.');
  });

  it('removes the header even without trailing blank line', () => {
    const text = '## AI-generated summary of changes\nContent here.';
    assert.equal(stripAIHeader(text), 'Content here.');
  });

  it('returns the text unchanged when no header is present', () => {
    const text = 'Just a normal summary without a header.';
    assert.equal(stripAIHeader(text), 'Just a normal summary without a header.');
  });

  it('returns empty string for null input', () => {
    assert.equal(stripAIHeader(null), '');
  });

  it('returns empty string for empty string input', () => {
    assert.equal(stripAIHeader(''), '');
  });

  it('returns empty string for undefined input', () => {
    assert.equal(stripAIHeader(undefined), '');
  });

  it('trims whitespace from result', () => {
    const text = '## AI-generated summary of changes\n\n  Some text with leading spaces  ';
    assert.equal(stripAIHeader(text), 'Some text with leading spaces');
  });
});

// ---------------------------------------------------------------------------
// parseSummaryMeta
// ---------------------------------------------------------------------------

describe('parseSummaryMeta', () => {
  it('returns null for null input', () => {
    assert.equal(parseSummaryMeta(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseSummaryMeta(''), null);
  });

  it('returns null for unstructured text', () => {
    assert.equal(parseSummaryMeta('This is just a plain summary with no markers.'), null);
  });

  it('detects structured summary via "Actionable comments posted"', () => {
    const text = '**Actionable comments posted: 3**\nSome content.';
    const meta = parseSummaryMeta(text);
    assert.ok(meta !== null);
    assert.equal(meta.actionableCount, 3);
  });

  it('detects structured summary via "Review info"', () => {
    const text = 'Review info\n**Configuration used**: `myConfig`';
    const meta = parseSummaryMeta(text);
    assert.ok(meta !== null, 'should detect as structured');
    assert.equal(meta.config, 'myConfig');
    assert.equal(meta.actionableCount, 0);
  });

  it('detects structured summary via "Run configuration"', () => {
    const text = 'Run configuration\n**Plan**: `Free`';
    const meta = parseSummaryMeta(text);
    assert.ok(meta !== null, 'should detect as structured');
    assert.equal(meta.plan, 'Free');
    assert.equal(meta.actionableCount, 0);
  });

  it('detects structured summary via "Files selected for processing"', () => {
    const text = 'Files selected for processing (2)</summary>\n\n* `file1.go`\n* `file2.go`\n\n</details>';
    const meta = parseSummaryMeta(text);
    assert.ok(meta !== null, 'should detect as structured');
    assert.ok(meta.files, 'should parse file list');
    assert.equal(meta.files.length, 2);
    assert.equal(meta.files[0], 'file1.go');
  });

  it('defaults actionableCount to 0 when not found', () => {
    const text = 'Review info\nNo actionable comments line here.';
    const meta = parseSummaryMeta(text);
    assert.equal(meta.actionableCount, 0);
  });

  it('parses key-value fields: config, profile, plan, runId', () => {
    const text = [
      '**Actionable comments posted: 5**',
      '**Configuration used**: `CodeRabbit UI`',
      '**Review profile**: `CHILL`',
      '**Plan**: `Pro`',
      '**Run ID**: `abc-123`',
    ].join('\n');
    const meta = parseSummaryMeta(text);
    assert.equal(meta.actionableCount, 5);
    assert.equal(meta.config, 'CodeRabbit UI');
    assert.equal(meta.profile, 'CHILL');
    assert.equal(meta.plan, 'Pro');
    assert.equal(meta.runId, 'abc-123');
  });

  it('returns null for missing key-value fields', () => {
    const text = '**Actionable comments posted: 0**';
    const meta = parseSummaryMeta(text);
    assert.equal(meta.config, null);
    assert.equal(meta.profile, null);
    assert.equal(meta.plan, null);
    assert.equal(meta.runId, null);
  });

  it('parses files list from details block', () => {
    const text = [
      'Files selected for processing (3)</summary>',
      '',
      '* `src/foo.go`',
      '* `src/bar.go`',
      '* `README.md`',
      '',
      '</details>',
    ].join('\n');
    const meta = parseSummaryMeta(text);
    assert.ok(meta.files);
    assert.equal(meta.files.length, 3);
    assert.equal(meta.files[0], 'src/foo.go');
    assert.equal(meta.files[1], 'src/bar.go');
    assert.equal(meta.files[2], 'README.md');
  });

  it('parses agent prompt from code block', () => {
    const text = [
      'Review info',
      '<details>',
      '<summary>Prompt for AI agent</summary>',
      '',
      '```',
      'You are a code review assistant.',
      'Review the following changes.',
      '```',
      '</details>',
    ].join('\n');
    const meta = parseSummaryMeta(text);
    assert.ok(meta.agentPrompt);
    assert.equal(meta.agentPrompt, 'You are a code review assistant.\nReview the following changes.');
  });

  it('handles partial fields gracefully', () => {
    const text = [
      '**Actionable comments posted: 2**',
      '**Review profile**: `ASSERTIVE`',
      // No config, plan, runId, files, commits, or agentPrompt
    ].join('\n');
    const meta = parseSummaryMeta(text);
    assert.equal(meta.actionableCount, 2);
    assert.equal(meta.profile, 'ASSERTIVE');
    assert.equal(meta.config, null);
    assert.equal(meta.plan, null);
    assert.equal(meta.runId, null);
    assert.equal(meta.files, undefined);
    assert.equal(meta.agentPrompt, undefined);
  });

  it('full structured summary with all fields', () => {
    const text = [
      '**Actionable comments posted: 7**',
      '',
      '**Configuration used**: `CodeRabbit UI`',
      '**Review profile**: `CHILL`',
      '**Plan**: `Pro`',
      '**Run ID**: `run-xyz-456`',
      '',
      '<details>',
      '<summary>Files selected for processing (2)</summary>',
      '',
      '* `src/main.go`',
      '* `src/util.go`',
      '',
      '</details>',
      '',
      '<details>',
      '<summary>📥 Commits</summary>',
      '',
      'abc1234 Fix bug in handler',
      'def5678 Add tests',
      '',
      '</details>',
      '',
      '<details>',
      '<summary>Prompt for AI agent</summary>',
      '',
      '```',
      'Review this PR carefully.',
      '```',
      '</details>',
    ].join('\n');
    const meta = parseSummaryMeta(text);
    assert.equal(meta.actionableCount, 7);
    assert.equal(meta.config, 'CodeRabbit UI');
    assert.equal(meta.profile, 'CHILL');
    assert.equal(meta.plan, 'Pro');
    assert.equal(meta.runId, 'run-xyz-456');
    assert.ok(meta.files);
    assert.equal(meta.files.length, 2);
    assert.equal(meta.files[0], 'src/main.go');
    assert.equal(meta.files[1], 'src/util.go');
    assert.ok(meta.commits);
    assert.ok(meta.commits.includes('abc1234'));
    assert.ok(meta.agentPrompt);
    assert.equal(meta.agentPrompt, 'Review this PR carefully.');
  });
});
