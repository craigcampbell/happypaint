import express from 'express';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CURATOR_PAGES, getCuratorDefaults, validateCuratorContent } from '../src/data/curatorContent.js';

const pageKeys = Object.keys(CURATOR_PAGES);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function defaults() {
  return { revision: 0, pages: Object.fromEntries(pageKeys.map((page) => [page, {
    draft: getCuratorDefaults(page), published: getCuratorDefaults(page), updatedAt: null, publishedAt: null,
  }])) };
}
function validStore(stored) {
  if (!exactKeys(stored, ['revision', 'pages']) || !Number.isSafeInteger(stored.revision) || stored.revision < 0 || !exactKeys(stored.pages, pageKeys)) return false;
  return pageKeys.every((page) => {
    const entry = stored.pages[page];
    return exactKeys(entry, ['draft', 'published', 'updatedAt', 'publishedAt']) &&
      validateCuratorContent(page, entry.draft).ok && validateCuratorContent(page, entry.published).ok &&
      [entry.updatedAt, entry.publishedAt].every((time) => time === null || (typeof time === 'string' && Number.isFinite(Date.parse(time))));
  });
}

export function createCurator({ dataDir }) {
  const file = join(dataDir, '.curator.json');
  let document = defaults();
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (!validStore(stored)) throw new Error('Invalid Curator store');
    document = stored;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[curator] Invalid store; using safe defaults');
  }
  const published = () => ({ revision: document.revision, pages: Object.fromEntries(pageKeys.map((page) => [page, { ...document.pages[page].published }])) });
  // Synchronous bounded writes serialize revision checks. Replace on disk before
  // touching memory, so failed persistence never acknowledges a phantom edit.
  function persist(next) {
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* renamed or creation failed */ }
    }
    document = next;
  }
  function registerRoutes(app, adminGuard) {
    app.use(['/api/curator', '/api/admin/curator'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.get('/api/curator/pages', (_req, res) => res.json(published()));
    app.use('/api/admin/curator', (req, res, next) => { if (adminGuard(req, res)) next(); });
    app.get('/api/admin/curator', (_req, res) => res.json(document));
    app.use('/api/admin/curator', (req, res, next) => {
      if (['PUT', 'POST'].includes(req.method) && !req.is('application/json')) return res.status(400).json({ error: 'json_required' });
      next();
    }, express.json({ limit: '8kb' }));
    function mutate(action) {
      return (req, res) => {
        const page = req.params.page;
        if (!Object.hasOwn(CURATOR_PAGES, page)) return res.status(400).json({ error: 'invalid_page' });
        if (!exactKeys(req.body, action === 'draft' ? ['revision', 'content'] : ['revision']) || !Number.isSafeInteger(req.body.revision) || req.body.revision < 0) return res.status(400).json({ error: 'invalid_request' });
        const validated = action === 'draft' ? validateCuratorContent(page, req.body.content) : null;
        if (validated && !validated.ok) return res.status(400).json({ error: validated.error });
        if (req.body.revision !== document.revision) return res.status(409).json({ error: 'revision_conflict', revision: document.revision });
        if (document.revision === Number.MAX_SAFE_INTEGER) return res.status(503).json({ error: 'revision_exhausted' });
        const now = new Date().toISOString();
        const entry = { ...document.pages[page] };
        if (action === 'draft') { entry.draft = validated.content; entry.updatedAt = now; }
        else if (action === 'publish') { entry.published = { ...entry.draft }; entry.publishedAt = now; }
        else { entry.draft = getCuratorDefaults(page); entry.published = getCuratorDefaults(page); entry.updatedAt = now; entry.publishedAt = now; }
        const next = { revision: document.revision + 1, pages: { ...document.pages, [page]: entry } };
        try { persist(next); } catch { console.error('[curator] Persistence failed; edit not applied'); return res.status(503).json({ error: 'persistence_failed' }); }
        return res.json(document);
      };
    }
    app.put('/api/admin/curator/pages/:page', mutate('draft'));
    app.post('/api/admin/curator/pages/:page/publish', mutate('publish'));
    app.post('/api/admin/curator/pages/:page/reset', mutate('reset'));
    app.use('/api/admin/curator', (error, _req, res, next) => {
      if (error.type === 'entity.too.large') return res.status(413).json({ error: 'body_too_large' });
      if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
      next(error);
    });
  }
  return { published, registerRoutes };
}
