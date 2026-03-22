'use strict';

/**
 * Lightweight shim that lets jest-webextension-mock run under node:test.
 *
 * jest-webextension-mock uses jest.fn() internally.  We define a minimal
 * global `jest` with just enough for the mock to boot, then wire the
 * resulting `chrome` global into every sandbox that needs it.
 *
 * Usage:
 *   const { chrome, resetChrome } = require('../helpers/chrome-mock');
 *   beforeEach(() => resetChrome());
 */

// ── minimal jest shim ────────────────────────────────────────────────────────
function mockFn() {
  const calls = [];
  const returnValues = [];
  let impl = null;

  function fn(...args) {
    calls.push(args);
    if (impl) return impl(...args);
    if (returnValues.length) return returnValues.shift();
  }

  fn.mock = { calls };
  fn.mockReturnValue = (v) => { returnValues.push(v); return fn; };
  fn.mockImplementation = (f) => { impl = f; return fn; };
  fn.mockResolvedValue = (v) => { impl = () => Promise.resolve(v); return fn; };
  fn.mockRejectedValue = (v) => { impl = () => Promise.reject(v); return fn; };
  fn.mockReset = () => { calls.length = 0; returnValues.length = 0; impl = null; };
  return fn;
}

global.jest = { fn: mockFn };

// ── load the mock (sets global.chrome) ──────────────────────────────────────
require('jest-webextension-mock');

// ── resetChrome — call in beforeEach to clear call history ──────────────────
function resetChrome() {
  const c = global.chrome;

  // Reset each mock exactly once using mockReset()
  [
    c.storage?.local?.get,
    c.storage?.local?.set,
    c.storage?.local?.remove,
    c.storage?.local?.clear,
    c.storage?.sync?.get,
    c.storage?.sync?.set,
    c.tabs?.sendMessage,
    c.tabs?.create,
    c.tabs?.update,
    c.tabs?.remove,
    c.tabs?.get,
    c.tabs?.query,
    c.runtime?.sendMessage,
    c.runtime?.onMessage?.addListener,
  ].forEach(fn => fn?.mockReset?.());

  if (c.runtime) {
    c.runtime.lastError = null;
    // Ensure onConnect exists (jest-webextension-mock may not provide it)
    if (!c.runtime.onConnect) {
      c.runtime.onConnect = { addListener: mockFn(), removeListener: mockFn() };
    }
  }
}

module.exports = { chrome: global.chrome, resetChrome };
