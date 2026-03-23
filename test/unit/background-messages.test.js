'use strict';

/**
 * Tests for background.js message handlers.
 *
 * Strategy: load background.js in a vm sandbox where chrome is the mock and
 * importScripts is shimmed. We share the activeRecords Map by stripping its
 * declaration from the script so it resolves via the vm context global.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Set up chrome mock BEFORE anything else
require('../helpers/chrome-mock');

// ── helpers ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../../src');

function readScript(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/**
 * Build a vm context that simulates the SW environment.
 *
 * Key trick: we strip `const activeRecords = new Map();` from background.js
 * so references to `activeRecords` resolve to the context global, which we
 * control from the test — letting us seed pre-populated records.
 */
function buildBackgroundContext() {
  const { resetChrome } = require('../helpers/chrome-mock');
  resetChrome();

  // Shared Map — populated by tests, mutated by background.js handlers
  const activeRecords = new Map();

  // Fake ReviewStore backed by an in-memory Map for easy inspection
  const reviewStore = new Map();
  const ReviewStore = {
    storageKey: (o, r, p) => `reviews:${o}/${r}/${p}`,
    createRecord: (owner, repo, prNumber, reviewId) => ({
      key: `reviews:${owner}/${repo}/${prNumber}`,
      owner, repo,
      prNumber: String(prNumber),
      reviewId,
      status: 'pending',
      startedAt: Date.now(),
      completedAt: null,
      rawEvents: [],
      comments: [],
    }),
    applyEvent: (record, event) => {
      const r = Object.assign({}, record, { rawEvents: [...(record.rawEvents || []), event] });
      if (event.type === 'review_completed') r.status = 'complete';
      return r;
    },
    save: async (record) => {
      reviewStore.set(record.key, Object.assign({}, record));
    },
    load: async (owner, repo, prNumber) => {
      return reviewStore.get(`reviews:${owner}/${repo}/${prNumber}`) || null;
    },
  };

  // Capture registered listeners
  const messageListeners = [];

  const fakeChrome = {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onConnect: { addListener: () => {} },
      sendMessage: global.chrome.runtime.sendMessage,
      lastError: null,
      getManifest: () => ({ version: '0.0.0-test' }),
    },
    tabs: { sendMessage: global.chrome.tabs.sendMessage },
    storage: { local: global.chrome.storage.local },
    offscreen: { createDocument: () => Promise.resolve() },
    declarativeNetRequest: { updateDynamicRules: () => Promise.resolve() },
  };

  const ctx = vm.createContext({
    chrome: fakeChrome,
    ReviewStore,
    activeRecords,         // shared — background.js resolves this via global
    reviewStore,           // for test assertions
    messageListeners,
    console,
    self: { clients: { matchAll: async () => [] } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
    generateUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 8),
  });

  let bgSource = readScript('background.js');

  // Strip importScripts() calls — deps already injected above
  const beforeImport = bgSource;
  bgSource = bgSource.replace(/^importScripts\([^)]+\);?\s*/gm, '');
  assert.notEqual(bgSource, beforeImport, 'Expected at least one importScripts() call in background.js');

  // Strip the internal activeRecords declaration so it resolves to ctx global
  const beforeActiveRecords = bgSource;
  bgSource = bgSource.replace(/^const activeRecords = new Map\(\);\s*/m, '');
  assert.notEqual(bgSource, beforeActiveRecords, 'Expected "const activeRecords = new Map();" in background.js');

  vm.runInContext(bgSource, ctx);

  function triggerMessage(request, sender = {}) {
    const responses = [];
    const sendResponse = (v) => responses.push(v);
    for (const listener of ctx.messageListeners) {
      listener(request, sender, sendResponse);
    }
    return responses;
  }

  return { ctx, triggerMessage, activeRecords, reviewStore };
}

// Wait for all pending microtasks / short async callbacks
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ── tests ────────────────────────────────────────────────────────────────────

describe('background.js — PING handler', () => {
  it('responds { success: true }', () => {
    const { triggerMessage } = buildBackgroundContext();
    const responses = triggerMessage({ type: 'PING' });
    assert.equal(responses.length, 1);
    assert.equal(responses[0].success, true);
  });
});

describe('background.js — REVIEW_EVENT handler', () => {
  it('exits cleanly when no active record exists', async () => {
    const { triggerMessage } = buildBackgroundContext();
    triggerMessage({
      type: 'REVIEW_EVENT',
      owner: 'acme', repo: 'api', prNumber: '42', tabId: 9,
      event: { type: 'review_comment', payload: { filename: 'src/foo.js' } },
    });
    await tick();
    // No crash = pass; chrome.tabs.sendMessage should NOT have been called
    assert.equal(global.chrome.tabs.sendMessage.mock.calls.length, 0);
  });

  it('calls ReviewStore.save and tabs.sendMessage when record exists', async () => {
    const { ctx, triggerMessage, activeRecords } = buildBackgroundContext();

    const record = ctx.ReviewStore.createRecord('acme', 'api', '42', 'rev-1');
    activeRecords.set('acme/api/42', record);

    const event = { type: 'review_comment', payload: { filename: 'src/foo.js', comment: 'hi' } };
    triggerMessage({
      type: 'REVIEW_EVENT',
      owner: 'acme', repo: 'api', prNumber: '42', tabId: 9, event,
    });

    await tick();

    const calls = global.chrome.tabs.sendMessage.mock.calls;
    assert.ok(calls.length >= 1, 'tabs.sendMessage not called');
    const [calledTabId, msg] = calls[calls.length - 1];
    assert.equal(calledTabId, 9);
    assert.equal(msg.type, 'REVIEW_UPDATE');
    assert.deepEqual(msg.payload.data, event);
  });

  it('updates activeRecords with the result of applyEvent', async () => {
    const { ctx, triggerMessage, activeRecords } = buildBackgroundContext();

    const record = ctx.ReviewStore.createRecord('acme', 'api', '99', 'rev-2');
    activeRecords.set('acme/api/99', record);

    triggerMessage({
      type: 'REVIEW_EVENT',
      owner: 'acme', repo: 'api', prNumber: '99', tabId: 1,
      event: { type: 'review_completed', payload: { summary: 'LGTM' } },
    });

    await tick();

    const updated = activeRecords.get('acme/api/99');
    assert.ok(updated, 'activeRecords entry missing after event');
    assert.ok(updated.rawEvents.length > 0, 'rawEvents not updated by applyEvent');
  });
});

describe('background.js — REVIEW_COMPLETE handler', () => {
  it('marks record complete, saves, removes from cache, notifies tab', async () => {
    const { ctx, triggerMessage, activeRecords, reviewStore } = buildBackgroundContext();

    const record = Object.assign(
      ctx.ReviewStore.createRecord('acme', 'api', '7', 'rev-3'),
      { status: 'reviewing' }
    );
    activeRecords.set('acme/api/7', record);

    triggerMessage({
      type: 'REVIEW_COMPLETE',
      owner: 'acme', repo: 'api', prNumber: '7', tabId: 5,
    });

    await tick();

    // Must be removed from live cache
    assert.equal(activeRecords.has('acme/api/7'), false, 'activeRecord not cleared');

    // Must be persisted as complete
    const saved = reviewStore.get('reviews:acme/api/7');
    assert.ok(saved, 'record not saved to reviewStore');
    assert.equal(saved.status, 'complete');

    // Must notify the tab
    const tabCalls = global.chrome.tabs.sendMessage.mock.calls;
    assert.ok(tabCalls.length >= 1, 'tabs.sendMessage not called');
    const lastMsg = tabCalls[tabCalls.length - 1][1];
    assert.equal(lastMsg.type, 'REVIEW_UPDATE');
    assert.equal(lastMsg.payload.complete, true);
  });

  it('does not overwrite a pre-existing completedAt timestamp', async () => {
    const { ctx, triggerMessage, activeRecords, reviewStore } = buildBackgroundContext();

    const record = Object.assign(
      ctx.ReviewStore.createRecord('acme', 'api', '8', 'rev-4'),
      { status: 'complete', completedAt: 1000 }
    );
    activeRecords.set('acme/api/8', record);

    triggerMessage({
      type: 'REVIEW_COMPLETE',
      owner: 'acme', repo: 'api', prNumber: '8', tabId: 5,
    });

    await tick();

    const saved = reviewStore.get('reviews:acme/api/8');
    assert.ok(saved, 'record not saved');
    assert.equal(saved.completedAt, 1000, 'completedAt must not be overwritten');
  });
});

describe('background.js — REVIEW_ERROR handler', () => {
  it('marks record as error, saves, sends REVIEW_RESULT error to tab', async () => {
    const { ctx, triggerMessage, activeRecords, reviewStore } = buildBackgroundContext();

    const record = ctx.ReviewStore.createRecord('acme', 'api', '55', 'rev-5');
    activeRecords.set('acme/api/55', record);

    triggerMessage({
      type: 'REVIEW_ERROR',
      owner: 'acme', repo: 'api', prNumber: '55', tabId: 3,
      message: 'WebSocket timeout',
    });

    await tick();

    const saved = reviewStore.get('reviews:acme/api/55');
    assert.ok(saved, 'record not saved');
    assert.equal(saved.status, 'error');

    const tabCalls = global.chrome.tabs.sendMessage.mock.calls;
    assert.ok(tabCalls.length >= 1, 'tabs.sendMessage not called');
    const [calledTabId, msg] = tabCalls[tabCalls.length - 1];
    assert.equal(calledTabId, 3);
    assert.equal(msg.type, 'REVIEW_RESULT');
    assert.equal(msg.payload.status, 'error');
    assert.equal(msg.payload.message, 'WebSocket timeout');
  });

  it('still saves an error record when there is no pre-existing active record', async () => {
    const { triggerMessage, reviewStore } = buildBackgroundContext();

    triggerMessage({
      type: 'REVIEW_ERROR',
      owner: 'acme', repo: 'api', prNumber: '404', tabId: 7,
      message: 'something blew up',
    });

    await tick();

    const saved = reviewStore.get('reviews:acme/api/404');
    assert.ok(saved, 'should still save an error record');
    assert.equal(saved.status, 'error');
  });
});

describe('offscreen.js — chrome.storage isolation', () => {
  it('source code (non-comment lines) never calls chrome.storage', () => {
    const src = readScript('offscreen.js');
    // Strip single-line and block comments before checking
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/[^\n]*/g, '');         // line comments
    assert.ok(
      !noComments.includes('chrome.storage'),
      'offscreen.js must not reference chrome.storage in actual code'
    );
  });

  it('sends REVIEW_EVENT, REVIEW_COMPLETE, and REVIEW_ERROR via runtime.sendMessage', () => {
    const src = readScript('offscreen.js');
    assert.ok(src.includes("'REVIEW_EVENT'") || src.includes('"REVIEW_EVENT"'));
    assert.ok(src.includes("'REVIEW_COMPLETE'") || src.includes('"REVIEW_COMPLETE"'));
    assert.ok(src.includes("'REVIEW_ERROR'") || src.includes('"REVIEW_ERROR"'));
    // Must use runtime.sendMessage, not tabs.sendMessage
    assert.ok(src.includes('chrome.runtime.sendMessage'));
    assert.ok(!src.includes('chrome.tabs.sendMessage'), 'offscreen must not call chrome.tabs.sendMessage');
  });
});
