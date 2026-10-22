export interface AppDataEnvironment {
  APPDATA?: string | undefined;
  LOCALAPPDATA?: string | undefined;
}

export function createAppDataGuard(
  environment?: AppDataEnvironment,
  platform?: NodeJS.Platform,
): Promise<() => Promise<void>>;
