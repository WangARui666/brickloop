import { expect, type ElectronApplication, type Page } from '@playwright/test';

export async function setStableContentSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const resize = () =>
    app.evaluate(
      ({ BrowserWindow }, { width, height }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        if (window.isMinimized()) window.restore();
        if (window.isMaximized()) window.unmaximize();
        if (window.isFullScreen()) window.setFullScreen(false);
        if (!window.isVisible()) window.showInactive();
        window.setContentSize(width, height);
      },
      { width, height },
    );
  await resize();
  let resizedAt = performance.now();
  // The 2 px tolerance is only for DPI rounding: 1440×900 becomes 1442×902 at 125%
  // and 1441×901 at 175%/200%. IO-01 stayed at 1426×864 when resizing was not applied;
  // retry the normalized resize at most every 500 ms, within the configured polling timeout.
  await expect
    .poll(
      async () => {
        const [actualWidth, actualHeight] = await page.evaluate(() => [innerWidth, innerHeight] as const);
        const delta = Math.max(Math.abs(actualWidth - width), Math.abs(actualHeight - height));
        if (delta > 2 && performance.now() - resizedAt >= 500) {
          await resize();
          resizedAt = performance.now();
        }
        return delta;
      },
      { intervals: [500] },
    )
    .toBeLessThanOrEqual(2);
}
