import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

if (!fs.existsSync(config.photosRoot)) {
  console.error(`Photos folder not found: ${config.photosRoot}`);
  process.exit(1);
}

const { app, store } = createApp(config);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`JM Selects running on port ${config.port}`);
  console.log(`Photos (read-only): ${config.photosRoot}`);
  console.log(`App data: ${config.dataDir}`);
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
