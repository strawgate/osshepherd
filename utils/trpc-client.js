class CodeRabbitClient {
  constructor(token, proxyUrl) {
    this.token = token;
    this.proxyUrl = proxyUrl || null;
    this.ws = null;
    this.messageId = 1;
    this.resolvers = new Map();
    this.subscriptions = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      let wsUrl;
      if (this.proxyUrl) {
        // Route through local proxy — pass token as query param, proxy adds HTTP headers upstream
        wsUrl = `${this.proxyUrl}?connectionParams=1&token=${encodeURIComponent(this.token)}`;
      } else {
        // Direct connection (only works from Node.js, not from Chrome)
        wsUrl = `wss://ide.coderabbit.ai/ws?connectionParams=1`;
      }
      console.log("Connecting to:", wsUrl.replace(this.token, '***'));
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WS] ✅ Connected! readyState:', this.ws.readyState);
        // Immediately send connection params for authentication
        const authPayload = {
          method: 'connectionParams',
          data: {
            accessToken: this.token,
            extension: 'vscode'
          }
        };
        console.log('[WS] Sending connectionParams (token prefix):', this.token.substring(0, 15) + '...');
        this.ws.send(JSON.stringify(authPayload));
        
        // Give the server a small buffer to process auth before we resolve
        setTimeout(resolve, 300);
      };

      this.ws.onmessage = (event) => {
        console.log('[WS] 📩 Message received:', typeof event.data === 'string' ? event.data.substring(0, 200) : event.data);
        this.handleMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        reject(error);
      };

      this.ws.onclose = (event) => {
        console.log("WebSocket connection closed:", event.code, event.reason);
        for (const [id, resolver] of this.resolvers.entries()) {
          resolver.reject(new Error(`WebSocket closed unexpectedly with code ${event.code}`));
        }
        this.resolvers.clear();
      };
    });
  }

  handleMessage(data) {
    // Basic ping/pong handler if CodeRabbit uses it
    if (data === "PING") {
      this.ws.send("PONG");
      return;
    }
    
    try {
      const parsed = JSON.parse(data);
      // TRPC message handling
      if (parsed.id !== undefined && this.resolvers.has(parsed.id)) {
        const resolver = this.resolvers.get(parsed.id);
        if (parsed.error) {
          resolver.reject(parsed.error);
        } else if (parsed.result && parsed.result.type === 'data') {
          resolver.resolve(parsed.result.data);
        } else if (parsed.result && parsed.result.type === 'stopped') {
          // Subscription stopped
          resolver.resolve();
        }
        
        // If it's a mutation/query, clean up. If it's a sub, keep it until stopped.
        if (!this.subscriptions.has(parsed.id)) {
          this.resolvers.delete(parsed.id);
        }
      } else if (parsed.method === 'subscription.data') {
        const subId = parsed.params.subscription;
        if (this.subscriptions.has(subId)) {
          this.subscriptions.get(subId)(parsed.params.result?.data);
        }
      }
    } catch (e) {
      console.warn("Failed to parse WS msg:", data, e);
    }
  }

  async sendRequest(method, params, type = 'mutation') {
    return new Promise((resolve, reject) => {
      const id = this.messageId++;
      this.resolvers.set(id, { resolve, reject });

      const payload = {
        id,
        method: type,
        params: {
          path: method,
          input: params
        }
      };
      
      console.log(`[WS] 📤 Sending ${type} #${id}:`, method);
      this.ws.send(JSON.stringify(payload));
    });
  }

  async requestFullReview(payload) {
    // Triggers vsCode.requestFullReview mutation
    return this.sendRequest('vsCode.requestFullReview', payload, 'mutation');
  }
}

// Export for ES modules or attach to global for importScripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CodeRabbitClient;
} else {
  globalThis.CodeRabbitClient = CodeRabbitClient;
}
