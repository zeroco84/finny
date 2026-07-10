import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDirs } from './config.js';
import { openDb } from './db/db.js';
import { seedDefaults } from './services/settings.js';
import { purgeSampleDirectory, seedTeam } from './services/team.js';
import { buildRouter } from './api/routes.js';
import { entraConfigError } from './api/entra.js';
import { startWorkers } from './workers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', buildRouter());

  // Serve the built web app when present (single-process deploy: build
  // apps/web, then run the server — handy for Render).
  const webDist = path.resolve(here, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      // The SPA shell must always revalidate so a cached copy can't pin an old
      // bundle; the hashed assets it references stay cacheable.
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api] unhandled error:', err);
    res.status(500).json({ error: 'Internal error — check the server log' });
  });
  return app;
}

export function boot(): void {
  ensureDataDirs();
  // Refuse to boot half-configured: with AUTH_PROVIDER=entra but no usable
  // app registration, sign-in would dead-end (and dev login must NOT quietly
  // take its place on a public deploy).
  if (config.authProvider === 'entra') {
    const problem = entraConfigError();
    if (problem) {
      throw new Error(`AUTH_PROVIDER=entra but ${problem} — see README "Wiring up Entra ID sign-in"`);
    }
  }
  openDb(config.dbPath);
  seedDefaults();
  seedTeam();
  // Remove any sample people a pre-SSO boot may have seeded (no-op in dev).
  purgeSampleDirectory();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  boot();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[finny] API on http://localhost:${config.port} · data in ${config.dataDir}`);
    console.log(`[finny] providers — mail:${config.mailProvider} extraction:${config.extractionProvider} approvals:${config.approvalsProvider}`);
    startWorkers();
  });
}
