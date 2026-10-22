/** The host must encrypt values and atomically replace each value (e.g. Electron safeStorage). */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export class CredentialError extends Error {
  constructor(readonly code: string) {
    super(`Credential operation failed (${code}).`);
    this.name = 'CredentialError';
  }
}
/** No underlying exception: native encryption errors can contain sensitive data. */
export class SecretUnreadableError extends CredentialError {
  constructor() {
    super('SECRET_UNREADABLE');
    this.name = 'SecretUnreadableError';
  }
}
export function isSecretReadError(error: unknown): boolean {
  return (
    error instanceof SecretUnreadableError ||
    (error instanceof Error && ['SECURE_STORAGE_UNAVAILABLE', 'SECURE_STORAGE_FAILED'].includes(error.message))
  );
}
export function maskSecret(secret: string): string {
  return secret.length > 4 ? `****${secret.slice(-4)}` : '****';
}
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join(maskSecret(secret));
  }
  return result
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:id_token_hint|access_token|refresh_token|code|code_verifier)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, (value) => maskSecret(value))
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-token]');
}
export class ApiKeyStore {
  constructor(private readonly store: SecretStore) {}
  get(provider: string): Promise<string | undefined> {
    return this.store.get(`ai:key:${provider}`);
  }
  set(provider: string, key: string): Promise<void> {
    return this.store.set(`ai:key:${provider}`, key);
  }
  delete(provider: string): Promise<void> {
    return this.store.delete(`ai:key:${provider}`);
  }
  async display(provider: string): Promise<string | undefined> {
    const key = await this.get(provider);
    return key === undefined ? undefined : maskSecret(key);
  }
}
