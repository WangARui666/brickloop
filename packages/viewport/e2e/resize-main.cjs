const { app, BrowserWindow } = require('electron');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

// launchElectron also supplies --user-data-dir before Electron loads this entry point.
const root = process.env.BRICKLOOP_DATA_DIR;
for (const name of ['userData', 'sessionData', 'crashDumps', 'logs']) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
app.setAppLogsPath(path.join(root, 'logs'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { backgroundThrottling: false },
  });
  await window.loadFile(process.env.BRICKLOOP_VIEWPORT_FIXTURE);
});
app.on('window-all-closed', () => app.quit());
/* global process */
