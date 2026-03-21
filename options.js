document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const saveBtn = document.getElementById('saveBtn');
  const tokenInput = document.getElementById('token');
  const statusMessage = document.getElementById('statusMessage');
  const authCard = document.getElementById('authCard');
  const authStatus = document.getElementById('authStatus');
  const authUser = document.getElementById('authUser');

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
      authUser.textContent = data.provider ? `via ${data.provider}` : 'Token configured';
      loginBtn.style.display = 'none';
      logoutBtn.style.display = 'block';
      tokenInput.value = data.accessToken || data.coderabbitToken || '';
    } else {
      authCard.classList.remove('logged-in');
      authStatus.textContent = 'Not signed in';
      authUser.style.display = 'none';
      loginBtn.style.display = 'block';
      logoutBtn.style.display = 'none';
      tokenInput.value = '';
    }
  }

  // Load existing auth state
  chrome.storage.local.get(['accessToken', 'refreshToken', 'provider', 'coderabbitToken'], updateAuthUI);

  // --- OAuth Login via background script ---
  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner"></span>Waiting for login...';
    showStatus('A login tab will open. Please sign in with CodeRabbit.', 'success');

    // Ask the background script to handle the OAuth flow
    chrome.runtime.sendMessage({ type: 'START_OAUTH_LOGIN' }, (response) => {
      loginBtn.disabled = false;
      loginBtn.innerHTML = 'Sign in with CodeRabbit';

      if (response && response.success) {
        showStatus('Successfully signed in!', 'success');
        chrome.storage.local.get(['accessToken', 'provider', 'coderabbitToken'], updateAuthUI);
      } else {
        showStatus(response?.error || 'Login failed', 'error');
      }
    });
  });

  // Logout
  logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresIn', 'provider', 'coderabbitToken']);
    updateAuthUI(null);
    showStatus('Signed out', 'success');
  });

  // Manual token save
  saveBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) { showStatus('Please enter a token', 'error'); return; }
    chrome.storage.local.set({ coderabbitToken: token, accessToken: token }, () => {
      showStatus('Token saved!', 'success');
      updateAuthUI({ accessToken: token });
    });
  });
});
