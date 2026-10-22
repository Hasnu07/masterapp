import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { ensureFirstAdmin, pruneSessions } from './auth/index.js';
import { createServer } from './web/server.js';
import { startScheduler } from './import/jobs.js';

async function main() {
  await migrate();
  await ensureFirstAdmin();
  await pruneSessions();
  setInterval(() => pruneSessions().catch(() => {}), 6 * 3600_000).unref();

  const app = createServer();
  app.listen(config.port, config.host, () => {
    console.log(`[web] masterapp on :${config.port} — photos stored on ${config.r2.configured ? 'R2' : `disk (${config.dataDir})`}`);
  });

  startScheduler();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
