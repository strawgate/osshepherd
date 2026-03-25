/**
 * Offscreen document — holds the WebSocket connection.
 *
 * NOTE: Offscreen documents only have access to chrome.runtime, NOT chrome.storage.
 * All ReviewStore operations (storage reads/writes) must happen in background.js.
 * This file sends REVIEW_EVENT / REVIEW_COMPLETE / REVIEW_ERROR messages to the
 * background SW, which owns persistence and tab routing.
 */

const LOG = (...args) => console.log('[CR:offscreen]', ...args);
const ERR = (...args) => console.error('[CR:offscreen]', ...args);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'START_OFFSCREEN_REVIEW') {
    // Primary trust check: sender.id must match this extension.
    // We do NOT rely on sender.url here because Chrome may not set it for
    // background service workers; sender.tab being present means it is a
    // content script (always untrusted for this message type).
    if (sender.id !== chrome.runtime.id || sender.tab) {
      ERR('START_OFFSCREEN_REVIEW from unexpected sender — id:', sender.id, 'tab:', sender.tab?.id);
      return false;
    }
    const { owner, repo, prNumber } = request.payload;
    LOG(`Received START_OFFSCREEN_REVIEW for ${owner}/${repo}#${prNumber}`);
    handleOffscreenReview(request.payload)
      .then(() => sendResponse({ success: true }))
      .catch(err => {
        ERR('Unhandled error in handleOffscreenReview:', err);
        // Only send REVIEW_ERROR if the subscription error handler hasn't already
        if (!err._skipOuterErrorHandler) {
          chrome.runtime.sendMessage({
            type: 'REVIEW_ERROR',
            owner: request.payload.owner,
            repo: request.payload.repo,
            prNumber: request.payload.prNumber,
            tabId: request.payload.tabId,
            message: err.message || String(err),
          });
        }
        sendResponse({ success: false, error: err.message || String(err) });
      });
    return true; // async
  }
});

async function handleOffscreenReview(payload) {
  const { owner, repo, prNumber, diffContent, token, tabId, clientId, reviewId, organizationId, extensionVersion } = payload;
  const tag = `${owner}/${repo}#${prNumber}`;

  LOG(`[${tag}] Starting review ${reviewId} — tab ${tabId}, org: ${organizationId || 'none'}`);

  // Helper: send an event to background for storage + tab forwarding
  function sendEvent(event) {
    chrome.runtime.sendMessage({
      type: 'REVIEW_EVENT',
      owner, repo, prNumber, tabId, reviewId,
      event,
    });
  }

  let eventCount = 0;
  let subscriptionErrored = false;

  // Keep the background SW alive for the duration of this review.
  // A connected port prevents termination. Chrome closes ports after 5 min,
  // so we reconnect before that. Ping every 25s as a belt-and-suspenders.
  let keepalivePort = null;
  let keepaliveInterval = null;
  function startKeepalive() {
    keepalivePort = chrome.runtime.connect({ name: `review:${tag}` });
    keepalivePort.onDisconnect.addListener(() => {
      // Port was closed (5-min limit or SW restart) — reconnect if review still active
      if (keepaliveInterval) {
        LOG(`[${tag}] Keepalive port disconnected — reconnecting`);
        try { keepalivePort = chrome.runtime.connect({ name: `review:${tag}` }); } catch { /* SW gone */ }
      }
    });
    keepaliveInterval = setInterval(() => {
      try { keepalivePort.postMessage({ type: 'keepalive' }); }
      catch { /* port dead, onDisconnect will reconnect */ }
    }, 25_000);
  }
  function stopKeepalive() {
    if (keepaliveInterval) { clearInterval(keepaliveInterval); keepaliveInterval = null; }
    if (keepalivePort) { try { keepalivePort.disconnect(); } catch { /* ok */ } keepalivePort = null; }
  }

  startKeepalive();

  LOG(`[${tag}] Connecting to WebSocket...`);
  const client = new CodeRabbitClient(token);
  await client.connect(organizationId);
  LOG(`[${tag}] WebSocket connected and authenticated`);

  const files = CRDiffParser.parseDiff(diffContent);
  LOG(`[${tag}] Parsed ${files.length} file(s) from diff (${diffContent.length} bytes)`);

  const requestPayload = {
    extensionEvent: {
      userId: clientId,
      userName: 'ChromeExtensionUser',
      clientId,
      eventType: 'REVIEW',
      reviewId,
      files,
      hostUrl: 'https://github.com',
      provider: 'github',
      remoteUrl: `https://github.com/${owner}/${repo}.git`,
      host: 'vscode',
      version: extensionVersion,
    },
  };

  LOG(`[${tag}] Sending batched subscribe + mutate...`);
  const { promise: reviewDone } = client.subscribeAndMutate(
    'vsCode.subscribeToEvents', { clientId },
    'vsCode.requestFullReview', requestPayload,
    (event) => {
      eventCount++;
      LOG(`[${tag}] Event #${eventCount}: [${event.type}]`);
      sendEvent(event);
    },
    (error) => {
      if (subscriptionErrored) return;
      subscriptionErrored = true;
      stopKeepalive();
      ERR(`[${tag}] Subscription error:`, error);
      chrome.runtime.sendMessage({
        type: 'REVIEW_ERROR',
        owner, repo, prNumber, tabId,
        message: error.message || String(error),
      });
    },
    () => {
      if (subscriptionErrored) return;
      stopKeepalive();
      LOG(`[${tag}] Subscription complete — ${eventCount} total events`);
      chrome.runtime.sendMessage({
        type: 'REVIEW_COMPLETE',
        owner, repo, prNumber, tabId,
      });
    }
  );

  try {
    const mutResult = await reviewDone;
    LOG(`[${tag}] Mutation acknowledged:`, JSON.stringify(mutResult).substring(0, 80));
  } catch (err) {
    stopKeepalive();
    if (subscriptionErrored) {
      ERR(`[${tag}] Mutation also failed (subscription error already reported):`, err.message || err);
      return;
    }
    err._skipOuterErrorHandler = false;
    throw err;
  }
}
