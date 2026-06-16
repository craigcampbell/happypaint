import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // @supabase/supabase-js (via @supabase/functions-js) imports `tslib`. It is
  // installed as a direct dependency so Rolldown can resolve it; deduping keeps
  // a single copy and guards against hoisting quirks that previously left the
  // transitive `tslib` import unresolved at build time.
  resolve: {
    dedupe: ['tslib'],
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
  },
})
