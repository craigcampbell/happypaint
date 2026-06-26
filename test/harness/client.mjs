/* eslint-env node */
// A thin WebSocket client simulator for the harness.
//
// It wraps the existing `ws` dependency with the few affordances the scenarios
// need: connect to a room (optionally signed-in via a token), send ops/messages,
// buffer every server->client message, and `await` a predicate over that buffer
// with a timeout. Deliberately tiny — no app logic, just transport + a mailbox.

import { WebSocket } from 'ws';

export class SimClient {
  // baseUrl: e.g. "ws://127.0.0.1:PORT" — the harness appends the /ws path.
  // opts: { room, token, name }
  constructor(baseUrl, opts = {}) {
    this.baseUrl = baseUrl;
    this.room = opts.room || 'MAIN';
    this.token = opts.token || null;
    this.label = opts.name || 'client';
    this.messages = []; // every parsed server->client message, in order
    this.ws = null;
    this._waiters = []; // { test, resolve, reject, timer }
    this.closed = false;
    this.closeInfo = null; // { code, reason } once the socket closes
  }

  // Open the socket and resolve once the server's first 'connected' frame
  // arrives (so callers know identity is assigned). Rejects on early close.
  connect({ timeoutMs = 4000 } = {}) {
    const params = new URLSearchParams();
    params.set('room', this.room);
    if (this.token) params.set('token', this.token);
    const url = `${this.baseUrl}/ws?${params.toString()}`;
    this.ws = new WebSocket(url);

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.messages.push(msg);
      if (msg.type === 'connected') {
        this.connected = msg;
      }
      this._drainWaiters();
    });
    this.ws.on('close', (code, reasonBuf) => {
      this.closed = true;
      this.closeInfo = { code, reason: reasonBuf ? reasonBuf.toString() : '' };
      // Wake any waiters so they can settle (a predicate may already be met, or
      // they should reject because the socket died).
      this._drainWaiters();
    });
    this.ws.on('error', () => { /* close handler reports the outcome */ });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.label}: connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.ws.once('open', () => {
        // Resolve on the 'connected' frame, or immediately if it already landed.
        if (this.connected) {
          clearTimeout(timer);
          resolve(this.connected);
          return;
        }
        this.waitFor((m) => m.type === 'connected', { timeoutMs })
          .then((m) => { clearTimeout(timer); resolve(m); })
          .catch((e) => { clearTimeout(timer); reject(e); });
      });
      this.ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: socket error before open: ${err.message}`));
      });
    });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.label}: cannot send, socket not open`);
    }
    this.ws.send(JSON.stringify(obj));
  }

  // Convenience senders mirroring the WS protocol.
  sendOp(op) { this.send({ type: 'op', op }); }
  sendChat(message) { this.send({ type: 'chat', message }); }
  flag(payload) { this.send({ type: 'flag', ...payload }); }
  modHide(opIds) { this.send({ type: 'mod_hide', opIds }); }
  modRestore(opIds) { this.send({ type: 'mod_restore', opIds }); }
  modRemove(opIds) { this.send({ type: 'mod_remove', opIds }); }
  watcherAck(capable) { this.send({ type: 'watcher_ack', capable }); }

  // Resolve with the first buffered message matching `test`, scanning already
  // received messages first, then live arrivals, up to a timeout. Rejects with a
  // clear reason on timeout so a missing server feature fails loudly.
  //
  // Each message is shown to a waiter's predicate AT MOST ONCE. This matters
  // because some scenarios use a side-effecting predicate (e.g. pushing each
  // matching 'op' into an array and returning true once N are collected); if the
  // same buffered message were re-tested on every later arrival it would be
  // double-counted. We track a per-waiter scan cursor into `messages` so old
  // messages are never re-evaluated.
  waitFor(test, { timeoutMs = 3000, label = '' } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: null, cursor: 0 };
      // Scan anything already buffered first (advancing the cursor as we go).
      if (this._scanWaiter(waiter)) return;
      waiter.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        reject(new Error(
          `${this.label}: timed out after ${timeoutMs}ms waiting for ${label || 'a matching message'}`
            + (this.closed ? ` (socket closed: code ${this.closeInfo?.code})` : ''),
        ));
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  // Feed a waiter only the messages it has not seen yet. Returns true (and
  // settles the waiter) if its predicate matches one of them.
  _scanWaiter(waiter) {
    while (waiter.cursor < this.messages.length) {
      const msg = this.messages[waiter.cursor];
      waiter.cursor += 1;
      if (waiter.test(msg)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return true;
      }
    }
    return false;
  }

  _drainWaiters() {
    if (!this._waiters.length) return;
    const still = [];
    for (const w of this._waiters) {
      if (!this._scanWaiter(w)) still.push(w);
    }
    this._waiters = still;
  }

  // All buffered messages of a given type, in order.
  all(type) {
    return this.messages.filter((m) => m.type === type);
  }

  // The most recent message of a given type, or undefined.
  last(type) {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].type === type) return this.messages[i];
    }
    return undefined;
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.closed) { resolve(); return; }
      this.ws.once('close', () => resolve());
      try { this.ws.close(); } catch { resolve(); }
      // Safety net in case 'close' never fires.
      setTimeout(resolve, 1000);
    });
  }
}
