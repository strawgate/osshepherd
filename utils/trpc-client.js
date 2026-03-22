// @ts-check

/**
 * @typedef {Object} SubscribeAndMutateResult
 * @property {Promise<any>} promise     - Resolves/rejects with the mutation result
 * @property {() => void}  unsubscribe  - Stops the subscription early
 */

class CodeRabbitClient {
  constructor(token, { proxyUrl, wsFactory, authTimeout } = {}) {
    this.token = token;
    this.proxyUrl = proxyUrl || null;
    this.wsFactory = wsFactory || ((url) => new WebSocket(url));
    this.authTimeout = authTimeout ?? 500;
    this.ws = null;
    this.messageId = 1;
    this.resolvers = new Map();
    this.subscriptions = new Map();
  }

  async connect(organizationId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let authTimer = null;

      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        fn(val);
      };

      let wsUrl;
      if (this.proxyUrl) {
        wsUrl = `${this.proxyUrl}?connectionParams=1&token=${encodeURIComponent(this.token)}`;
      } else {
        wsUrl = `wss://ide.coderabbit.ai/ws?connectionParams=1`;
      }
      console.log("Connecting to:", wsUrl.replace(this.token, '***'));
      this.ws = this.wsFactory(wsUrl);

      this.ws.onopen = () => {
        console.log('[WS] ✅ Connected! readyState:', this.ws.readyState);
        const authData = { accessToken: this.token };
        if (organizationId) authData.organizationId = organizationId;
        this.ws.send(JSON.stringify({ method: 'connectionParams', data: authData }));

        // The server does not send an explicit auth-ack for connectionParams.
        // Resolve after authTimeout if no error/close has arrived by then.
        authTimer = setTimeout(() => {
          this.authenticated = true;
          settle(resolve);
        }, this.authTimeout);
      };

      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'connection_error') {
            settle(reject, new Error(parsed.payload?.message || 'Connection rejected by server'));
            return;
          }
        } catch { /* ignore parse err */ }
        this.handleMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        settle(reject, error);
      };

      this.ws.onclose = (event) => {
        const code = event?.code ?? event;
        console.log("[WS] ❌ Disconnected from CodeRabbit code:", code);
        this.authenticated = false;
        // Drain pending resolvers so callers don't hang
        for (const [id, { reject: rej }] of this.resolvers) {
          rej(new Error(`WebSocket closed (code ${code})`));
          this.resolvers.delete(id);
        }
        settle(reject, new Error(`WebSocket closed before auth completed (code ${code})`));
      };
    });
  }

  handleMessage(data) {
    try {
      const parsed = JSON.parse(data);

      // Handle subscription chunks
      if (parsed.id !== undefined && this.subscriptions.has(parsed.id)) {
        const sub = this.subscriptions.get(parsed.id);
        if (parsed.error) {
           sub.onError && sub.onError(parsed.error);
        } else if (parsed.result && parsed.result.type === 'data') {
          sub.onNext && sub.onNext(parsed.result.data);
        } else if (parsed.result && parsed.result.type === 'stopped') {
          sub.onComplete && sub.onComplete();
          this.subscriptions.delete(parsed.id);
        }
      }
      // Handle mutation/query resolutions
      else if (parsed.id !== undefined && this.resolvers.has(parsed.id)) {
        const { resolve, reject } = this.resolvers.get(parsed.id);

        if (parsed.error) {
          reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          this.resolvers.delete(parsed.id);
        } else {
          const resData = parsed.result?.data || parsed.result;
          resolve(resData);
          this.resolvers.delete(parsed.id);
        }
      }
    } catch (e) {
      console.error("[WS] Failed to handle message:", e, data);
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

  subscribe(method, params, onNext, onError, onComplete) {
    const id = this.messageId++;
    this.subscriptions.set(id, { onNext, onError, onComplete });
    return {
      id,
      message: { id, method: 'subscription', params: { path: method, input: params } },
      unsubscribe: () => {
        this.ws.send(JSON.stringify({ id, method: 'subscription.stop' }));
        this.subscriptions.delete(id);
      }
    };
  }

  // Build a mutation message without sending it (used for batching).
  // The resolver is intentionally a no-op: callers that need the mutation result
  // should use subscribeAndMutate, which wires up a real resolver.
  buildMutationMessage(method, params) {
    const id = this.messageId++;
    this.resolvers.set(id, {
      resolve: () => {},
      reject: () => {}
    });
    return { id, method: 'mutation', params: { path: method, input: params } };
  }

  /**
   * Send subscription and mutation together in one batched frame (required by CodeRabbit server).
   * @param {string}   subMethod
   * @param {Object}   subParams
   * @param {string}   mutMethod
   * @param {Object}   mutParams
   * @param {(data: any) => void}   onNext
   * @param {(err: any) => void}    onError
   * @param {() => void}            onComplete
   * @returns {SubscribeAndMutateResult}
   */
  subscribeAndMutate(subMethod, subParams, mutMethod, mutParams, onNext, onError, onComplete) {
    const subId = this.messageId++;
    const mutId = this.messageId++;

    this.subscriptions.set(subId, { onNext, onError, onComplete });

    const promise = new Promise((resolve, reject) => {
      this.resolvers.set(mutId, { resolve, reject });
    });

    const batch = [
      { id: subId, method: 'subscription', params: { path: subMethod, input: subParams } },
      { id: mutId, method: 'mutation', params: { path: mutMethod, input: mutParams } }
    ];

    console.log(`[WS] 📤 Sending batched subscription #${subId} + mutation #${mutId}`);
    this.ws.send(JSON.stringify(batch));

    const unsubscribe = () => {
      this.ws.send(JSON.stringify({ id: subId, method: 'subscription.stop' }));
      this.subscriptions.delete(subId);
    };

    return { promise, unsubscribe };
  }

  async query(method, params = {}) {
    return this.sendRequest(method, params, 'query');
  }

  async mutation(method, params = {}) {
    return this.sendRequest(method, params, 'mutation');
  }

  // Subscriptions
  subscribeToEvents(clientId, onNext, onError, onComplete) {
    const sub = this.subscribe('vsCode.subscribeToEvents', { clientId }, onNext, onError, onComplete);
    console.log(`[WS] 📤 Starting subscription #${sub.id}: vsCode.subscribeToEvents`);
    this.ws.send(JSON.stringify(sub.message));
    return sub;
  }

  // Mutations
  async requestFullReview(payload) {
    return this.mutation('vsCode.requestFullReview', payload);
  }

  // Helper added to discover Organization ID
  async getCurrentOrganization(username, userId, provider = 'github') {
    return this.query('organizations.getCurrentOrganization', {
        user_name: username,
        user_id: userId,
        provider
    });
  }
}

if (typeof module !== 'undefined') {
  module.exports = CodeRabbitClient;
} else {
  globalThis.CodeRabbitClient = CodeRabbitClient;
}
