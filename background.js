importScripts('utils/trpc-client.js');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ success: true });
    return false; // synchronous response
  }

  if (request.type === 'REQUEST_REVIEW') {
    handleRequestReview(request.payload, sender.tab.id)
      .then(res => sendResponse({ success: true, data: res }))
      .catch(err => {
        console.error("Background caught error:", err);
        const errorMsg = err.message || (err.type ? `Event: ${err.type}` : null) || (typeof err === 'object' ? JSON.stringify(err) : String(err)) || "Unknown WS connection error";
        sendResponse({ success: false, error: errorMsg });
      });
    return true; // Keep message channel open for async response
  }
});

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Global client mapping to tabs so we can stream results back
const clients = new Map();

async function handleRequestReview(payload, tabId) {
  const { owner, repo, prNumber } = payload;
  console.log(`Starting review for ${owner}/${repo}#${prNumber}`);

    // Fetch the token from storage
    const storageItem = await chrome.storage.local.get('coderabbitToken');
    const token = storageItem.coderabbitToken;

    if (!token) {
      throw new Error("No CodeRabbit token configured. Please set it in options.");
    }

    // CRITICAL: Chrome browser WebSockets cannot send custom HTTP headers natively. 
    // CodeRabbit's Cloud Armor requires the Token and Proprietary headers on the Handshake layer.
    // We dynamically intercept the browser's network request to force inject these headers just before the socket opens.
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [2],
      addRules: [
        {
          id: 2,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Authorization", operation: "set", value: token },
              { header: "X-CodeRabbit-Extension", operation: "set", value: "vscode" },
              { header: "X-CodeRabbit-Extension-Version", operation: "set", value: "1.0.6" },
              { header: "X-CodeRabbit-Extension-ClientId", operation: "set", value: "123e4567-e89b-12d3-a456-426614174000" }
            ]
          },
          condition: {
            urlFilter: "ide.coderabbit.ai",
            resourceTypes: ["websocket"]
          }
        }
      ]
    });

    // 1. Fetch the diff string
    const diffUrl = `https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${prNumber}.diff`;
    const diffResponse = await fetch(diffUrl);
    if (!diffResponse.ok) {
      throw new Error(`Failed to fetch PR diff: ${diffResponse.status}`);
    }
    const diffContent = await diffResponse.text();

    console.log(`Fetched diff, size: ${diffContent.length} bytes`);

    // 2. Connect to CodeRabbit via WebSocket (our dynamic rule now secretly attaches the auth headers!)
    const client = new CodeRabbitClient(token);
    await client.connect();
  
  // Store client so it stays alive if we want to add subscription handling later
  clients.set(tabId, client);

  // Generate a random review/client ID
  const clientId = generateUUID();
  const reviewId = generateUUID();

  // Send request
  const requestPayload = {
    extensionEvent: {
      userId: clientId,
      userName: "ChromeExtensionUser",
      clientId: clientId,
      eventType: "REVIEW",
      reviewId: reviewId,
      // For a basic raw PR review, CodeRabbit usually just needs the files or diff.
      // We pass the raw diff as a single file item (CodeRabbit might parse it if it's a unified diff, or we might need to parse into file objects)
      files: [{
        rawPath: "pr.diff", 
        fileLanguage: "diff",
        baseStr: "",
        headStr: diff
      }],
      hostUrl: "https://github.com",
      provider: "github",
      remoteUrl: `https://github.com/${owner}/${repo}.git`,
      host: "vscode", 
      version: "1.0.0"
    }
  };

  try {
    const response = await client.requestFullReview(requestPayload);
    console.log("Review request submitted:", response);

    // After mutation, we just send a mock success to content since we don't have the subscription setup yet
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {
        type: 'REVIEW_RESULT',
        payload: { 
          status: 'success', 
          message: 'CodeRabbit is reviewing the diff in the background. (Subscription logic to be mapped).'
        }
      });
    }, 1000);

    return { initiated: true, reviewId };
  } catch (err) {
    console.error("Mutation failed:", err);
    throw err;
  }
}
