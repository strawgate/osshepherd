const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 9090 });

wss.on('error', (err) => {
  console.error('WebSocket server error:', err.code, err.message);
  process.exit(1);
});

wss.on('connection', (ws, req) => {
  console.log("== HEADERS RECEIVED FROM EXTENSION ==");
  console.log(JSON.stringify(req.headers, null, 2));
  ws.close();
  process.exit(0);
});

console.log("Listening on 9090...");
