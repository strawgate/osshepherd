console.log('CodeRabbit PR Review Extension loaded');

// CSS classes for styling
const BTN_CLASS = 'coderabbit-fab';
const BTN_LOADING_CLASS = 'coderabbit-loading';

function injectCodeRabbitButton() {
  if (document.querySelector(`.${BTN_CLASS}`)) {
    return; // Already injected
  }

  const btn = document.createElement('button');
  btn.className = BTN_CLASS;
  btn.innerHTML = `
    <span class="cr-icon">🐰</span> Review with CodeRabbit
  `;

  btn.addEventListener('click', handleReviewClick);

  // Append a floating button to the body directly so it's always visible regardless of DOM changes
  document.body.appendChild(btn);
}

async function handleReviewClick(e) {
  const btn = e.currentTarget;

  // Ping the background script to ensure it's awake and responsive
  try {
    const isAwake = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!isAwake) {
      btn.innerText = 'Extension asleep 😴 (Refresh page!)';
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = '<span class="cr-icon">🐰</span> Review with CodeRabbit';
        btn.disabled = false;
      }, 3000);
      return;
    }
  } catch (err) {
    console.error("Ping failed:", err);
  }

  btn.classList.add(BTN_LOADING_CLASS);
  btn.innerText = 'Rabbit is reviewing...';
  btn.disabled = true;

  try {
    // Determine the current PR details from the URL
    // e.g. https://github.com/owner/repo/pull/123
    const urlParts = window.location.pathname.split('/');
    const owner = urlParts[1];
    const repo = urlParts[2];
    const prNumber = urlParts[4];

    // Run the background script logic instead of fetching here to avoid CORS on patch-diff.githubusercontent.com
    chrome.runtime.sendMessage({
      type: 'REQUEST_REVIEW',
      payload: {
        owner,
        repo,
        prNumber,
        url: window.location.href
      }
    }, (response) => {
      btn.classList.remove(BTN_LOADING_CLASS);
      
      if (chrome.runtime.lastError || !response || !response.success) {
        btn.innerText = 'Review Failed ❌';
        const errObj = chrome.runtime.lastError || response?.error;
        console.error("Review Error:", errObj);
        document.body.setAttribute('data-extension-error', typeof errObj === 'object' ? JSON.stringify(errObj) : String(errObj));
        
        setTimeout(() => {
          btn.innerText = '🐰 Review with CodeRabbit';
          btn.disabled = false;
        }, 3000);
      } else {
        btn.innerText = 'Review Requested! ✅';
        // Now we would listen for results
      }
    });

  } catch (error) {
    console.error('CodeRabbit Chrome Ext Error:', error);
    btn.classList.remove(BTN_LOADING_CLASS);
    btn.innerText = 'Review Failed ❌';
    setTimeout(() => {
      btn.innerHTML = '<span class="cr-icon">🐰</span> Review with CodeRabbit';
      btn.disabled = false;
    }, 3000);
  }
}

// GitHub operates as a SPA, so we need to observe DOM changes
const observer = new MutationObserver(() => {
  if (window.location.href.includes('/pull/')) {
    injectCodeRabbitButton();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial check
if (window.location.href.includes('/pull/')) {
  injectCodeRabbitButton();
}


// --- Listen for review results from Background script ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REVIEW_RESULT') {
    displayReviewResult(message.payload);
  }
  return true;
});

function displayReviewResult(result) {
  // Temporary: just log to console or alert. In Phase 3, we'll build UI to inject into the PR layout.
  console.log("Got review result:", result);
  // Example of a small flash notification
  const flash = document.createElement('div');
  flash.className = 'flash flash-success flash-full position-fixed top-0 left-0 w-100 text-center z-10 cr-flash';
  flash.style.zIndex = '999999';
  flash.innerText = `CodeRabbit Review received! Sent from background.`;
  document.body.appendChild(flash);
  
  setTimeout(() => flash.remove(), 4000);
}
