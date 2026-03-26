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

  const EXTENSION_ID = 'test-extension-id';
  const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

  const fakeChrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `${EXTENSION_ORIGIN}/${path}`,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onConnect: { addListener: () => {} },
      sendMessage: global.chrome.runtime.sendMessage,
      lastError: null,
      getManifest: () => ({ version: '0.0.0-test' }),
    },
    tabs: { sendMessage: global.chrome.tabs.sendMessage },
    storage: {
      local: global.chrome.storage.local,
      session: {
        get: (keys, cb) => { if (cb) cb({}); return Promise.resolve({}); },
        set: (items, cb) => { if (cb) cb(); return Promise.resolve(); },
        remove: (keys, cb) => { if (cb) cb(); return Promise.resolve(); },
      },
    },
    alarms: {
      create: () => {},
      clear: () => {},
      onAlarm: { addListener: () => {} },
    },
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

  // Helper: sender that passes isFromExtensionPage for a given page
  function extensionSender(page) {
    return { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/${page}` };
  }

  return { ctx, triggerMessage, activeRecords, reviewStore, extensionSender, EXTENSION_ID, EXTENSION_ORIGIN };
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
  it('rejects messages from unexpected senders', async () => {
    const { ctx, reviewStore } = buildBackgroundContext();
    // Sender with wrong extension id should be rejected
    const listener = ctx.messageListeners[0];
    const ret = listener(
      { type: 'REVIEW_EVENT', owner: 'acme', repo: 'api', prNumber: '42', tabId: 9, event: {} },
      { id: 'evil-ext', url: 'chrome-extension://evil-ext/offscreen.html' },
      () => {}
    );
    await tick();
    // Handler must return false (synchronous rejection, no async response)
    assert.equal(ret, false, 'handler should return false for rejected sender');
    assert.equal(global.chrome.tabs.sendMessage.mock.calls.length, 0, 'should not forward rejected events');
    assert.equal(reviewStore.size, 0, 'should not save anything for rejected sender');
  });

  it('rejects messages from content scripts (sender.tab present)', async () => {
    const { ctx, reviewStore, EXTENSION_ID, EXTENSION_ORIGIN } = buildBackgroundContext();
    const listener = ctx.messageListeners[0];
    const ret = listener(
      { type: 'REVIEW_EVENT', owner: 'acme', repo: 'api', prNumber: '42', tabId: 9, event: {} },
      { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/offscreen.html`, tab: { id: 9 } },
      () => {}
    );
    await tick();
    assert.equal(ret, false, 'handler should return false for content script sender');
    assert.equal(global.chrome.tabs.sendMessage.mock.calls.length, 0, 'content script sender should be rejected');
    assert.equal(reviewStore.size, 0, 'should not save anything for content script sender');
  });

  it('exits cleanly when no active record exists', async () => {
    const { triggerMessage, reviewStore, extensionSender } = buildBackgroundContext();
    triggerMessage({
      type: 'REVIEW_EVENT',
      owner: 'acme', repo: 'api', prNumber: '42', tabId: 9,
      event: { type: 'review_comment', payload: { filename: 'src/foo.js' } },
    }, extensionSender('offscreen.html'));
    await tick();
    // Event accepted (passes sender check) but no record to update
    assert.equal(global.chrome.tabs.sendMessage.mock.calls.length, 0, 'should not notify tab when no record');
    assert.equal(reviewStore.size, 0, 'should not create a record from a stray event');
  });

  it('calls ReviewStore.save and tabs.sendMessage when record exists', async () => {
    const { ctx, triggerMessage, activeRecords, extensionSender } = buildBackgroundContext();

    const record = ctx.ReviewStore.createRecord('acme', 'api', '42', 'rev-1');
    activeRecords.set('acme/api/42', record);

    const event = { type: 'review_comment', payload: { filename: 'src/foo.js', comment: 'hi' } };
    triggerMessage({
      type: 'REVIEW_EVENT',
      owner: 'acme', repo: 'api', prNumber: '42', tabId: 9, event,
    }, extensionSender('offscreen.html'));

    await tick();

    const calls = global.chrome.tabs.sendMessage.mock.calls;
    assert.ok(calls.length >= 1, 'tabs.sendMessage not called');
    const [calledTabId, msg] = calls[calls.length - 1];
    assert.equal(calledTabId, 9);
    assert.equal(msg.type, 'REVIEW_UPDATE');
    assert.deepEqual(msg.payload.data, event);
  });

  it('updates activeRecords with the result of applyEvent', async () => {
    const { ctx, triggerMessage, activeRecords, reviewStore, extensionSender } = buildBackgroundContext();

    const record = ctx.ReviewStore.createRecord('acme', 'api', '99', 'rev-2');
    activeRecords.set('acme/api/99', record);

    const event = { type: 'review_completed', payload: { summary: 'LGTM' } };
    triggerMessage({
      type: 'REVIEW_EVENT',
      owner: 'acme', repo: 'api', prNumber: '99', tabId: 1,
      event,
    }, extensionSender('offscreen.html'));

    await tick();

    const updated = activeRecords.get('acme/api/99');
    assert.ok(updated, 'activeRecords entry missing after event');
    // Verify the event was actually passed through applyEvent (not just stored)
    assert.ok(updated.rawEvents.length > record.rawEvents.length,
      'rawEvents should grow after applyEvent');
    assert.deepEqual(updated.rawEvents[updated.rawEvents.length - 1], event,
      'last rawEvent should be the event that was applied');
    // The fake applyEvent marks review_completed as complete
    assert.equal(updated.status, 'complete',
      'applyEvent should have processed the review_completed event');

    // Also verify the record was persisted to storage
    const saved = reviewStore.get('reviews:acme/api/99');
    assert.ok(saved, 'record should be saved to storage after event');
    assert.equal(saved.status, 'complete');
  });
});

describe('background.js — REVIEW_COMPLETE handler', () => {
  it('marks record complete, saves, removes from cache, notifies tab', async () => {
    const { ctx, triggerMessage, activeRecords, reviewStore, extensionSender } = buildBackgroundContext();

    const record = Object.assign(
      ctx.ReviewStore.createRecord('acme', 'api', '7', 'rev-3'),
      { status: 'reviewing' }
    );
    activeRecords.set('acme/api/7', record);

    triggerMessage({
      type: 'REVIEW_COMPLETE',
      owner: 'acme', repo: 'api', prNumber: '7', tabId: 5,
    }, extensionSender('offscreen.html'));

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
    const { ctx, triggerMessage, activeRecords, reviewStore, extensionSender } = buildBackgroundContext();

    const record = Object.assign(
      ctx.ReviewStore.createRecord('acme', 'api', '8', 'rev-4'),
      { status: 'complete', completedAt: 1000 }
    );
    activeRecords.set('acme/api/8', record);

    triggerMessage({
      type: 'REVIEW_COMPLETE',
      owner: 'acme', repo: 'api', prNumber: '8', tabId: 5,
    }, extensionSender('offscreen.html'));

    await tick();

    const saved = reviewStore.get('reviews:acme/api/8');
    assert.ok(saved, 'record not saved');
    assert.equal(saved.completedAt, 1000, 'completedAt must not be overwritten');
  });

  it('rejects REVIEW_COMPLETE from unexpected sender', async () => {
    const { ctx, triggerMessage, activeRecords, reviewStore } = buildBackgroundContext();

    const record = Object.assign(
      ctx.ReviewStore.createRecord('acme', 'api', '9', 'rev-x'),
      { status: 'reviewing' }
    );
    activeRecords.set('acme/api/9', record);

    triggerMessage({
      type: 'REVIEW_COMPLETE',
      owner: 'acme', repo: 'api', prNumber: '9', tabId: 5,
    }, { id: 'evil-ext', url: 'chrome-extension://evil-ext/offscreen.html' });

    await tick();

    assert.equal(activeRecords.has('acme/api/9'), true, 'record must not be cleared by rejected sender');
    assert.equal(reviewStore.has('reviews:acme/api/9'), false, 'must not save on rejected sender');
    assert.equal(global.chrome.tabs.sendMessage.mock.calls.length, 0);
  });
});

describe('background.js — REVIEW_ERROR handler', () => {
  it('marks record as error, saves, sends REVIEW_RESULT error to tab', async () => {
    const { ctx, triggerMessage, activeRecords, reviewStore, extensionSender } = buildBackgroundContext();

    const record = ctx.ReviewStore.createRecord('acme', 'api', '55', 'rev-5');
    activeRecords.set('acme/api/55', record);

    triggerMessage({
      type: 'REVIEW_ERROR',
      owner: 'acme', repo: 'api', prNumber: '55', tabId: 3,
      message: 'WebSocket timeout',
    }, extensionSender('offscreen.html'));

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
    const { triggerMessage, reviewStore, extensionSender } = buildBackgroundContext();

    triggerMessage({
      type: 'REVIEW_ERROR',
      owner: 'acme', repo: 'api', prNumber: '404', tabId: 7,
      message: 'something blew up',
    }, extensionSender('offscreen.html'));

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

// ── OPEN_SIDEPANEL handler ──────────────────────────────────────────────────

/**
 * Extended context builder that adds chrome.sidePanel.open to fakeChrome.
 * Does NOT modify the original buildBackgroundContext function.
 */
function buildContextWithSidePanel() {
  const result = buildBackgroundContext();
  // Inject sidePanel.open into the vm context's chrome object
  const fakeChrome = result.ctx.chrome;
  fakeChrome.sidePanel = {
    open: (_opts) => Promise.resolve(),
  };
  return result;
}

describe('background.js — OPEN_SIDEPANEL handler', () => {
  it('rejects if sender has no tab', () => {
    const { triggerMessage, extensionSender } = buildContextWithSidePanel();
    const responses = triggerMessage(
      { type: 'OPEN_SIDEPANEL' },
      extensionSender('popup.html')
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /No tab/i);
  });

  it('rejects if tab URL is not a GitHub PR', () => {
    const { triggerMessage, EXTENSION_ID } = buildContextWithSidePanel();
    const responses = triggerMessage(
      { type: 'OPEN_SIDEPANEL' },
      { id: EXTENSION_ID, tab: { id: 10, url: 'https://github.com/acme/repo/issues/5' } }
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /Not a GitHub PR/i);
  });

  it('writes session context and calls sidePanel.open on valid PR tab', async () => {
    const { ctx, triggerMessage, EXTENSION_ID } = buildContextWithSidePanel();

    // Track storage.session.set calls
    const sessionSetCalls = [];
    ctx.chrome.storage.session.set = (items, cb) => {
      sessionSetCalls.push(items);
      if (cb) cb();
      return Promise.resolve();
    };

    // Track sidePanel.open calls
    const sidePanelCalls = [];
    ctx.chrome.sidePanel.open = (opts) => {
      sidePanelCalls.push(opts);
      return Promise.resolve();
    };

    triggerMessage(
      { type: 'OPEN_SIDEPANEL' },
      { id: EXTENSION_ID, tab: { id: 42, url: 'https://github.com/acme/repo/pull/99' } }
    );

    await tick();

    // Verify session context was written
    assert.equal(sessionSetCalls.length, 1);
    const written = sessionSetCalls[0]['sidepanel:context:42'];
    assert.ok(written, 'session context not written');
    assert.equal(written.owner, 'acme');
    assert.equal(written.repo, 'repo');
    assert.equal(written.prNumber, '99');
    assert.equal(written.tabId, 42);

    // Verify sidePanel.open was called
    assert.equal(sidePanelCalls.length, 1);
    assert.equal(sidePanelCalls[0].tabId, 42);
  });

  it('sends success:true after sidePanel.open resolves', async () => {
    const { ctx, EXTENSION_ID } = buildContextWithSidePanel();

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    // Manually trigger to capture async sendResponse
    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'OPEN_SIDEPANEL' },
        { id: EXTENSION_ID, tab: { id: 7, url: 'https://github.com/org/lib/pull/3' } },
        sendResponse
      );
    }

    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[responses.length - 1].success, true);
  });

  it('sends error when sidePanel.open rejects', async () => {
    const { ctx, EXTENSION_ID } = buildContextWithSidePanel();

    ctx.chrome.sidePanel.open = () => Promise.reject(new Error('user gesture required'));

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'OPEN_SIDEPANEL' },
        { id: EXTENSION_ID, tab: { id: 7, url: 'https://github.com/org/lib/pull/3' } },
        sendResponse
      );
    }

    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called on error');
    assert.equal(responses[responses.length - 1].success, false);
    assert.match(responses[responses.length - 1].error, /user gesture required/);
  });
});

// ── REQUEST_REVIEW from content script (sender.tab.url) ─────────────────────

describe('background.js — REQUEST_REVIEW from content script', () => {
  it('rejects non-PR URLs with success:false', async () => {
    const { ctx, EXTENSION_ID } = buildBackgroundContext();

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW' },
        { id: EXTENSION_ID, tab: { id: 5, url: 'https://github.com/acme/repo/issues/10' } },
        sendResponse
      );
    }

    // Synchronous rejection — no need to await, but tick for safety
    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /Not a GitHub PR/i);
  });

  it('parses PR identity from sender.tab.url and calls handleRequestReview', async () => {
    const { ctx, EXTENSION_ID } = buildBackgroundContext();

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    // Provide a token so it gets past the "not signed in" check
    ctx.chrome.storage.local.get.mockImplementation((keys, cb) => {
      const data = { accessToken: 'fake-token', coderabbitToken: 'fake-token' };
      if (cb) cb(data);
      return Promise.resolve(data);
    });

    // Capture the fetch URL to verify the parsed PR identity
    const fetchedUrls = [];
    ctx.fetch = async (url) => {
      fetchedUrls.push(url);
      return { ok: false, status: 404, text: async () => '' };
    };

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW' },
        { id: EXTENSION_ID, tab: { id: 20, url: 'https://github.com/acme/widget/pull/42' } },
        sendResponse
      );
    }

    await tick(100);

    // Verify the parsed identity by checking the diff URL that was fetched.
    // handleRequestReview may call fetch multiple times (org lookup, then diff).
    const diffUrl = fetchedUrls.find(u => u.includes('.diff'));
    assert.ok(diffUrl, 'diff fetch not called — fetchedUrls: ' + fetchedUrls.join(', '));
    assert.match(diffUrl, /acme\/widget\/pull\/42\.diff/,
      'diff URL should contain the correctly parsed owner/repo/prNumber');

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /diff/i);
  });
});

// ── REQUEST_REVIEW from sidepanel ───────────────────────────────────────────

describe('background.js — REQUEST_REVIEW from sidepanel', () => {
  it('rejects if sender URL does not match sidepanel.html', async () => {
    const { ctx, EXTENSION_ID, EXTENSION_ORIGIN } = buildBackgroundContext();

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    // Sender is an extension page but NOT sidepanel.html
    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW', payload: { tabId: 5 } },
        { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/popup.html` },
        sendResponse
      );
    }

    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /Unauthorized/i);
  });

  it('rejects if sender is from a different extension', async () => {
    const { ctx } = buildBackgroundContext();

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW', payload: { tabId: 5 } },
        { id: 'evil-ext', url: 'chrome-extension://evil-ext/sidepanel.html' },
        sendResponse
      );
    }

    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /Unauthorized/i);
  });

  it('rejects if no tabId in payload', async () => {
    const { ctx, extensionSender } = buildBackgroundContext();

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW', payload: {} },
        extensionSender('sidepanel.html'),
        sendResponse
      );
    }

    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /Missing tabId/i);
  });

  it('rejects if no tabId in payload (payload missing entirely)', async () => {
    const { ctx, extensionSender } = buildBackgroundContext();

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW' },
        extensionSender('sidepanel.html'),
        sendResponse
      );
    }

    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /Missing tabId/i);
  });

  it('reads session context from storage and calls handleRequestReview', async () => {
    const { ctx, extensionSender } = buildBackgroundContext();

    const tabId = 33;

    // Mock session storage to return a valid PR context
    ctx.chrome.storage.session.get = (key, cb) => {
      const result = {};
      result[`sidepanel:context:${tabId}`] = { owner: 'acme', repo: 'api', prNumber: '7', tabId };
      if (cb) cb(result);
      return Promise.resolve(result);
    };

    // Provide a token so handleRequestReview gets past the auth check
    ctx.chrome.storage.local.get.mockImplementation((keys, cb) => {
      const data = { accessToken: 'fake-token', coderabbitToken: 'fake-token' };
      if (cb) cb(data);
      return Promise.resolve(data);
    });

    // Capture the fetch URL to verify the session context was used correctly
    const fetchedUrls = [];
    ctx.fetch = async (url) => {
      fetchedUrls.push(url);
      return { ok: false, status: 404, text: async () => '' };
    };

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW', payload: { tabId } },
        extensionSender('sidepanel.html'),
        sendResponse
      );
    }

    await tick(100);

    // Verify the session context's PR identity was passed to handleRequestReview.
    // handleRequestReview may call fetch multiple times (org lookup, then diff),
    // so find the diff URL among all fetched URLs.
    const diffUrl = fetchedUrls.find(u => u.includes('.diff'));
    assert.ok(diffUrl, 'diff fetch not called — fetchedUrls: ' + fetchedUrls.join(', '));
    assert.match(diffUrl, /acme\/api\/pull\/7\.diff/,
      'diff URL should contain owner/repo/prNumber from session context');

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /diff/i);
  });

  it('rejects when no session context exists for the tab', async () => {
    const { ctx, extensionSender } = buildBackgroundContext();

    // Session storage returns empty — no context for this tab
    ctx.chrome.storage.session.get = (key, cb) => {
      if (cb) cb({});
      return Promise.resolve({});
    };

    const responses = [];
    const sendResponse = (v) => responses.push(v);

    for (const listener of ctx.messageListeners) {
      listener(
        { type: 'REQUEST_REVIEW', payload: { tabId: 999 } },
        extensionSender('sidepanel.html'),
        sendResponse
      );
    }

    await tick();

    assert.ok(responses.length >= 1, 'sendResponse not called');
    assert.equal(responses[0].success, false);
    assert.match(responses[0].error, /No session context/i);
  });
});

// ── OPEN_OPTIONS handler ────────────────────────────────────────────────────

describe('background.js — OPEN_OPTIONS handler', () => {
  it('calls chrome.runtime.openOptionsPage()', () => {
    const { ctx, triggerMessage } = buildBackgroundContext();

    // Track openOptionsPage calls
    const openOptionsCalls = [];
    ctx.chrome.runtime.openOptionsPage = () => { openOptionsCalls.push(true); };

    triggerMessage({ type: 'OPEN_OPTIONS' });

    assert.equal(openOptionsCalls.length, 1, 'openOptionsPage not called');
  });

  it('returns false (synchronous, no async response)', () => {
    const { ctx } = buildBackgroundContext();
    ctx.chrome.runtime.openOptionsPage = () => {};

    // Manually check listener return value
    const listener = ctx.messageListeners[0];
    const result = listener({ type: 'OPEN_OPTIONS' }, {}, () => {});
    assert.equal(result, false, 'OPEN_OPTIONS should return false (synchronous)');
  });
});
