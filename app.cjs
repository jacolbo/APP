// Entry point for cPanel's "Setup Node.js App" (and anything else built on
// Phusion Passenger), which starts an app by require()-ing a single file.
//
// package.json declares "type": "module", so server.js is an ES module, and
// require()-ing an ES module only works on Node 22.12 and newer. Loading it
// through dynamic import() instead works on every Node from 12 up, which
// matters because shared hosts are often several versions behind.
//
// Running the app normally does not need this file: `npm start` runs
// server.js directly.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

import(pathToFileURL(path.join(__dirname, 'server.js')).href).catch((err) => {
  console.error('Failed to start Pose Board:', err);
  process.exit(1);
});
