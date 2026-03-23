importScripts('utils/utils.js');
importScripts('utils/review-store.js');
importScripts('utils/trpc-client.js');

const LOG = (...args) => console.log('[CR:background]', ...args);
const ERR = (...args) => console.error('[CR:background]', ...args);

// High-range ID avoids collisions with static rules (which use low IDs like 1)
const DNR_DYNAMIC_RULE_ID = 1001;

// In-memory record cache keyed by "owner/repo/prNumber" for the active review session.
// Avoids a storage read on every streaming event. The SW stays alive while events arrive.
const activeRecords = new Map();

// Tracks last event timestamp per active review for stuck detection.
const lastEventTime = new Map();
const FIRST_EVENT_TIMEOUT_MS = 15_000;   // 15s to get the first event (connection/auth failure)
const STUCK_TIMEOUT_MS = 3 * 60 * 1000;  // 3 minutes with no events after first → stuck

/**
 * Periodically checks if a review has gone silent (no events for STUCK_TIMEOUT_MS).
 * If stuck, marks it as error so the user gets feedback instead of infinite "Reviewing…".
 */
function scheduleStuckCheck(cacheKey, tabId) {
  const startTime = Date.now();
  let receivedFirstEvent = false;

  const intervalId = setInterval(() => {
    // Review finished or was removed — stop checking
    if (!activeRecords.has(cacheKey)) {
      clearInterval(intervalId);
      lastEventTime.delete(cacheKey);
      return;
    }

    const record = activeRecords.get(cacheKey);
    if (!record || record.status === 'complete' || record.status === 'error') {
      clearInterval(intervalId);
      lastEventTime.delete(cacheKey);
      return;
    }

    // Check if we've received any events at all
    const eventCount = (record.rawEvents || []).length;
    if (!receivedFirstEvent && eventCount > 0) receivedFirstEvent = true;

    // Fast timeout: no events within 15s → connection/auth likely failed
    if (!receivedFirstEvent && (Date.now() - startTime) >= FIRST_EVENT_TIMEOUT_MS) {
      clearInterval(intervalId);
      ERR(`[${cacheKey}] No events received within ${FIRST_EVENT_TIMEOUT_MS / 1000}s — marking as error.`);
      const errRecord = Object.assign({}, record, { status: 'error' });
      ReviewStore.save(errRecord).then(() => {
        activeRecords.delete(cacheKey);
        lastEventTime.delete(cacheKey);
        sendToTab(tabId, {
          type: 'REVIEW_RESULT',
          payload: { status: 'error', message: 'Review failed to start — no response from CodeRabbit. Check your connection and try again.' }
        });
      }).catch(err => ERR(`[${cacheKey}] Failed to save error record:`, err));
      return;
    }

    // Slow timeout: no events for 3 minutes after first → review is stuck
    const lastTime = lastEventTime.get(cacheKey) || 0;
    const elapsed = Date.now() - lastTime;
    if (receivedFirstEvent && elapsed >= STUCK_TIMEOUT_MS) {
      clearInterval(intervalId);
      const mins = Math.round(elapsed / 60000);
      ERR(`[${cacheKey}] Review appears stuck — no events for ${mins} min. Marking as error.`);
      const errRecord = Object.assign({}, record, { status: 'error' });
      ReviewStore.save(errRecord).then(() => {
        activeRecords.delete(cacheKey);
        lastEventTime.delete(cacheKey);
        sendToTab(tabId, {
          type: 'REVIEW_RESULT',
          payload: { status: 'error', message: `Review timed out — no response for ${mins} minutes. Try re-running the review.` }
        });
      }).catch(err => ERR(`[${cacheKey}] Failed to save stuck record:`, err));
    }
  }, 5_000); // check every 5s (was 30s — faster detection for the 15s first-event timeout)
}

// Accept keepalive ports from offscreen documents.
// The port's existence keeps this SW alive; we don't need to respond.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('review:')) {
    LOG(`Keepalive port opened: ${port.name}`);
    port.onDisconnect.addListener(() => {
      LOG(`Keepalive port closed: ${port.name}`);
    });
  }
});

/** Update the extension icon badge for a specific tab. */
function updateBadge(tabId, review) {
  if (!tabId) return;
  if (!review || review.status === 'pending') {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }
  if (review.status === 'reviewing') {
    chrome.action.setBadgeText({ text: '...', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#2d6a4f', tabId });
    return;
  }
  if (review.status === 'error') {
    chrome.action.setBadgeText({ text: '!', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#f85149', tabId });
    return;
  }
  if (review.status === 'complete') {
    const actionable = (review.comments || []).filter(c => c.severity !== 'none').length;
    if (actionable > 0) {
      chrome.action.setBadgeText({ text: String(actionable), tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#f85149', tabId });
    } else {
      chrome.action.setBadgeText({ text: '✓', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#238636', tabId });
    }
  }
}

function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      ERR(`tabs.sendMessage to tab ${tabId} failed:`, chrome.runtime.lastError.message);
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ success: true });
    return false;
  }

  if (request.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (request.type === 'OPEN_SIDEPANEL') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ success: false, error: 'No tab' }); return false; }
    const { owner, repo, prNumber } = request.payload || {};
    // Store context so sidePanel knows which PR to display
    chrome.storage.session.set({ [`sidepanel:context:${tabId}`]: { owner, repo, prNumber, tabId } });
    chrome.sidePanel.open({ tabId })
      .then(() => sendResponse({ success: true }))
      .catch(err => {
        ERR('sidePanel.open failed:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.type === 'START_OAUTH_LOGIN') {
    handleOAuthLogin()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (request.type === 'REQUEST_REVIEW') {
    LOG(`REQUEST_REVIEW from tab ${sender.tab?.id}: ${request.payload?.owner}/${request.payload?.repo}#${request.payload?.prNumber}`);
    handleRequestReview(request.payload, sender.tab.id)
      .then(res => {
        LOG('handleRequestReview result:', JSON.stringify(res).substring(0, 80));
        sendResponse({ success: true, data: res });
      })
      .catch(err => {
        ERR('handleRequestReview threw:', err.message || err);
        sendResponse({ success: false, error: err.message || String(err) });
      });
    return true;
  }

  // Streaming event from offscreen — save to storage and forward to tab
  if (request.type === 'REVIEW_EVENT') {
    const { owner, repo, prNumber, tabId, event } = request;
    const cacheKey = `${owner}/${repo}/${prNumber}`;
    let record = activeRecords.get(cacheKey);
    if (!record) {
      ERR(`[${cacheKey}] REVIEW_EVENT received but no active record`);
      return false;
    }
    lastEventTime.set(cacheKey, Date.now());
    record = ReviewStore.applyEvent(record, event);
    activeRecords.set(cacheKey, record);
    ReviewStore.save(record).then(() => {
      sendToTab(tabId, { type: 'REVIEW_UPDATE', payload: { data: event } });
      updateBadge(tabId, record);
    }).catch(err => ERR(`[${cacheKey}] Failed to save event:`, err));
    return false;
  }

  if (request.type === 'REVIEW_COMPLETE') {
    const { owner, repo, prNumber, tabId } = request;
    const cacheKey = `${owner}/${repo}/${prNumber}`;
    const record = activeRecords.get(cacheKey);
    if (!record) {
      ERR(`[${cacheKey}] REVIEW_COMPLETE received but no active record — ignoring`);
      return false;
    }
    LOG(`[${cacheKey}] Review complete — ${record.rawEvents?.length ?? 0} events`);
    const completed = record.status !== 'complete'
      ? Object.assign({}, record, { status: 'complete', completedAt: record.completedAt || Date.now() })
      : record;
    activeRecords.set(cacheKey, completed);
    ReviewStore.save(completed).then(() => {
      activeRecords.delete(cacheKey);
      lastEventTime.delete(cacheKey);
      sendToTab(tabId, { type: 'REVIEW_UPDATE', payload: { complete: true } });
      updateBadge(tabId, completed);
    }).catch(err => ERR(`[${cacheKey}] Failed to save complete record:`, err));
    return false;
  }

  if (request.type === 'REVIEW_ERROR') {
    const { owner, repo, prNumber, tabId, message } = request;
    const cacheKey = `${owner}/${repo}/${prNumber}`;
    ERR(`[${cacheKey}] Review error:`, message);
    let record = activeRecords.get(cacheKey) || ReviewStore.createRecord(owner, repo, prNumber, 'error');
    record = Object.assign({}, record, { status: 'error' });
    activeRecords.set(cacheKey, record);
    ReviewStore.save(record).then(() => {
      activeRecords.delete(cacheKey);
      lastEventTime.delete(cacheKey);
      sendToTab(tabId, {
        type: 'REVIEW_RESULT',
        payload: { status: 'error', message }
      });
      updateBadge(tabId, record);
    }).catch(err => ERR(`[${cacheKey}] Failed to save error record:`, err));
    return false;
  }
});

// generateUUID is available globally from importScripts('utils/utils.js')

// ============================================================
// OAuth Login Flow
// ============================================================
async function handleOAuthLogin() {
  const state = generateUUID();
  // Open CodeRabbit login with client=vscode params — user clicks "Sign in with GitHub"
  // After GitHub OAuth, it redirects back to app.coderabbit.ai/login?code=XXX&state=github
  const loginUrl = `https://app.coderabbit.ai/login?client=vscode&state=${state}&variant=vscode`;

  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: loginUrl }, (loginTab) => {
      const tabId = loginTab.id;
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.remove(tabId).catch(() => {});
        reject(new Error('Login timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      const listener = async (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId) return;
        const url = changeInfo.url || tab.url || '';
        if (!url) return;

        console.log('[OSShepherd OAuth] Tab URL:', url.substring(0, 120));

        // Catch the code from EITHER:
        // 1. app.coderabbit.ai/login?code=XXX&state=github (GitHub OAuth callback to CodeRabbit)
        // 2. coderabbit-cli://auth-callback?code=XXX (VS Code-style redirect)
        let code = null;
        let provider = 'github';

        try {
          const parsed = new URL(url);
          if (parsed.hostname === 'app.coderabbit.ai' && parsed.searchParams.has('code')) {
            code = parsed.searchParams.get('code');
            provider = parsed.searchParams.get('state') || 'github'; // state param contains provider name
          } else if (url.startsWith('coderabbit-cli://')) {
            const qs = new URLSearchParams(url.split('?')[1] || '');
            code = qs.get('code');
          }
        } catch (e) { 
          // Not all changed URLs are valid or parseable; ignore safely.
          console.debug("URL parse failed for input:", url, e);
        }

        if (!code) return;

        // Got a code! Immediately stop the tab from processing it
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Stop the page from loading further (prevents CodeRabbit SPA from consuming the code)
        chrome.tabs.update(tabId, { url: 'about:blank' });
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 500);

        console.log('[OSShepherd OAuth] Intercepted auth code. Exchanging for tokens...');

        try {
          const exchangeUrl = 'https://app.coderabbit.ai/trpc/accessToken.getAccessAndRefreshToken?input=' +
            encodeURIComponent(JSON.stringify({ code, provider, redirectUri: '' }));

          const res = await fetch(exchangeUrl);
          const data = await res.json();

          if (data.error) {
            reject(new Error(data.error.message || 'Token exchange failed'));
            return;
          }

          const tokenData = data.result?.data?.data || data.result?.data || data.data;
          if (!tokenData?.accessToken) {
            reject(new Error('No access token in exchange response'));
            return;
          }

          await chrome.storage.local.set({
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken || '',
            expiresIn: tokenData.expiresIn || '',
            provider: provider,
            coderabbitToken: tokenData.accessToken
          });

          // Fetch user + org immediately after login
          try {
            const headers = { 'Authorization': `Bearer ${tokenData.accessToken}`, 'Content-Type': 'application/json' };
            const userResp = await fetch('https://app.coderabbit.ai/checkAndCreateUser?provider=github&selfHostedDomain=', { headers });
            if (userResp.ok) {
              const userData = await userResp.json();
              const user = userData.data;
              if (user) {
                const orgInput = encodeURIComponent(JSON.stringify({
                  "0": { user_name: user.user_name, user_id: user.provider_user_id, provider: user.provider, selfHostedDomain: '' }
                }));
                const orgResp = await fetch(`https://app.coderabbit.ai/trpc/organizations.getCurrentOrganization?batch=1&input=${orgInput}`, { headers });
                const orgData = await orgResp.json();
                const org = orgData[0]?.result?.data?.data;
                await chrome.storage.local.set({
                  userId: user.id,
                  userName: user.user_name,
                  userEmail: user.email,
                  providerUserId: user.provider_user_id,
                  organizationId: org?.id || null,
                });
                console.log(`[OAuth] Profile synced: ${user.user_name}, org: ${org?.organization_name || 'none'}`);
              }
            }
          } catch (e) {
            console.warn('[OAuth] Failed to fetch profile after login:', e.message);
          }

          console.log('[OSShepherd OAuth] Login successful. Access token stored.');
          resolve({ success: true });
        } catch (err) {
          reject(err);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ============================================================
// Offscreen Document Management (Workaround for Chromium SW WebSocket DNR Bug)
// ============================================================
let creating;
async function setupOffscreenDocument(path) {
  const offscreenUrl = chrome.runtime.getURL(path);
  const matchedClients = await self.clients.matchAll();
  for (const client of matchedClients) {
    if (client.url === offscreenUrl) return;
  }
  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ['DOM_PARSER'],
      justification: 'WebSocket to CodeRabbit API via OSShepherd (Chromium SW WS header bug workaround)',
    });
    await creating;
    creating = null;
  }
}

async function handleRequestReview(payload, ghTabId) {
  const { owner, repo, prNumber } = payload;

  // If we already have a completed review in storage, serve it from cache.
  const existing = await ReviewStore.load(owner, repo, prNumber);
  if (existing && existing.status === 'complete') {
    console.log(`[Review] Serving cached review for ${owner}/${repo}#${prNumber}`);
    return { initiated: false, cached: true, review: existing };
  }

  // If one appears to be in progress, only block if it started recently (< 5 min ago).
  // A stale 'reviewing' record means the previous session crashed — restart.
  if (existing && existing.status === 'reviewing') {
    const age = Date.now() - (existing.startedAt || 0);
    if (age < 5 * 60 * 1000) {
      console.log(`[Review] Review already in progress for ${owner}/${repo}#${prNumber}`);
      return { initiated: false, inProgress: true };
    }
    console.log(`[Review] Stale reviewing record (${Math.round(age/1000)}s old) — restarting.`);
  }
  console.log(`Starting review for ${owner}/${repo}#${prNumber}`);

  const storageItem = await chrome.storage.local.get(['accessToken', 'coderabbitToken', 'organizationId']);
  const token = (storageItem.accessToken || storageItem.coderabbitToken || '').trim();

  if (!token) {
    throw new Error("Not signed in. Please sign in via the OSShepherd options page.");
  }

  // Auto-fetch org if not already stored
  if (!storageItem.organizationId) {
    try {
      const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
      const userResp = await fetch('https://app.coderabbit.ai/checkAndCreateUser?provider=github&selfHostedDomain=', { headers });
      if (userResp.ok) {
        const userData = await userResp.json();
        const user = userData.data;
        if (user) {
          const orgInput = encodeURIComponent(JSON.stringify({
            "0": { user_name: user.user_name, user_id: user.provider_user_id, provider: user.provider, selfHostedDomain: '' }
          }));
          const orgResp = await fetch(`https://app.coderabbit.ai/trpc/organizations.getCurrentOrganization?batch=1&input=${orgInput}`, { headers });
          const orgData = await orgResp.json();
          const org = orgData[0]?.result?.data?.data;
          if (org?.id) {
            storageItem.organizationId = org.id;
            await chrome.storage.local.set({ organizationId: org.id, userName: user.user_name, userId: user.id });
            console.log(`Auto-fetched org: ${org.organization_name} (${org.id})`);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to auto-fetch org:', e.message);
    }
  }

  // Inject auth headers for the WebSocket upgrade via declarativeNetRequest
  const requestHeaders = [
    { header: "Authorization", operation: "set", value: token },
    { header: "X-CodeRabbit-Extension", operation: "set", value: "vscode" },
    { header: "X-CodeRabbit-Extension-Version", operation: "set", value: chrome.runtime.getManifest().version },
    { header: "X-CodeRabbit-Extension-ClientId", operation: "set", value: generateUUID() },
    { header: "Origin", operation: "remove" }
  ];
  const organizationId = storageItem.organizationId;
  if (organizationId) {
    requestHeaders.push({ header: "x-coderabbitai-organization", operation: "set", value: organizationId });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [DNR_DYNAMIC_RULE_ID],
    addRules: [{
      id: DNR_DYNAMIC_RULE_ID,
      priority: 2,
      action: { type: "modifyHeaders", requestHeaders },
      condition: {
        urlFilter: "ide.coderabbit.ai",
        resourceTypes: ["websocket"]
      }
    }]
  });

  // Fetch the PR diff
  const diffUrl = `https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${prNumber}.diff`;
  const diffResponse = await fetch(diffUrl);
  if (!diffResponse.ok) throw new Error(`Failed to fetch PR diff: ${diffResponse.status}`);
  const diffContent = await diffResponse.text();
  LOG(`[${owner}/${repo}#${prNumber}] Fetched diff, size: ${diffContent.length} bytes`);

  // Delegate WebSocket to offscreen document
  await setupOffscreenDocument('offscreen.html');

  // Use a persistent clientId if available
  const stored = await chrome.storage.local.get('clientId');
  const clientId = stored.clientId || generateUUID();
  if (!stored.clientId) {
    await chrome.storage.local.set({ clientId });
  }
  
  const reviewId = generateUUID();

  // Create the initial pending record HERE in the SW (offscreen has no chrome.storage access)
  const cacheKey = `${owner}/${repo}/${prNumber}`;
  let record = ReviewStore.createRecord(owner, repo, prNumber, reviewId);
  record = Object.assign({}, record, { status: 'reviewing' }); // mark reviewing immediately
  activeRecords.set(cacheKey, record);
  lastEventTime.set(cacheKey, Date.now());
  await ReviewStore.save(record);
  LOG(`[${cacheKey}] Initial record created and saved`);
  updateBadge(ghTabId, record);

  // Start stuck review watchdog for this review
  scheduleStuckCheck(cacheKey, ghTabId);

  // Signal to the tab that the review is starting
  sendToTab(ghTabId, {
    type: 'REVIEW_RESULT',
    payload: { status: 'success', owner, repo, prNumber }
  });

  chrome.runtime.sendMessage({
    type: 'START_OFFSCREEN_REVIEW',
    payload: { owner, repo, prNumber, diffContent, token, tabId: ghTabId, clientId, reviewId, organizationId: storageItem.organizationId || null, extensionVersion: chrome.runtime.getManifest().version }
  });

  return { initiated: true, reviewId };
}
