const WebSocket = require("ws");

const token = process.env.TEST_TOKEN;
if (!token) {
  console.error('❌ Missing TEST_TOKEN environment variable');
  process.exit(1);
}

const ws = new WebSocket("wss://ide.coderabbit.ai/ws?connectionParams=1", [token]);
ws.on("open", () => {
  console.log("CONNECTED VIA PROTOCOL HEADER!");
  ws.close();
  process.exit(0);
});
ws.on("error", e => {
  console.log("ERR:", e.message);
  process.exit(1);
});
ws.on("unexpected-response", (q, r) => {
  console.log("REJECTED:", r.statusCode);
  process.exit(1);
});
setTimeout(() => {
  console.log("TIMEOUT — no response after 5s");
  process.exit(1);
}, 5000);
