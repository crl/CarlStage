import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'block-local-runs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathname = '';
        try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname).toLowerCase(); }
        catch { res.statusCode = 400; res.end('Bad request'); return; }
        if (pathname.split('/').includes('.local-runs')) { res.statusCode = 403; res.end('Forbidden'); return; }
        next();
      });
    }
  }],
  server: { port: Number(process.env.REELBENCH_VITE_PORT || 5173), strictPort: true, fs: { deny: ['**/.local-runs/**'] }, proxy: { '/api': `http://127.0.0.1:${process.env.REELBENCH_PORT || '8787'}` } }
});
