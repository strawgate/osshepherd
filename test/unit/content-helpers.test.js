'use strict';

/**
 * Tests for pure helper functions in content.js.
 *
 * Strategy: extract the actual function/const definitions from the content.js
 * source and eval them in a vm sandbox with minimal globals. This ensures tests
 * break when the real implementation changes.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// ── helpers ──────────────────────────────────────────────────────────────────

const contentSrc = fs.readFileSync(
  path.resolve(__dirname, '../../src/content.js'),
  'utf8',
);

/**
 * Extract a named function from the source (handles multi-line bodies).
 */
function extractFunction(name) {
  const re = new RegExp(`^function ${name}\\b[\\s\\S]*?^\\}`, 'm');
  const m = contentSrc.match(re);
  if (!m) throw new Error(`Could not extract function "${name}" from content.js`);
  return m[0];
}

/**
 * Extract the FAB_STATES const declaration (multi-line object literal).
 */
function extractFabStates() {
  const re = /^const FAB_STATES = \{[\s\S]*?^\};/m;
  const m = contentSrc.match(re);
  if (!m) throw new Error('Could not extract FAB_STATES from content.js');
  return m[0];
}

/**
 * Build a vm context that exposes the extracted helpers.
 */
function buildContentContext(pathname) {
  const ctx = vm.createContext({
    window: { location: { pathname: pathname || '/' } },
    console,
  });

  const snippet = [
    extractFabStates(),
    extractFunction('commentCount'),
    extractFunction('fabStateFromReview'),
    extractFunction('getPRFromURL'),
    extractFunction('prIdFromUrl'),
  ].join('\n');

  vm.runInContext(snippet, ctx);
  return ctx;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('content.js — getPRFromURL', () => {
  it('parses owner, repo, and prNumber from a valid PR URL', () => {
    const ctx = buildContentContext('/acme/widget/pull/42');
    const result = vm.runInContext('getPRFromURL()', ctx);
    assert.equal(result.owner, 'acme');
    assert.equal(result.repo, 'widget');
    assert.equal(result.prNumber, '42');
  });

  it('parses a files tab URL (extra path segments)', () => {
    const ctx = buildContentContext('/acme/widget/pull/42/files');
    const result = vm.runInContext('getPRFromURL()', ctx);
    assert.equal(result.owner, 'acme');
    assert.equal(result.repo, 'widget');
    assert.equal(result.prNumber, '42');
  });

  it('returns null for a non-PR GitHub URL', () => {
    const ctx = buildContentContext('/acme/widget/issues/10');
    const result = vm.runInContext('getPRFromURL()', ctx);
    assert.equal(result, null);
  });

  it('returns null for a root URL', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext('getPRFromURL()', ctx);
    assert.equal(result, null);
  });
});

describe('content.js — commentCount', () => {
  it('returns 0 for empty comments array', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext('commentCount({ comments: [] })', ctx);
    assert.equal(result, 0);
  });

  it('counts only comments with severity !== "none"', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext(`commentCount({
      comments: [
        { severity: 'major' },
        { severity: 'none' },
        { severity: 'minor' },
      ]
    })`, ctx);
    assert.equal(result, 2);
  });

  it('returns 0 when all comments have severity "none"', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext(`commentCount({
      comments: [
        { severity: 'none' },
        { severity: 'none' },
      ]
    })`, ctx);
    assert.equal(result, 0);
  });

  it('handles missing comments property gracefully', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext('commentCount({})', ctx);
    assert.equal(result, 0);
  });
});

describe('content.js — fabStateFromReview', () => {
  it('returns the idle FAB_STATES object for null review', () => {
    const ctx = buildContentContext('/');
    // Verify it returns the exact FAB_STATES.idle object, not a fallthrough
    const isIdle = vm.runInContext('fabStateFromReview(null) === FAB_STATES.idle', ctx);
    assert.equal(isIdle, true, 'should return FAB_STATES.idle by reference');
  });

  it('returns FAB_STATES.loading for pending review', () => {
    const ctx = buildContentContext('/');
    const isLoading = vm.runInContext("fabStateFromReview({ status: 'pending' }) === FAB_STATES.loading", ctx);
    assert.equal(isLoading, true, 'pending should return FAB_STATES.loading by reference');
  });

  it('returns FAB_STATES.loading for reviewing review', () => {
    const ctx = buildContentContext('/');
    const isLoading = vm.runInContext("fabStateFromReview({ status: 'reviewing' }) === FAB_STATES.loading", ctx);
    assert.equal(isLoading, true, 'reviewing should return FAB_STATES.loading by reference');
  });

  it('returns complete state with comment count for complete review with comments', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext(`fabStateFromReview({
      status: 'complete',
      comments: [
        { severity: 'major' },
        { severity: 'minor' },
      ]
    })`, ctx);
    assert.equal(result.cls, 'coderabbit-complete');
    assert.match(result.text, /\(2\)/, 'text should include exact count "(2)"');
    // Must NOT be the LGTM variant — verify the complete/LGTM branch is correct
    assert.equal(result.text.includes('LGTM'), false, 'should not be LGTM when there are actionable comments');
  });

  it('returns LGTM state for complete review with 0 actionable comments', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext(`fabStateFromReview({
      status: 'complete',
      comments: [{ severity: 'none' }]
    })`, ctx);
    assert.equal(result.cls, 'coderabbit-complete');
    assert.ok(result.text.includes('LGTM'), 'text should indicate LGTM');
    // Must NOT include a count like "(0)" — it should be the LGTM variant
    assert.equal(result.text.includes('('), false, 'LGTM variant should not have a count');
  });

  it('returns FAB_STATES.error for error review', () => {
    const ctx = buildContentContext('/');
    const isError = vm.runInContext("fabStateFromReview({ status: 'error' }) === FAB_STATES.error", ctx);
    assert.equal(isError, true, 'error should return FAB_STATES.error by reference');
  });

  it('returns the idle FAB_STATES object for unknown status', () => {
    const ctx = buildContentContext('/');
    // Should also be FAB_STATES.idle by reference — same fallthrough
    const isIdle = vm.runInContext("fabStateFromReview({ status: 'something_else' }) === FAB_STATES.idle", ctx);
    assert.equal(isIdle, true, 'unknown status should return FAB_STATES.idle by reference');
  });
});

describe('content.js — prIdFromUrl', () => {
  it('extracts owner/repo/number from a valid PR URL', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext("prIdFromUrl('https://github.com/acme/widget/pull/42')", ctx);
    assert.equal(result, 'acme/widget/42');
  });

  it('extracts from a PR URL with extra path segments', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext("prIdFromUrl('https://github.com/acme/widget/pull/42/files')", ctx);
    assert.equal(result, 'acme/widget/42');
  });

  it('returns null for a non-PR URL', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext("prIdFromUrl('https://github.com/acme/widget/issues/10')", ctx);
    assert.equal(result, null);
  });

  it('returns null for a repo root URL', () => {
    const ctx = buildContentContext('/');
    const result = vm.runInContext("prIdFromUrl('https://github.com/acme/widget')", ctx);
    assert.equal(result, null);
  });
});
