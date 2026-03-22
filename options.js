document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const statusMessage = document.getElementById('statusMessage');
  const authCard = document.getElementById('authCard');
  const authStatus = document.getElementById('authStatus');
  const authUser = document.getElementById('authUser');
  const debugInfo = document.getElementById('debugInfo');

  function showStatus(message, type = 'success') {
    statusMessage.textContent = message;
    statusMessage.className = 'status show ' + type;
    setTimeout(() => { statusMessage.className = 'status'; }, 5000);
  }

  function updateAuthUI(data) {
    if (data && (data.accessToken || data.coderabbitToken)) {
      authCard.classList.add('logged-in');
      authStatus.textContent = '✅ Signed in';
      authUser.style.display = 'block';
      authUser.textContent = data.userName ? `@${data.userName}` : (data.provider ? `via ${data.provider}` : 'Token configured');
      loginBtn.style.display = 'none';
      logoutBtn.style.display = 'block';
    } else {
      authCard.classList.remove('logged-in');
      authStatus.textContent = 'Not signed in';
      authUser.style.display = 'none';
      loginBtn.style.display = 'block';
      logoutBtn.style.display = 'none';
    }
  }

  const AUTH_KEYS = ['accessToken', 'refreshToken', 'provider', 'coderabbitToken', 'userName', 'organizationId'];
  chrome.storage.local.get(AUTH_KEYS, updateAuthUI);

  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner"></span>Connecting to CodeRabbit™...';
    showStatus('A login tab will open. Please sign in with your CodeRabbit account.', 'success');

    chrome.runtime.sendMessage({ type: 'START_OAUTH_LOGIN' }, (response) => {
      loginBtn.disabled = false;
      loginBtn.innerHTML = 'Sign in with CodeRabbit™';

      if (chrome.runtime.lastError) {
        showStatus(chrome.runtime.lastError.message || 'Login failed', 'error');
        return;
      }

      if (response && response.success) {
        showStatus('Successfully signed in!', 'success');
        chrome.storage.local.get(AUTH_KEYS, updateAuthUI);
      } else {
        showStatus(response?.error || 'Login failed', 'error');
      }
    });
  });

  logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresIn', 'provider', 'coderabbitToken',
      'userId', 'userName', 'userEmail', 'providerUserId', 'organizationId']);
    updateAuthUI(null);
    showStatus('Signed out', 'success');
  });

  // Clear review cache
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const cacheStatus = document.getElementById('cacheStatus');
  clearCacheBtn.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    clearCacheBtn.textContent = 'Clearing…';
    try {
      const reviews = await ReviewStore.loadAll();
      for (const r of reviews) {
        await ReviewStore.remove(r.owner, r.repo, r.prNumber);
      }
      // Safety-net: ensure index is cleared even if ReviewStore.remove() left stale state
      await new Promise(resolve => chrome.storage.local.remove('reviews:index', resolve));
      clearCacheBtn.textContent = `Cleared ${reviews.length} review${reviews.length !== 1 ? 's' : ''}`;
      cacheStatus.textContent = `${reviews.length} cached review${reviews.length !== 1 ? 's' : ''} removed.`;
      cacheStatus.className = 'status show success';
    } catch (err) {
      cacheStatus.textContent = err.message;
      cacheStatus.className = 'status show error';
    }
    setTimeout(() => {
      clearCacheBtn.disabled = false;
      clearCacheBtn.textContent = 'Clear All Cached Reviews';
      cacheStatus.className = 'status';
    }, 3000);
  });

  function refreshDebugInfo() {
    chrome.storage.local.get(null, (all) => {
      const info = {
        accessToken: all.accessToken ? `${all.accessToken.substring(0, 20)}... (${all.accessToken.length} chars)` : 'NOT SET',
        coderabbitToken: all.coderabbitToken ? `${all.coderabbitToken.substring(0, 20)}...` : 'NOT SET',
        userName: all.userName || 'NOT SET',
        organizationId: all.organizationId || 'NOT SET',
        provider: all.provider || 'NOT SET',
      };
      debugInfo.textContent = JSON.stringify(info, null, 2);
    });
  }
  refreshDebugInfo();
  setInterval(refreshDebugInfo, 2000);
});
