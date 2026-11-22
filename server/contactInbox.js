import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOPICS = new Set(['general', 'bug', 'billing', 'safety', 'privacy']);
const REQUEST_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const DAY = 86_400_000;
const RETENTION = 90 * DAY;
const CAPACITY = 500;

export function createContactInbox(dataDir, now = Date.now) {
  const file = join(dataDir, '.contact-inbox.json');
  const temp = file + '.tmp';
  // Interrupted writes were never acknowledged. Do not retain a second copy
  // of the sender's message after a process restart.
  try { unlinkSync(temp); } catch (error) {
    if (error.code !== 'ENOENT') console.error('[contact-inbox] Could not clean temporary file');
  }
  let messages = null;
  let timer;

  // Commit to disk before acknowledging a submission. A full or unreadable
  // inbox must never turn into silent success or overwrite pending messages.
  function save(next) {
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, messages: next }), { mode: 0o600, flush: true });
      renameSync(temp, file);
    } finally {
      try { unlinkSync(temp); } catch { /* The rename removed it. */ }
    }
    messages = next;
    scheduleExpiry();
  }

  function current() {
    if (!messages) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.messages) || data.messages.length > CAPACITY || !data.messages.every(m =>
          m && typeof m.id === 'string' && Number.isSafeInteger(m.createdAt) && TOPICS.has(m.topic) &&
          typeof m.message === 'string' && typeof m.email === 'string' && ['open', 'resolved'].includes(m.status)
        )) throw new Error('Invalid contact inbox');
        messages = data.messages;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        messages = [];
      }
    }
    const cutoff = now() - RETENTION;
    if (messages.some(m => m.createdAt <= cutoff)) save(messages.filter(m => m.createdAt > cutoff));
    return messages;
  }

  function scheduleExpiry() {
    clearTimeout(timer);
    if (messages?.length === 0) return;
    const next = messages ? Math.min(...messages.map(m => m.createdAt)) + RETENTION - now() : DAY;
    timer = setTimeout(sweep, Math.min(DAY, Math.max(1, next)));
    timer.unref();
  }

  function sweep() {
    try {
      current();
      scheduleExpiry();
    } catch {
      console.error('[contact-inbox] Storage unavailable');
      clearTimeout(timer);
      timer = setTimeout(sweep, 60_000);
      timer.unref();
    }
  }
  sweep();

  function scrubEmail(address) {
    if (!address) return;
    const key = address.toLowerCase();
    const rows = current();
    const keep = rows.filter(m => m.email.toLowerCase() !== key);
    if (keep.length !== rows.length) save(keep);
  }

  function openCount() {
    if (!messages) return null;
    const cutoff = now() - RETENTION;
    return messages.filter(m => m.status === 'open' && m.createdAt > cutoff).length;
  }

  function registerRoutes(app, { adminGuard, clientIp, rateOk }) {
    const paths = ['/api/contact', '/api/admin/contact'];
    const json = express.json({ limit: '16kb' });
    app.use(paths, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.use('/api/admin/contact', (req, res, next) => { if (adminGuard(req, res)) next(); });

    app.post('/api/contact', (req, res, next) => {
      if (!rateOk('contact-attempt:' + clientIp(req), 30, 10 * 60_000)) return res.status(429).json({ error: 'rate_limited' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
      next();
    }, json, (req, res) => {
      const { topic, message, email = '', website, requestId = '' } = req.body || {};
      if (website) return res.status(201).json({ ok: true });
      if (!TOPICS.has(topic)) return res.status(400).json({ error: 'invalid_topic' });
      const clean = typeof message === 'string' ? message.trim() : '';
      if (clean.length < 10 || clean.length > 2000) return res.status(400).json({ error: 'invalid_message' });
      if (typeof email !== 'string') return res.status(400).json({ error: 'invalid_email' });
      const reply = email.trim();
      if (reply && (reply.length > 254 || !EMAIL.test(reply))) return res.status(400).json({ error: 'invalid_email' });
      if (typeof requestId !== 'string' || (requestId && !REQUEST_ID.test(requestId))) return res.status(400).json({ error: 'invalid_request_id' });

      const rows = current();
      const previous = requestId && rows.find(m => m.requestId === requestId);
      if (previous) {
        if (previous.topic !== topic || previous.message !== clean || previous.email !== reply) return res.status(409).json({ error: 'request_conflict' });
      } else {
        if (!rateOk('contact-submit:' + clientIp(req), 5, 10 * 60_000)) return res.status(429).json({ error: 'rate_limited' });
        if (rows.length >= CAPACITY) return res.status(503).json({ error: 'inbox_unavailable' });
        save([{ id: randomUUID(), requestId, topic, message: clean, email: reply, createdAt: now(), status: 'open' }, ...rows]);
      }
      return res.status(201).json({ ok: true });
    });

    app.get('/api/admin/contact', (_req, res) => {
      const entries = current().map(({ id, topic, message, email, createdAt, status }) => ({ id, topic, message, email, createdAt, status }));
      res.json({ messages: entries });
    });
    app.patch('/api/admin/contact/:id', json, (req, res) => {
      const status = req.body?.status;
      if (status !== 'open' && status !== 'resolved') return res.status(400).json({ error: 'invalid_status' });
      const rows = current();
      const entry = rows.find(m => m.id === req.params.id);
      if (!entry) return res.status(404).json({ error: 'not_found' });
      if (entry.status !== status) save(rows.map(m => m === entry ? { ...m, status } : m));
      return res.json({ ok: true });
    });
    app.delete('/api/admin/contact/:id', (req, res) => {
      const rows = current();
      const keep = rows.filter(m => m.id !== req.params.id);
      if (rows.length === keep.length) return res.status(404).json({ error: 'not_found' });
      save(keep);
      return res.json({ ok: true });
    });
    app.use(paths, (error, _req, res, next) => {
      if (res.headersSent) return next(error);
      if (error.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
      if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: 'invalid_request' });
      return res.status(503).json({ error: 'inbox_unavailable' });
    });
  }
  return { registerRoutes, openCount, scrubEmail };
}
