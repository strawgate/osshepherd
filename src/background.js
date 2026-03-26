importScripts('utils/utils.js');
importScripts('utils/review-store.js');
importScripts('utils/trpc-client.js');

const LOG = (...args) => console.log('[CR:background]', ...args);
const ERR = (...args) => console.error('[CR:background]', ...args);

// High-range ID avoids collisions with static rules (which use low IDs like 1)
const DNR_DYNAMIC_RULE_ID = 1001;

const GITHUB_PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

// In-memory record cache keyed by "owner/repo/prNumber" for the active review session.
// Avoids a storage read on every streaming event. The SW stays alive while events arrive.
const activeRecords = new Map();

// Tracks last event timestamp per active review for stuck detection.
const lastEventTime = new Map();
const FIRST_EVENT_TIMEOUT_MS = 15_000;   // 15s to get the first event (connection/auth failure)
const STUCK_TIMEOUT_MS = 3 * 60 * 1000;  // 3 minutes with no events after first → stuck

// Promise-gate for rehydrating activeRecords from storage on SW restart.
// Prevents race conditions when multiple REVIEW_EVENTs arrive before the first read completes.
const rehydrating = new Map();

async function getOrRehydrateRecord(cacheKey, owner, repo, prNumber) {
  if (activeRecords.has(cacheKey)) return activeRecords.get(cacheKey);
  if (!rehydrating.has(cacheKey)) {
    rehydrating.set(cacheKey, ReviewStore.load(owner, repo, prNumber).then(record => {
      if (record && record.status === 'reviewing') {
        LOG(`[${cacheKey}] Rehydrated active record from storage`);
        activeRecords.set(cacheKey, record);
        lastEventTime.set(cacheKey, Date.now());
      }
      return record;
    }).finally(() => {
      rehydrating.delete(cacheKey);
    }));
  }
  return rehydrating.get(cacheKey);
}

/**
 * Schedule stuck-review detection for a new review.
 *
 * Uses setTimeout for the fast 15s first-event timeout (SW is alive during
 * this window — offscreen keepalive port is connected).
 *
 * Uses chrome.alarms for the 3-minute stuck timeout (survives SW termination;
 * minimum alarm period is 30s, so we set a one-shot at 3 minutes).
 */
function scheduleStuckCheck(cacheKey, tabId) {
  // Fast timeout: 15s for first event (setTimeout is fine — SW is actively alive)
  setTimeout(async () => {
    const record = activeRecords.get(cacheKey);
    if (!record || record.status !== 'reviewing') return;
    if ((record.rawEvents || []).length > 0) return; // events arrived, all good
    ERR(`[${cacheKey}] No events received within ${FIRST_EVENT_TIMEOUT_MS / 1000}s — marking as error.`);
    const errRecord = Object.assign({}, record, { status: 'error' });
    activeRecords.delete(cacheKey);
    lastEventTime.delete(cacheKey);
    chrome.alarms.clear(`stuck:${cacheKey}`);
    ReviewStore.save(errRecord).catch(err => ERR(`[${cacheKey}] Failed to save error record:`, err)).finally(() => {
      sendToTab(tabId, {
        type: 'REVIEW_RESULT',
        payload: { status: 'error', message: `${cacheKey}: Review failed to start — no response from CodeRabbit. Check your connection and try again.` }
      });
    });
  }, FIRST_EVENT_TIMEOUT_MS);

  // Store tabId for the alarm handler (survives SW restart via storage)
  chrome.storage.session.set({ [`stuck-tab:${cacheKey}`]: tabId });

  // Slow timeout: chrome.alarms survives SW termination (minimum 30s period)
  chrome.alarms.create(`stuck:${cacheKey}`, { delayInMinutes: STUCK_TIMEOUT_MS / 60000 });
}

// Alarm handler — MUST be at top level for SW restart registration
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('stuck:')) return;
  const cacheKey = alarm.name.slice(6); // remove 'stuck:' prefix

  // Load record — may need rehydration if SW restarted
  const parts = cacheKey.split('/');
  const record = activeRecords.get(cacheKey)
    || await ReviewStore.load(parts[0], parts[1], parts[2]);

  if (!record || record.status === 'complete' || record.status === 'error') {
    activeRecords.delete(cacheKey);
    lastEventTime.delete(cacheKey);
    return;
  }

  // Check if events have arrived recently
  const lastTime = lastEventTime.get(cacheKey) || record.startedAt || 0;
  const elapsed = Date.now() - lastTime;
  if (elapsed < STUCK_TIMEOUT_MS) {
    // Events are still flowing — re-schedule
    chrome.alarms.create(alarm.name, { delayInMinutes: STUCK_TIMEOUT_MS / 60000 });
    return;
  }

  // Review is stuck
  const mins = Math.round(elapsed / 60000);
  ERR(`[${cacheKey}] Review appears stuck — no events for ${mins} min. Marking as error.`);
  const errRecord = Object.assign({}, record, { status: 'error' });
  activeRecords.delete(cacheKey);
  lastEventTime.delete(cacheKey);

  // Retrieve stored tabId
  const tabData = await chrome.storage.session.get(`stuck-tab:${cacheKey}`);
  const tabId = tabData[`stuck-tab:${cacheKey}`];
  chrome.storage.session.remove(`stuck-tab:${cacheKey}`);

  ReviewStore.save(errRecord).catch(err => ERR(`[${cacheKey}] Failed to save stuck record:`, err)).finally(() => {
    if (tabId) {
      sendToTab(tabId, {
        type: 'REVIEW_RESULT',
        payload: { status: 'error', message: `${cacheKey}: Review timed out — no response for ${mins} minutes. Try re-running the review.` }
      });
    }
  });
});

// Accept keepalive ports from content scripts and offscreen documents.
// The port's existence keeps this SW alive; we don't need to respond.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('content:') || port.name.startsWith('review:')) {
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

/**
 * Returns true when a message sender is a specific extension page.
 * sender.id is the primary trust check (same extension); sender.url narrows to the given page.
 * Do not use for service-worker senders — Chrome may not set sender.url in that context.
 */
function isFromExtensionPage(sender, pagePath) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(pagePath);
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
    // Parse PR identity from the tab URL — don't trust the payload
    const m = sender.tab?.url?.match(GITHUB_PR_URL_REGEX);
    if (!m) { sendResponse({ success: false, error: 'Not a GitHub PR tab' }); return false; }
    const [, owner, repo, prNumber] = m;
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
    if (!isFromExtensionPage(sender, 'options.html') && !isFromExtensionPage(sender, 'sidepanel.html')) {
      ERR('START_OAUTH_LOGIN from unexpected sender:', sender.url);
      sendResponse({ success: false, error: 'Unauthorized' });
      return false;
    }
    handleOAuthLogin()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (request.type === 'REQUEST_REVIEW') {
    const handleResult = (promise) => {
      promise
        .then(res => {
          LOG('handleRequestReview result:', JSON.stringify(res).substring(0, 80));
          sendResponse({ success: true, data: res });
        })
        .catch(err => {
          ERR('handleRequestReview threw:', err.message || err);
          sendResponse({ success: false, error: err.message || String(err) });
        });
    };

    if (sender.tab?.url) {
      // Content script: parse PR identity from the verified tab URL
      const m = sender.tab.url.match(GITHUB_PR_URL_REGEX);
      if (!m) { sendResponse({ success: false, error: 'Not a GitHub PR tab' }); return false; }
      const [, owner, repo, prNumber] = m;
      LOG(`REQUEST_REVIEW from tab ${sender.tab.id}: ${owner}/${repo}#${prNumber}`);
      handleResult(handleRequestReview({ owner, repo, prNumber }, sender.tab.id));
    } else {
      // Side panel: look up the authoritative context from session storage
      if (!isFromExtensionPage(sender, 'sidepanel.html')) {
        ERR('REQUEST_REVIEW (non-tab) from unexpected sender:', sender.url);
        sendResponse({ success: false, error: 'Unauthorized' });
        return false;
      }
      const tabId = request.payload?.tabId;
      if (!tabId) { sendResponse({ success: false, error: 'Missing tabId' }); return false; }
      chrome.storage.session.get(`sidepanel:context:${tabId}`, (result) => {
        const ctx = result[`sidepanel:context:${tabId}`];
        if (!ctx) { sendResponse({ success: false, error: 'No session context for tab' }); return; }
        LOG(`REQUEST_REVIEW from sidepanel for tab ${tabId}: ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`);
        handleResult(handleRequestReview({ owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber }, tabId));
      });
    }
    return true;
  }

  // Streaming event from offscreen — save to storage and forward to tab
  if (request.type === 'REVIEW_EVENT' || request.type === 'REVIEW_COMPLETE' || request.type === 'REVIEW_ERROR') {
    if (!isFromExtensionPage(sender, 'offscreen.html')) {
      ERR(`${request.type} from unexpected sender:`, sender.url);
      return false;
    }
  }

  if (request.type === 'REVIEW_EVENT') {
    const { owner, repo, prNumber, tabId, event } = request;
    const cacheKey = `${owner}/${repo}/${prNumber}`;

    // Rehydrate from storage if the SW restarted and lost the in-memory record
    const processEvent = async () => {
      let record = await getOrRehydrateRecord(cacheKey, owner, repo, prNumber);
      if (!record) {
        ERR(`[${cacheKey}] REVIEW_EVENT received but no active record (even after rehydration)`);
        return;
      }
      lastEventTime.set(cacheKey, Date.now());
      record = ReviewStore.applyEvent(record, event);
      activeRecords.set(cacheKey, record);
      await ReviewStore.save(record);
      sendToTab(tabId, { type: 'REVIEW_UPDATE', payload: { data: event } });
      updateBadge(tabId, record);
    };
    processEvent().catch(err => ERR(`[${cacheKey}] Failed to process event:`, err));
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
    // Keep the terminal record in activeRecords so any late REVIEW_EVENTs that
    // arrive before the save completes see the 'complete' status and are ignored,
    // rather than re-triggering rehydration against the old 'reviewing' record.
    activeRecords.set(cacheKey, completed);
    lastEventTime.delete(cacheKey);
    chrome.alarms.clear(`stuck:${cacheKey}`);
    chrome.storage.session.remove(`stuck-tab:${cacheKey}`);
    ReviewStore.save(completed).then(() => {
      activeRecords.delete(cacheKey); // safe to evict now — storage is the source of truth
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
    activeRecords.delete(cacheKey);
    lastEventTime.delete(cacheKey);
    chrome.alarms.clear(`stuck:${cacheKey}`);
    chrome.storage.session.remove(`stuck-tab:${cacheKey}`);
    ReviewStore.save(record).then(() => {
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
let pendingOAuthTabId = null;

async function handleOAuthLogin() {
  if (pendingOAuthTabId !== null) {
    throw new Error('A login is already in progress. Please complete or cancel it first.');
  }
  // Claim the slot synchronously so concurrent calls fail the guard above
  // before chrome.tabs.create has a chance to return the real tab id.
  pendingOAuthTabId = true;

  const state = generateUUID();
  // Open CodeRabbit login with client=vscode params — user clicks "Sign in with GitHub"
  // After GitHub OAuth, it redirects back to app.coderabbit.ai/login?code=XXX&state=github
  const loginUrl = `https://app.coderabbit.ai/login?client=vscode&state=${state}&variant=vscode`;

  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: loginUrl }, (loginTab) => {
      if (!loginTab) {
        pendingOAuthTabId = null;
        reject(new Error('Failed to open login tab'));
        return;
      }
      const tabId = loginTab.id;
      pendingOAuthTabId = tabId;

      const cleanupOAuth = () => {
        pendingOAuthTabId = null;
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(onTabClosed);
      };

      const timeout = setTimeout(() => {
        cleanupOAuth();
        chrome.tabs.remove(tabId).catch(() => {});
        reject(new Error('Login timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      const onTabClosed = (removedTabId) => {
        if (removedTabId !== tabId) return;
        clearTimeout(timeout);
        cleanupOAuth();
        reject(new Error('Login cancelled — the sign-in tab was closed.'));
      };
      chrome.tabs.onRemoved.addListener(onTabClosed);

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
        cleanupOAuth();
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
      reasons: ['WORKERS'],
      justification: 'Persistent WebSocket connection to CodeRabbit streaming API',
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

  // Inject auth headers for the WebSocket upgrade via declarativeNetRequest.
  // Chrome supports arbitrary custom headers; Safari only allows standard headers.
  // We try with all headers first, then fall back to essentials-only for Safari.
  const organizationId = storageItem.organizationId;
  const essentialHeaders = [
    { header: "Authorization", operation: "set", value: token },
    { header: "Origin", operation: "remove" }
  ];
  const fullHeaders = [
    ...essentialHeaders,
    { header: "X-CodeRabbit-Extension", operation: "set", value: "vscode" },
    { header: "X-CodeRabbit-Extension-Version", operation: "set", value: chrome.runtime.getManifest().version },
    { header: "X-CodeRabbit-Extension-ClientId", operation: "set", value: generateUUID() },
  ];
  if (organizationId) {
    essentialHeaders.push({ header: "x-coderabbitai-organization", operation: "set", value: organizationId });
    fullHeaders.push({ header: "x-coderabbitai-organization", operation: "set", value: organizationId });
  }

  const dnrRule = (headers) => ({
    removeRuleIds: [DNR_DYNAMIC_RULE_ID],
    addRules: [{
      id: DNR_DYNAMIC_RULE_ID,
      priority: 2,
      action: { type: "modifyHeaders", requestHeaders: headers },
      condition: { urlFilter: "||ide.coderabbit.ai/", resourceTypes: ["websocket"] }
    }]
  });

  try {
    await chrome.declarativeNetRequest.updateDynamicRules(dnrRule(fullHeaders));
  } catch (e) {
    // Safari rejects custom headers — fall back to essentials only
    LOG('Full DNR headers rejected (Safari?), falling back to essentials:', e.message);
    await chrome.declarativeNetRequest.updateDynamicRules(dnrRule(essentialHeaders));
  }

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
