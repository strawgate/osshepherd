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
let watchedTabId = null;

async function init() {
  const tabId = await getCurrentTabId();
  if (!tabId) {
    showEmpty('Open a GitHub PR to see reviews.');
    return;
  }
  watchedTabId = tabId;

  await loadContext(tabId);
}

async function loadContext(tabId) {
  const ctx = await getPRContext(tabId);
  if (!ctx) {
    showEmpty('Click "Start Review" on a GitHub PR.');
    return;
  }

  // Check sign-in state before trying to show a review
  const stored = await chrome.storage.local.get(['accessToken', 'coderabbitToken']);
  const token = (stored.accessToken || stored.coderabbitToken || '').trim();
  if (!token) {
    showSignIn(ctx);
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

function showSignIn(ctx) {
  LOG(`Not signed in — showing sign-in prompt for ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`);
  const app = document.getElementById('cr-app');
  app.innerHTML = '';
  app.className = '';

  const card = document.createElement('div');
  card.className = 'cr-signin-card';
  card.innerHTML = `
    <div class="cr-signin-logo">🐑</div>
    <h2 class="cr-signin-title">Sign in to CodeRabbit</h2>
    <p class="cr-signin-desc">Sign in to start your AI review of<br>
      <strong>${ctx.owner}/${ctx.repo}#${ctx.prNumber}</strong></p>
    <button class="cr-signin-btn" id="crSignInBtn">Sign in with CodeRabbit</button>
    <p class="cr-signin-status" id="crSignInStatus"></p>
  `;
  app.appendChild(card);

  const btn = document.getElementById('crSignInBtn');
  const status = document.getElementById('crSignInStatus');

  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Opening sign-in tab…';
    status.textContent = 'Complete sign-in in the new tab — this panel will update automatically.';

    chrome.runtime.sendMessage({ type: 'START_OAUTH_LOGIN' }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        const msg = chrome.runtime.lastError?.message || response?.error || 'Sign-in failed';
        btn.disabled = false;
        btn.textContent = 'Sign in with CodeRabbit';
        status.textContent = msg;
        status.classList.add('cr-signin-status-error');
      }
      // On success the storage listener fires and triggers the review automatically
    });
  });
}

function showEmpty(message) {
  document.getElementById('cr-app').innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#8b949e;font-family:-apple-system,sans-serif;font-size:13px;text-align:center;padding:20px">${message}</div>`;
}

function mountApp(review, ctx) {
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
      { type: 'REQUEST_REVIEW', payload: { tabId: ctx.tabId } },
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
