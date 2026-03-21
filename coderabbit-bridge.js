// This script gets injected into an app.coderabbit.ai tab
// Because it runs in the CodeRabbit domain, the browser automatically sends
// session cookies with the WebSocket handshake to ide.coderabbit.ai
// This bypasses Cloud Armor's requirement for auth headers

(function() {
  // Listen for messages from the extension's background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'START_CODERABBIT_WS_REVIEW') {
      handleReview(request.payload)
        .then(result => sendResponse({ success: true, data: result }))
        .catch(err => sendResponse({ success: false, error: err.message || String(err) }));
      return true; // async
    }
  });

  async function handleReview(payload) {
    const { owner, repo, prNumber, diffContent, token, tabId, clientId, reviewId } = payload;

    console.log(`[CRBridge] Opening WebSocket from CodeRabbit domain context...`);

    return new Promise((resolve, reject) => {
      const wsUrl = 'wss://ide.coderabbit.ai/ws?connectionParams=1';
      console.log('[CRBridge] Connecting to:', wsUrl);
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[CRBridge] ✅ WebSocket OPEN! Cookies were sent automatically.');
        // Send connectionParams with the access token
        const authPayload = {
          method: 'connectionParams',
          data: { accessToken: token, extension: 'vscode' }
        };
        console.log('[CRBridge] Sending connectionParams...');
        ws.send(JSON.stringify(authPayload));

        // Give server time to process auth, then send the mutation
        setTimeout(() => {
          const mutationPayload = {
            id: 1,
            method: 'mutation',
            params: {
              path: 'vsCode.requestFullReview',
              input: {
                extensionEvent: {
                  userId: clientId,
                  userName: "ChromeExtensionUser",
                  clientId: clientId,
                  eventType: "REVIEW",
                  reviewId: reviewId,
                  files: [{
                    rawPath: "pr.diff",
                    fileLanguage: "diff",
                    baseStr: "",
                    headStr: diffContent
                  }],
                  hostUrl: "https://github.com",
                  provider: "github",
                  remoteUrl: `https://github.com/${owner}/${repo}.git`,
                  host: "vscode",
                  version: "1.0.0"
                }
              }
            }
          };
          console.log('[CRBridge] 📤 Sending review mutation...');
          ws.send(JSON.stringify(mutationPayload));
        }, 500);
      };

      ws.onmessage = (event) => {
        console.log('[CRBridge] 📩 Message:', event.data.substring(0, 300));
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.id === 1) {
            // Response to our mutation
            if (parsed.error) {
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            } else {
              resolve(parsed.result);
            }
            ws.close();
          } else if (parsed.error) {
            // Server-level error (e.g., "Invalid token")
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            ws.close();
          }
        } catch (e) {
          console.warn('[CRBridge] Parse error:', e);
        }
      };

      ws.onerror = (error) => {
        console.error('[CRBridge] ❌ WebSocket Error:', error);
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = (event) => {
        console.log('[CRBridge] WebSocket closed:', event.code, event.reason);
      };

      // Timeout after 30 seconds
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
          reject(new Error('Review request timed out'));
        }
      }, 30000);
    });
  }
})();
