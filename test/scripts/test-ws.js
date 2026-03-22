const WebSocket = require('ws');
console.log("Connecting...");
const ws = new WebSocket('wss://ide.coderabbit.ai/ws?connectionParams=1', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  }
});
const timeout = setTimeout(() => {
  console.log('TIMEOUT — no open or error after 10s');
  ws.terminate();
  process.exit(1);
}, 10_000);
ws.on('open', () => {
  clearTimeout(timeout);
  console.log('OPENED!');
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => {
  clearTimeout(timeout);
  console.log('ERROR:', e.message);
  process.exit(1);
});
