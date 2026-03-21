class CodeRabbitClient {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.messageId = 1;
    this.resolvers = new Map();
    this.subscriptions = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      // Connect to the IDE websocket endpoint with connectionParams=1
      const wsUrl = `wss://ide.coderabbit.ai/ws?connectionParams=1`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("Connected to CodeRabbit WebSocket");
        // Immediately send connection params for authentication
        const authPayload = {
          method: 'connectionParams',
          data: {
            accessToken: this.token,
            extension: 'vscode'
          }
        };
        this.ws.send(JSON.stringify(authPayload));
        
        // Give the server a small buffer to process auth before we resolve start sending queries
        setTimeout(resolve, 300);
      };

      this.ws.onmessage = (event) => {
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
