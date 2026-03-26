/**
 * content.js — Orchestrator for the OSShepherd extension on GitHub PR pages.
 *
 * Responsibilities:
 *  - FAB button injection and state machine
 *  - GitHub SPA navigation detection (Turbo Drive)
 *  - Background message handling (REVIEW_UPDATE, REVIEW_RESULT)
 *  - Opens the chrome.sidePanel via messaging to background
 *  - Toast notifications
 *
 * The sidebar UI runs in chrome.sidePanel (sidepanel.html), NOT in this content script.
 * This script is lightweight: no Preact, no markdown, no sidebar rendering.
 */

/* global ReviewStore */

const LOG = (...args) => console.log('[CR:content]', ...args);
const ERR = (...args) => console.error('[CR:content]', ...args);

const BTN_CLASS = 'coderabbit-fab';

// ---------------------------------------------------------------------------
// PR identity from URL
// ---------------------------------------------------------------------------

function getPRFromURL() {
  const parts = window.location.pathname.split('/');
  if (parts[3] !== 'pull' || !parts[4]) return null;
  return { owner: parts[1], repo: parts[2], prNumber: parts[4] };
}

// ---------------------------------------------------------------------------
// SidePanel helper
// ---------------------------------------------------------------------------

function openSidePanel(pr) {
  try {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL', payload: pr }, (response) => {
      if (chrome.runtime.lastError) {
        LOG('sidePanel.open message failed:', chrome.runtime.lastError.message);
      } else if (!response?.success) {
        LOG('sidePanel.open failed:', response?.error);
      }
    });
  } catch {
    // Extension context invalidated — page needs refresh
    showCrToast('Extension updated', 'Please refresh the page to reconnect.', 'error');
  }
}

// ---------------------------------------------------------------------------
// FAB state machine
// ---------------------------------------------------------------------------

const FAB_STATES = {
  idle:       { text: '🐑 Start Review', disabled: false, cls: '' },
  loading:    { text: '⏳ Reviewing…',               disabled: false, cls: 'coderabbit-loading' },
  complete:   (n) => ({ text: `✅ View Review (${n})`, disabled: false, cls: 'coderabbit-complete' }),
  lgtm:       { text: '✅ LGTM — View Review',       disabled: false, cls: 'coderabbit-complete' },
  error:      { text: '❌ Review Failed — Retry?',   disabled: false, cls: 'coderabbit-error' },
};

function setFABState(btn, state) {
  const s = typeof state === 'function' ? state() : state;
  btn.textContent = s.text;
  btn.disabled = s.disabled;
  btn.className = [BTN_CLASS, s.cls].filter(Boolean).join(' ');
}

function commentCount(review) {
  return (review.comments || []).filter(c => c.severity !== 'none').length;
}

function fabStateFromReview(review) {
  if (!review) return FAB_STATES.idle;
  if (review.status === 'reviewing' || review.status === 'pending') return FAB_STATES.loading;
  if (review.status === 'error') return FAB_STATES.error;
  if (review.status === 'complete') {
    const n = commentCount(review);
    return n > 0 ? FAB_STATES.complete(n) : FAB_STATES.lgtm;
  }
  return FAB_STATES.idle;
}

// ---------------------------------------------------------------------------
// FAB injection
// ---------------------------------------------------------------------------

function injectCodeRabbitButton() {
  if (document.querySelector(`.${BTN_CLASS}`)) return;

  const btn = document.createElement('button');
  btn.className = BTN_CLASS;
  setFABState(btn, FAB_STATES.idle);
  btn.addEventListener('click', handleReviewClick);
  document.documentElement.appendChild(btn);

  const pr = getPRFromURL();
  if (pr) {
    LOG(`Checking storage for ${pr.owner}/${pr.repo}#${pr.prNumber}`);
    ReviewStore.load(pr.owner, pr.repo, pr.prNumber).then(review => {
      if (!document.documentElement.contains(btn)) return;
      if (review) {
        LOG(`Found stored review — status: ${review.status}`);
        setFABState(btn, fabStateFromReview(review));
      }
    });
  }
}

function ensureFAB() {
  if (!location.href.includes('/pull/')) return;
  const existing = document.querySelector(`.${BTN_CLASS}`);
  if (!existing) {
    injectCodeRabbitButton();
  } else {
    const pr = getPRFromURL();
    if (pr) {
      ReviewStore.load(pr.owner, pr.repo, pr.prNumber).then(review => {
        const btn = document.querySelector(`.${BTN_CLASS}`);
        if (btn && review) setFABState(btn, fabStateFromReview(review));
      });
    }
  }
}

// ---------------------------------------------------------------------------
// FAB click handler
// ---------------------------------------------------------------------------

async function handleReviewClick() {
  const btn = document.querySelector(`.${BTN_CLASS}`);
  const pr = getPRFromURL();
  if (!pr) return;

  LOG(`FAB clicked for ${pr.owner}/${pr.repo}#${pr.prNumber}`);

  // If review exists, just open the sidePanel
  const existing = await ReviewStore.load(pr.owner, pr.repo, pr.prNumber);
  if (existing && (existing.status === 'complete' || existing.status === 'reviewing' || existing.status === 'pending')) {
    LOG(`Opening sidePanel for ${existing.status} review`);
    openSidePanel(pr);
    return;
  }

  // Ping background — retry a few times since the SW may need to wake up.
  // If the extension context is invalidated (e.g. after update/long sleep),
  // sendMessage throws synchronously — catch that and prompt a reload.
  let isAwake = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      isAwake = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'PING' }, response => {
          if (chrome.runtime.lastError) {
            resolve(false);
          } else {
            resolve(response?.success === true);
          }
        });
      });
    } catch (e) {
      // "Extension context invalidated" — can't recover without page reload
      ERR('Extension context invalidated:', e.message);
      showCrToast('Extension updated', 'Please refresh the page to reconnect.', 'error');
      return;
    }
    if (isAwake) break;
    LOG(`PING attempt ${attempt + 1} failed, retrying…`);
    await new Promise(r => setTimeout(r, 500));
  }
  if (!isAwake) {
    ERR('Background SW did not respond after 3 attempts');
    showCrToast('Extension not responding', 'Please refresh the page to reconnect.', 'error');
    return;
  }

  LOG('Background awake — sending REQUEST_REVIEW');
  setFABState(btn, FAB_STATES.loading);
  openSidePanel(pr);

  chrome.runtime.sendMessage(
    { type: 'REQUEST_REVIEW', payload: pr },
    (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        const msg = chrome.runtime.lastError?.message || response?.error || 'Unknown error';
        ERR('REQUEST_REVIEW failed:', msg);
        setFABState(btn, FAB_STATES.idle);
        if (!msg.includes('Not signed in')) {
          showCrToast('Review Failed', msg, 'error');
        }
        // "Not signed in" is handled by the side panel's sign-in prompt — no toast needed
        return;
      }
      LOG('REQUEST_REVIEW response:', JSON.stringify(response.data).substring(0, 80));
      if (response.data?.cached || response.data?.inProgress) {
        ReviewStore.load(pr.owner, pr.repo, pr.prNumber).then(review => {
          if (review) {
            const b = document.querySelector(`.${BTN_CLASS}`);
            if (b) setFABState(b, fabStateFromReview(review));
          }
        });
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Incoming messages from background
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'REVIEW_RESULT') {
    const { status } = message.payload;
    LOG(`REVIEW_RESULT — status: ${status}`);
    if (status === 'error') {
      ERR('Review error:', message.payload.message);
      const btn = document.querySelector(`.${BTN_CLASS}`);
      if (btn) setFABState(btn, FAB_STATES.error);
      showCrToast('Review Failed', message.payload.message || 'Unknown error', 'error');
    }
  }

  if (message.type === 'REVIEW_UPDATE') {
    const pr = getPRFromURL();
    if (pr) {
      // Update FAB state from storage (sidePanel handles its own rendering via storage listener)
      ReviewStore.load(pr.owner, pr.repo, pr.prNumber).then(review => {
        if (!review) return;
        const btn = document.querySelector(`.${BTN_CLASS}`);
        if (btn) setFABState(btn, fabStateFromReview(review));
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

function showCrToast(title, message, type = 'success') {
  let container = document.querySelector('.cr-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'cr-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `cr-toast ${type}`;
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  toast.innerHTML = `
    <div class="cr-toast-header">${type === 'error' ? '❌' : '🐑'} ${esc(title)}</div>
    <div class="cr-toast-body">${esc(message)}</div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'cr-slide-out 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards';
    setTimeout(() => toast.remove(), 450);
  }, 6000);
}

// ---------------------------------------------------------------------------
// GitHub SPA navigation
// ---------------------------------------------------------------------------

let lastUrl = location.href;

function prIdFromUrl(url) {
  const m = url.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

let fabCheckTimer = null;

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    const prevPR = prIdFromUrl(lastUrl);
    lastUrl = location.href;
    const currentPR = prIdFromUrl(location.href);

    if (location.href.includes('/pull/')) {
      if (currentPR !== prevPR) {
        // Different PR — remove old FAB and inject fresh
        const existingBtn = document.querySelector(`.${BTN_CLASS}`);
        if (existingBtn) existingBtn.remove();
        injectCodeRabbitButton();
      } else {
        // Same PR, different tab — just ensure FAB is still there
        ensureFAB();
      }
      startKeepalive();
    } else {
      const existingBtn = document.querySelector(`.${BTN_CLASS}`);
      if (existingBtn) existingBtn.remove();
      stopKeepalive();
    }
    return;
  }

  // Turbo may swap body content without changing URL — debounce a FAB check
  if (fabCheckTimer) return;
  fabCheckTimer = setTimeout(() => {
    fabCheckTimer = null;
    ensureFAB();
  }, 200);
});

// Observe documentElement, not body — Turbo Drive can replace <body> entirely,
// which would kill an observer attached to the old body element.
observer.observe(document.documentElement, { childList: true, subtree: true });

// ---------------------------------------------------------------------------
// Service Worker keepalive — prevents the SW from sleeping while a PR tab is open.
// Chrome kills ports after 5 minutes, so we reconnect before that.
// ---------------------------------------------------------------------------

let keepalivePort = null;
let keepaliveInterval = null;

function startKeepalive() {
  if (keepalivePort) return;
  if (!location.href.includes('/pull/')) return; // re-check — may have navigated during reconnect delay
  try {
    keepalivePort = chrome.runtime.connect({ name: 'content:keepalive' });
    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
      // Reconnect if we're still on a PR page (port dies after 5 min or SW restart)
      if (location.href.includes('/pull/')) {
        setTimeout(() => {
          try { startKeepalive(); } catch { /* extension context gone */ }
        }, 1000);
      }
    });
    if (!keepaliveInterval) {
      keepaliveInterval = setInterval(() => {
        try { keepalivePort?.postMessage({ type: 'keepalive' }); }
        catch { /* port dead, onDisconnect will reconnect */ }
      }, 25_000);
    }
  } catch {
    // Extension context invalidated — can't reconnect
    keepalivePort = null;
  }
}

function stopKeepalive() {
  if (keepaliveInterval) { clearInterval(keepaliveInterval); keepaliveInterval = null; }
  if (keepalivePort) { try { keepalivePort.disconnect(); } catch { /* ok */ } keepalivePort = null; }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// GitHub fires turbo:load after every SPA navigation — reliable backup for the observer
document.addEventListener('turbo:load', () => {
  lastUrl = location.href;
  if (location.href.includes('/pull/')) {
    ensureFAB();
    startKeepalive();
  } else {
    const btn = document.querySelector(`.${BTN_CLASS}`);
    if (btn) btn.remove();
    stopKeepalive();
  }
});

if (location.href.includes('/pull/')) {
  injectCodeRabbitButton();
  startKeepalive();
}
