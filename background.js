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

        console.log('[OAuth] Tab URL:', url.substring(0, 120));

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
            provider = qs.get('provider') || 'github';
          }
        } catch { /* ignore URL parse errors */ }

        if (!code) return;

        // Got a code! Immediately stop the tab from processing it
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Stop the page from loading further (prevents CodeRabbit SPA from consuming the code)
        chrome.tabs.update(tabId, { url: 'about:blank' });
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 500);

        console.log('[OAuth] Intercepted auth code! Exchanging for tokens...');

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

          console.log('[OAuth] Login successful! Access token stored.');
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
// CodeRabbit Bridge: Open WS from CodeRabbit's own domain
// ============================================================
// By injecting a content script into app.coderabbit.ai, the browser
// automatically includes CodeRabbit's session cookies with the WebSocket
// handshake to ide.coderabbit.ai. This bypasses Cloud Armor's requirement
// for the Authorization header — the session cookies authenticate instead.

async function getOrCreateCodeRabbitTab() {
  // Look for an existing app.coderabbit.ai tab
  const tabs = await chrome.tabs.query({ url: 'https://app.coderabbit.ai/*' });
  if (tabs.length > 0) {
    return tabs[0].id;
  }
  // Open one in the background if none exists
  const tab = await chrome.tabs.create({ url: 'https://app.coderabbit.ai/settings/repositories', active: false });
  // Wait for it to load
  await new Promise(resolve => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab.id;
}

async function handleRequestReview(payload, ghTabId) {
  const { owner, repo, prNumber } = payload;
  console.log(`Starting review for ${owner}/${repo}#${prNumber}`);

  const storageItem = await chrome.storage.local.get(['accessToken', 'coderabbitToken']);
  const token = (storageItem.accessToken || storageItem.coderabbitToken || '').trim();

  if (!token) {
    throw new Error("Not signed in. Please sign in via the extension options page.");
  }

  // Fetch the PR diff
  const diffUrl = `https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${prNumber}.diff`;
  const diffResponse = await fetch(diffUrl);
  if (!diffResponse.ok) throw new Error(`Failed to fetch PR diff: ${diffResponse.status}`);
  const diffContent = await diffResponse.text();
  console.log(`Fetched diff, size: ${diffContent.length} bytes`);

  // Find or create a tab on app.coderabbit.ai (so cookies are in scope)
  const crTabId = await getOrCreateCodeRabbitTab();
  console.log(`Using CodeRabbit tab ${crTabId} for WebSocket bridge`);

  // Inject the bridge script into the CodeRabbit tab
  await chrome.scripting.executeScript({
    target: { tabId: crTabId },
    files: ['coderabbit-bridge.js']
  });

  const clientId = generateUUID();
  const reviewId = generateUUID();

  // Send the review request to the bridge script running in the CodeRabbit tab
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(crTabId, {
      type: 'START_CODERABBIT_WS_REVIEW',
      payload: { owner, repo, prNumber, diffContent, token, tabId: ghTabId, clientId, reviewId }
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Bridge communication failed: ${chrome.runtime.lastError.message}`));
        return;
      }
      if (response?.success) {
        console.log('Review response from bridge:', response.data);
        // Forward success to the GitHub tab
        chrome.tabs.sendMessage(ghTabId, {
          type: 'REVIEW_RESULT',
          payload: { status: 'success', message: 'Review submitted via CodeRabbit bridge!' }
        });
        resolve(response.data);
      } else {
        const errMsg = response?.error || 'Unknown bridge error';
        console.error('Bridge error:', errMsg);
        chrome.tabs.sendMessage(ghTabId, {
          type: 'REVIEW_RESULT',
          payload: { status: 'error', message: errMsg }
        });
        reject(new Error(errMsg));
      }
    });
  });
}
