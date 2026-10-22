import { createAppDataGuard } from '../../../scripts/appdata-guard.mjs';

export default async function globalSetup(): Promise<() => Promise<void>> {
  return createAppDataGuard();
}
