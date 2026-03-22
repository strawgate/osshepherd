/**
 * Verifies that utility files correctly export globals via globalThis
 * when loaded as scripts (not CommonJS modules) — simulating importScripts()
 * in a service worker or <script src="..."> in an offscreen/popup document.
 *
 * This catches the window vs globalThis bug and double-declaration errors.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadAsScript(relPath, context = {}) {
  // Simulate a global scope with no window, no module, no require
  // — matching a service worker or content script environment.
  const sandbox = Object.assign(Object.create(null), context, {
    globalThis: null,  // will be set below
    console,
  });
  // globalThis must point at the sandbox itself
  sandbox.globalThis = sandbox;

  const src = fs.readFileSync(path.resolve(__dirname, '../../src', relPath), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: relPath });
  return sandbox;
}

describe('utils/utils.js — script context', () => {
  it('exports CRUtils.generateUUID and formatRelativeTime on globalThis', () => {
    const ctx = loadAsScript('utils/utils.js');
    assert.ok(ctx.CRUtils, 'CRUtils should be on globalThis');
    assert.equal(typeof ctx.CRUtils.generateUUID, 'function');
    assert.equal(typeof ctx.CRUtils.formatRelativeTime, 'function');
  });

  it('generateUUID returns a valid UUID v4 string', () => {
    const ctx = loadAsScript('utils/utils.js');
    const id = ctx.CRUtils.generateUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not set window (would break strict SW environments)', () => {
    const ctx = loadAsScript('utils/utils.js');
    assert.equal(ctx.window, undefined);
  });
});

describe('utils/diff-parser.js — script context', () => {
  it('exports CRDiffParser.parseDiff on globalThis', () => {
    const ctx = loadAsScript('utils/diff-parser.js');
    assert.ok(ctx.CRDiffParser, 'CRDiffParser should be on globalThis');
    assert.equal(typeof ctx.CRDiffParser.parseDiff, 'function');
  });
});

describe('utils/review-store.js — script context', () => {
  it('exports ReviewStore on globalThis', () => {
    const ctx = loadAsScript('utils/review-store.js');
    assert.ok(ctx.ReviewStore, 'ReviewStore should be on globalThis');
  });

  it('exports all expected methods', () => {
    const ctx = loadAsScript('utils/review-store.js');
    const expected = ['createRecord', 'applyEvent', 'storageKey', 'save', 'load', 'loadAll', 'prune', 'remove'];
    for (const method of expected) {
      assert.equal(typeof ctx.ReviewStore[method], 'function', `ReviewStore.${method} should be a function`);
    }
  });
});

describe('utils/trpc-client.js — script context', () => {
  it('exports CodeRabbitClient on globalThis', () => {
    const ctx = loadAsScript('utils/trpc-client.js');
    assert.ok(ctx.CodeRabbitClient, 'CodeRabbitClient should be on globalThis');
    assert.equal(typeof ctx.CodeRabbitClient, 'function');
  });
});

describe('background.js import order — no double declarations', () => {
  it('utils.js then background.js loads without identifier conflicts', () => {
    // Load utils first (simulates importScripts order), then background logic
    const ctx = loadAsScript('utils/utils.js');
    // generateUUID is now a global function in ctx
    assert.equal(typeof ctx.generateUUID, 'function');

    // Simulate background.js referencing it — should not throw
    // (var leaks onto the sandbox; const is local to the vm script)
    vm.runInContext('var _uuid = generateUUID();', ctx);
    assert.match(ctx._uuid, /^[0-9a-f-]{36}$/);
  });
});
