/**
 * sidepanel-mount.js — Bootstrap for the chrome.sidePanel page.
 *
 * Mounts the Preact Sidebar once, then drives all UI transitions through
 * signals (panelModeSignal, reviewSignal).  No imperative DOM writes — the
 * Preact tree owns #cr-app for its entire lifetime.
 */

/* global html, render, batch, ReviewStore, reviewSignal, panelModeSignal, Sidebar */

const LOG = (...args) => console.log('[CR:sidepanel]', ...args);

// ---------------------------------------------------------------------------
// Determine which PR this panel is for
// ---------------------------------------------------------------------------

async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function getPRContext(tabId) {
  const key = `sidepanel:context:${tabId}`;
  const result = await chrome.storage.session.get(key);
  return result[key] || null;
}

// ---------------------------------------------------------------------------
// Navigation — uses chrome.tabs API instead of window.location
// ---------------------------------------------------------------------------

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function navigateTab(pr, filename, startLine) {
  if (!pr || !filename) return;
  const hash = await sha256Hex(filename);
  const anchor = startLine ? `R${startLine}` : '';
  const url = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.prNumber}/files#diff-${hash}${anchor}`;

  const tabs = await chrome.tabs.query({
    url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.prNumber}*`
  });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { url, active: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentPR = null;
let watchedTabId = null;
let loadGeneration = 0; // guards against stale async loadContext completions

// ---------------------------------------------------------------------------
// Mount — one-time, never torn down
// ---------------------------------------------------------------------------

function mountOnce() {
  const mountTarget = document.getElementById('cr-app');
  mountTarget.className = 'cr-sidebar';

  const onClose = () => {}; // Chrome manages panel visibility
  const onRerun = async () => {
    const r = reviewSignal.value;
    if (!r) return;
    // Read the live tabId — the Preact tree persists across PR switches so
    // the closure must not capture a stale context.
    const tabId = watchedTabId;
    await ReviewStore.remove(r.owner, r.repo, r.prNumber);
    batch(() => {
      reviewSignal.value = ReviewStore.createRecord(r.owner, r.repo, r.prNumber, 'pending');
      panelModeSignal.value = { mode: 'review' };
    });
    chrome.runtime.sendMessage(
      { type: 'REQUEST_REVIEW', payload: { tabId } },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          const msg = chrome.runtime.lastError?.message || response?.error || 'Background not responding';
          LOG('Re-run failed:', msg);
          const errReview = ReviewStore.createRecord(r.owner, r.repo, r.prNumber, 'error');
          errReview.status = 'error';
          reviewSignal.value = errReview;
        }
      }
    );
  };

  // Override the global navigateToFileLine to use chrome.tabs
  globalThis.navigateToFileLine = (pr, filename, line) => navigateTab(pr, filename, line);

  render(
    html`<${Sidebar} initialTab="feedback" onClose=${onClose} onRerun=${onRerun} />`,
    mountTarget
  );
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

async function init() {
  const tabId = await getCurrentTabId();
  if (!tabId) {
    panelModeSignal.value = { mode: 'empty', message: 'Open a GitHub PR to see reviews.' };
    return;
  }
  watchedTabId = tabId;
  await loadContext(tabId);
}

async function loadContext(tabId) {
  // Bump generation so any earlier in-flight loadContext becomes stale
  const gen = ++loadGeneration;

  // Immediately clear currentPR so the storage listener stops applying
  // events from the OLD PR to the signal while we load the new context.
  currentPR = null;

  const ctx = await getPRContext(tabId);
  if (gen !== loadGeneration) return; // superseded by a newer call
  if (!ctx) {
    panelModeSignal.value = { mode: 'empty', message: 'Click "Start Review" on a GitHub PR.' };
    return;
  }

  // Check sign-in state before trying to show a review
  const stored = await chrome.storage.local.get(['accessToken', 'coderabbitToken']);
  const token = (stored.accessToken || stored.coderabbitToken || '').trim();
  if (gen !== loadGeneration) return; // superseded
  if (!token) {
    panelModeSignal.value = { mode: 'signin', ctx };
    return;
  }

  // Set currentPR BEFORE the ReviewStore.load so that storage events
  // arriving for the new PR are correctly picked up by the listener.
  currentPR = ctx;
  LOG(`Loading review for ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`);

  const review = await ReviewStore.load(ctx.owner, ctx.repo, ctx.prNumber);
  if (gen !== loadGeneration) return; // superseded

  batch(() => {
    reviewSignal.value = review || ReviewStore.createRecord(ctx.owner, ctx.repo, ctx.prNumber, 'pending');
    panelModeSignal.value = { mode: 'review' };
  });
}

// ---------------------------------------------------------------------------
// Reactive updates — watch storage for review changes
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  // When the user navigates to a different PR and presses Review, the background
  // writes a new session context. Reinitialize the panel for the new PR.
  if (area === 'session' && watchedTabId) {
    const ctxKey = `sidepanel:context:${watchedTabId}`;
    if (changes[ctxKey]?.newValue) {
      LOG(`Session context changed — reinitializing for new PR`);
      loadContext(watchedTabId);
      return;
    }
  }

  // When the user completes sign-in, auto-trigger the review for the waiting PR.
  if (area === 'local' && (changes.accessToken || changes.coderabbitToken)) {
    const token = changes.accessToken?.newValue || changes.coderabbitToken?.newValue;
    if (token && !currentPR && watchedTabId) {
      LOG(`Sign-in detected — triggering review`);
      loadContext(watchedTabId);
      return;
    }
  }

  if (!currentPR) return;
  const key = ReviewStore.storageKey(currentPR.owner, currentPR.repo, currentPR.prNumber);

  if (area === 'local' && changes[key]) {
    const review = changes[key].newValue;
    // Double-check the review actually belongs to the PR we're displaying
    if (review && review.owner === currentPR.owner &&
        review.repo === currentPR.repo &&
        String(review.prNumber) === String(currentPR.prNumber)) {
      LOG(`Storage update for ${currentPR.owner}/${currentPR.repo}#${currentPR.prNumber} — status: ${review.status}`);
      reviewSignal.value = review;
    }
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

mountOnce();
init();
