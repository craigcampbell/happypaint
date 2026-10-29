// Isolated design preview. No deployment env, accounts or production writes.
// Optional ARTWALL_PUBLIC_SNAPSHOT is a local read-only copy of public wall art,
// used for visual review only; never a substitute for backend integration tests.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointRendererVersion } from '../server/checkpointVersion.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp(join(process.env.TMPDIR || '/home/craig/.hermes/cache/scratch', 'artwall-preview-'));
const snapshot = process.env.ARTWALL_PUBLIC_SNAPSHOT;
const backend = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', PORT: '9191', HOST: '127.0.0.1', DATA_DIR: join(scratch, 'data'), PB_URL: '', STRIPE_CHECKOUT_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
backend.stdout.on('data', () => {});
backend.stderr.on('data', (data) => process.stderr.write(data));
let ready = false;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch('http://127.0.0.1:9191/healthz')).ok) { ready = true; break; } } catch { /* booting */ }
  await new Promise((done) => setTimeout(done, 100));
}
if (!ready) { backend.kill(); throw new Error('Isolated API did not start'); }
const vite = await createServer({
  configFile: false, root, envDir: scratch, cacheDir: join(scratch, 'vite'),
  plugins: [react(), { name: 'public-art-review-snapshot', configureServer(server) {
    if (!snapshot) return;
    server.middlewares.use(async (req, res, next) => {
      if (req.method !== 'GET') return next();
      const url = new URL(req.url, 'http://localhost');
      const frame = /^\/api\/wall\/(wp_[A-Za-z0-9_-]+)\/frame\/0$/.exec(url.pathname);
      if (url.pathname !== '/api/wall' && !frame) return next();
      try {
        if (frame) { res.setHeader('Content-Type', 'image/png'); res.end(await readFile(join(snapshot, `${frame[1]}.png`))); }
        else {
          const data = JSON.parse(await readFile(join(snapshot, 'wall.json'), 'utf8'));
          const query = (url.searchParams.get('q') || '').toLowerCase();
          data.posts = data.posts.filter((post) => (!url.searchParams.get('event') || post.event === url.searchParams.get('event')) && (!query || `${post.title} ${post.artist} ${(post.tags || []).join(' ')}`.toLowerCase().includes(query)));
          data.total = data.posts.length;
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
        }
      } catch { next(); }
    });
  } }],
  define: { 'import.meta.env.VITE_PB_URL': '""', __CHECKPOINT_RENDERER_VERSION__: JSON.stringify(checkpointRendererVersion()) },
  worker: { format: 'es' }, resolve: { dedupe: ['react', 'react-dom', 'tslib'] },
  server: { host: '127.0.0.1', port: 9190, strictPort: true, proxy: { '/api': 'http://127.0.0.1:9191', '/ws': { target: 'ws://127.0.0.1:9191', ws: true } } },
});
await vite.listen();
console.log(`Art-wall preview ready: http://127.0.0.1:9190 (isolated data ${scratch}; public snapshot: ${Boolean(snapshot)})`);
let closing = false;
async function stop() { if (closing) return; closing = true; await vite.close(); backend.kill('SIGTERM'); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
