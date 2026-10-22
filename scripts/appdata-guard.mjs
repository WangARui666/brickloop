import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

async function snapshot(directory) {
  let root;
  try {
    root = await lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const entries = [];
  const contents = [];
  async function visit(relative, stats, depth) {
    entries.push({ name: relative, mtimeMs: stats.mtimeMs, size: stats.size });
    if (!stats.isDirectory() || depth === 2) return;
    const names = (await readdir(path.join(directory, relative))).sort();
    if (depth === 0) contents.push(...names);
    for (const name of names) {
      const child = path.join(relative, name);
      await visit(child, await lstat(path.join(directory, child)), depth + 1);
    }
  }
  await visit('.', root, 0);
  return { fingerprint: JSON.stringify(entries), contents };
}

// A-91: read and report only. Never create, move or remove anything in AppData.
export async function createAppDataGuard(environment = process.env, platform = process.platform) {
  const watched = [];
  if (platform === 'win32') {
    for (const root of [environment.APPDATA, environment.LOCALAPPDATA]) {
      if (!root || !path.isAbsolute(root)) continue;
      for (const name of ['@brickloop', 'Brickloop']) {
        const directory = path.join(root, name);
        watched.push({ directory, name, before: await snapshot(directory) });
      }
    }
  }
  return async () => {
    const failures = [];
    const listings = [];
    for (const { directory, name, before } of watched) {
      const after = await snapshot(directory);
      listings.push(`${directory}\n  第一层内容：${after ? after.contents.join(', ') || '（空）' : '（不存在）'}`);
      if (name === '@brickloop' && after) {
        failures.push(`${directory}：存在 @brickloop（无论运行前是否已存在）。`);
      } else if (name === 'Brickloop' && !before && after) {
        failures.push(`${directory}：运行后新出现 Brickloop。`);
      } else if (name === 'Brickloop' && before && before.fingerprint !== after?.fingerprint) {
        failures.push(`${directory}：已有 Brickloop 的指纹发生变化；同时运行的已安装 Brickloop 也可能导致这一项。`);
      }
    }
    if (failures.length) {
      throw new Error(
        [
          'A-91 AppData 守卫失败：',
          ...failures,
          ...listings,
          '可能原因：某次启动在主进程设置 userData 之前失败，或某处启动没有使用 launchElectron。',
          '请确认这些目录的用途后手动删除；守卫只检查和报告，不会删除、移动或新建目录。',
        ].join('\n'),
      );
    }
  };
}
