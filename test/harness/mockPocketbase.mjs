/* eslint-env node */
// Tiny stand-in for PocketBase's token-validation endpoint.
//
// The real server validates a sign-in token by POSTing it (RAW Authorization
// header, no "Bearer ") to `${PB_URL}/api/collections/users/auth-refresh` and
// reading `{ record: { id, ... } }` back (see server/pocketbaseAuth.js). This
// mock replays that single contract so the harness can exercise the signed-in
// path with zero real PocketBase, zero secrets, and full determinism.
//
// Token convention used by the harness:
//   - "tok_<id>"       → a valid user whose profileId is <id> (name "Grown-up <id>")
//   - anything else    → 400, i.e. anonymous (mirrors a bad/expired token)
//
// Nothing else in the app talks to PocketBase, so one route is enough.

import { createServer } from 'http';

// Build the user record a token maps to, or null if the token is not a valid
// "tok_<id>" shape. Mirrors what a real PocketBase user record looks like
// closely enough for displayNameFromRecord() in pocketbaseAuth.js.
function recordForToken(token) {
  if (typeof token !== 'string') return null;
  const m = /^tok_([A-Za-z0-9_-]{1,40})$/.exec(token.trim());
  if (!m) return null;
  const id = m[1];
  return {
    id,
    name: `Grown-up ${id}`,
    username: `grownup_${id}`,
    email: `${id}@example.test`,
    verified: true,
  };
}

// Start the mock on an ephemeral port. Resolves with { url, close } where `url`
// is exactly what you set PB_URL to. `close()` returns a promise.
export function startMockPocketbase() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // The only endpoint the server uses for auth.
      if (req.method === 'POST' && req.url === '/api/collections/users/auth-refresh') {
        // PocketBase reads the RAW token from the Authorization header.
        const token = req.headers['authorization'] || '';
        const record = recordForToken(token);
        if (!record) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 400, message: 'Failed to authenticate.' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token: `refreshed_${record.id}`, record }));
        return;
      }
      // Any other route is unknown to the mock.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
