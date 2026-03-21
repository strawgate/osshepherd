importScripts('utils/trpc-client.js');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ success: true });
    return false;
  }

  if (request.type === 'FORWARD_TO_TAB') {
    chrome.tabs.sendMessage(request.tabId, request.message);
    sendResponse({ success: true });
    return false;
  }

  if (request.type === 'START_OAUTH_LOGIN') {
    handleOAuthLogin()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (request.type === 'REQUEST_REVIEW') {
    handleRequestReview(request.payload, sender.tab.id)
      .then(res => sendResponse({ success: true, data: res }))
      .catch(err => {
        console.error("Background caught error:", err);
        const errorMsg = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err)) || "Unknown error";
        sendResponse({ success: false, error: errorMsg });
      });
    return true;
  }
});

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================================
// OAuth Login Flow
// ============================================================
async function handleOAuthLogin() {
  const state = generateUUID();
  const loginUrl = `https://app.coderabbit.ai/login?client=vscode&state=${state}`;

  return new Promise((resolve, reject) => {
    // Step 1: Open logout URL to clear CodeRabbit's session, then redirect to login
    // This forces a fresh auth flow that generates a new code  
    const fullUrl = `https://app.coderabbit.ai/auth/signout?callbackUrl=${encodeURIComponent(loginUrl)}`;
    
    chrome.tabs.create({ url: fullUrl }, (loginTab) => {
      const tabId = loginTab.id;
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.remove(tabId).catch(() => {});
        reject(new Error('Login timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      const listener = async (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId) return;
        const url = changeInfo.url || tab.url || '';

        console.log('[OAuth] Tab URL changed:', url.substring(0, 80));

        // Watch for the coderabbit-cli:// redirect
        if (url.startsWith('coderabbit-cli://auth-callback') || url.includes('auth-callback?code=')) {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.remove(tabId).catch(() => {});

          try {
            // Parse the auth code from the callback URL
            let params;
            try {
              params = new URL(url).searchParams;
            } catch {
              // coderabbit-cli:// may not parse as a valid URL in all contexts
              const queryString = url.split('?')[1] || '';
              params = new URLSearchParams(queryString);
            }
            const code = params.get('code');
            const provider = params.get('provider') || 'github';

            if (!code) {
              reject(new Error('No authorization code in callback URL'));
              return;
            }

            console.log('[OAuth] Got auth code, exchanging for tokens...');

            // Exchange code for access + refresh tokens
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

            // Store tokens
            await chrome.storage.local.set({
              accessToken: tokenData.accessToken,
              refreshToken: tokenData.refreshToken || '',
              expiresIn: tokenData.expiresIn || '',
              provider: provider,
              coderabbitToken: tokenData.accessToken
            });

            console.log('[OAuth] Login successful! Token stored.');
            resolve({ success: true });
          } catch (err) {
            reject(err);
          }
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ============================================================
// Offscreen Document Management
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
      justification: 'WebSocket to CodeRabbit API (Chromium SW WS header bug workaround)',
    });
    await creating;
    creating = null;
  }
}

// ============================================================
// Review Request Handler
// ============================================================
async function handleRequestReview(payload, tabId) {
  const { owner, repo, prNumber } = payload;
  console.log(`Starting review for ${owner}/${repo}#${prNumber}`);

  const storageItem = await chrome.storage.local.get(['accessToken', 'coderabbitToken']);
  const token = (storageItem.accessToken || storageItem.coderabbitToken || '').trim();

  if (!token) {
    throw new Error("Not signed in. Please sign in via the extension options page.");
  }

  // Inject auth headers for the WebSocket upgrade via declarativeNetRequest
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [2],
    addRules: [{
      id: 2,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Authorization", operation: "set", value: token },
          { header: "X-CodeRabbit-Extension", operation: "set", value: "vscode" },
          { header: "X-CodeRabbit-Extension-Version", operation: "set", value: "1.0.6" },
          { header: "X-CodeRabbit-Extension-ClientId", operation: "set", value: generateUUID() }
        ]
      },
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
  console.log(`Fetched diff, size: ${diffContent.length} bytes`);

  // Delegate WebSocket to offscreen document
  await setupOffscreenDocument('offscreen.html');

  const clientId = generateUUID();
  const reviewId = generateUUID();

  chrome.runtime.sendMessage({
    type: 'START_OFFSCREEN_REVIEW',
    payload: { owner, repo, prNumber, diffContent, token, tabId, clientId, reviewId }
  });

  return { initiated: true, reviewId };
}
