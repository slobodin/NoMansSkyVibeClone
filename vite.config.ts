import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-server endpoint that saves screenshots sent by the game (see src/dev/DevTools.ts).
 *
 * POST /__screenshot  { name: string, dataUrl: "data:image/jpeg;base64,...", history?: boolean }
 *
 *  - history: true  -> docs/progress/NNN-name.jpg (the curated progress history, committed to git)
 *  - otherwise      -> screenshots/name-<timestamp>.jpg (ad-hoc F2 screenshots, git-ignored)
 *
 * Only active in `vite dev`; production builds have no such endpoint.
 */
function screenshotEndpoint(): Plugin {
  return {
    name: 'nms-screenshot-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__screenshot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', () => {
          try {
            const { name, dataUrl, history } = JSON.parse(body) as {
              name: string;
              dataUrl: string;
              history?: boolean;
            };
            const safeName = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60);
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            const root = server.config.root;

            let file: string;
            if (history) {
              const dir = path.join(root, 'docs', 'progress');
              fs.mkdirSync(dir, { recursive: true });
              // Next running number = highest existing "NNN-" prefix + 1.
              const numbers = fs
                .readdirSync(dir)
                .map((f) => /^(\d{3})-/.exec(f)?.[1])
                .filter((n): n is string => n !== undefined)
                .map(Number);
              const next = String(Math.max(0, ...numbers) + 1).padStart(3, '0');
              file = path.join(dir, `${next}-${safeName}.jpg`);
            } else {
              const dir = path.join(root, 'screenshots');
              fs.mkdirSync(dir, { recursive: true });
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              file = path.join(dir, `${safeName}-${stamp}.jpg`);
            }

            fs.writeFileSync(file, Buffer.from(base64, 'base64'));
            const relative = path.relative(root, file).replace(/\\/g, '/');
            server.config.logger.info(`screenshot saved: ${relative}`);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ file: relative }));
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [screenshotEndpoint()],
  server: { port: 5173 },
});
