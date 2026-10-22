import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../src/shared/content-security-policy';

describe('renderer and Worker CSP', () => {
  it.each([false, true])('allows WASM but forbids host eval (development=%s)', (development) => {
    const policy = contentSecurityPolicy(development);
    const script = policy.split(';').find((part) => part.trim().startsWith('script-src'))!;
    expect(script).toContain("'wasm-unsafe-eval'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script.includes("'unsafe-inline'")).toBe(development);
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("connect-src 'self' blob: data:");
    expect(policy.includes('ws://127.0.0.1:*')).toBe(development);
  });
});
