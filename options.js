document.addEventListener('DOMContentLoaded', () => {
  const tokenInput = document.getElementById('token');
  const saveBtn = document.getElementById('saveBtn');
  const statusMessage = document.getElementById('statusMessage');

  // Load existing token
  chrome.storage.local.get(['coderabbitToken'], (result) => {
    if (result.coderabbitToken) {
      tokenInput.value = result.coderabbitToken;
    }
  });

  // Save token on click
  saveBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    chrome.storage.local.set({ coderabbitToken: token }, () => {
      statusMessage.classList.add('show');
      setTimeout(() => {
        statusMessage.classList.remove('show');
      }, 3000);
    });
  });
});
