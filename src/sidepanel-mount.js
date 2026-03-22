/**
 * sidepanel-mount.js — Bootstrap for the chrome.sidePanel page.
 *
 * Reads the current tab's PR context from chrome.storage.session,
 * loads the review from ReviewStore, renders the Preact sidebar,
 * and listens for storage changes to update reactively.
 */

/* global html, render, ReviewStore, reviewSignal, Sidebar */

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
// Mount
// ---------------------------------------------------------------------------

let currentPR = null;

async function init() {
  const tabId = await getCurrentTabId();
  if (!tabId) {
    showEmpty('Open a GitHub PR to see reviews.');
    return;
  }

  const ctx = await getPRContext(tabId);
  if (!ctx) {
    // No sidePanel context — try to find a review for this tab's URL
    showEmpty('Click "Review with OSShepherd" on a GitHub PR.');
    return;
  }

  currentPR = ctx;
  LOG(`Loading review for ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`);

  const review = await ReviewStore.load(ctx.owner, ctx.repo, ctx.prNumber);
  if (review) {
    mountApp(review, ctx);
  } else {
    showEmpty('Review starting…');
    // Will be updated via storage listener when events arrive
    mountApp(ReviewStore.createRecord(ctx.owner, ctx.repo, ctx.prNumber, 'pending'), ctx);
  }
}

function showEmpty(message) {
  document.getElementById('cr-app').innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#8b949e;font-family:-apple-system,sans-serif;font-size:13px;text-align:center;padding:20px">${message}</div>`;
}

function mountApp(review, _prContext) {
  const mountTarget = document.getElementById('cr-app');
  mountTarget.innerHTML = '';
  mountTarget.className = 'cr-sidebar';

  reviewSignal.value = review;

  const onClose = () => {}; // Chrome manages panel visibility
  const onRerun = async () => {
    const r = reviewSignal.value;
    if (!r) return;
    await ReviewStore.remove(r.owner, r.repo, r.prNumber);
    reviewSignal.value = ReviewStore.createRecord(r.owner, r.repo, r.prNumber, 'pending');
    chrome.runtime.sendMessage(
      { type: 'REQUEST_REVIEW', payload: { owner: r.owner, repo: r.repo, prNumber: r.prNumber } },
      () => {}
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
// Reactive updates — watch storage for review changes
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (!currentPR) return;
  const key = ReviewStore.storageKey(currentPR.owner, currentPR.repo, currentPR.prNumber);

  if (area === 'local' && changes[key]) {
    const review = changes[key].newValue;
    if (review) {
      LOG(`Storage update for ${currentPR.owner}/${currentPR.repo}#${currentPR.prNumber} — status: ${review.status}`);
      reviewSignal.value = review;
    }
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

init();
