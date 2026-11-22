import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

if (!fs.existsSync(config.photosRoot)) {
  console.error(`Photos folder not found: ${config.photosRoot}`);
  process.exit(1);
}

// Plain-language checks for the most common NAS permission problem.
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.accessSync(config.dataDir, fs.constants.W_OK);
} catch {
  const uid = process.getuid?.() ?? '?';
  console.error(
    `The app cannot write to its data folder (${config.dataDir}) while running as user id ${uid}.\n` +
      'Fix: see "Folder permissions" in the README (create the data folder from the studio PC, then redeploy).',
  );
  process.exit(1);
}

const { app, store } = createApp(config);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`JM Selects running on port ${config.port}`);
  console.log(`Photos (read-only): ${config.photosRoot}`);
  console.log(`App data: ${config.dataDir}`);
  if (!config.projectsRoot) {
    console.log('RAW project copies: off (no projects folder mounted)');
  } else {
    try {
      fs.accessSync(config.projectsRoot, fs.constants.W_OK);
      console.log(`RAW project copies: ${config.projectsRoot} (${config.projectsLabel})`);
    } catch {
      console.error(
        `RAW project copies: the projects folder is NOT writable by the app (user id ${process.getuid?.() ?? '?'}). ` +
          'See "Folder permissions" in the README.',
      );
    }
  }
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
