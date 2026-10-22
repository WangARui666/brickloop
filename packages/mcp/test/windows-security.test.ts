import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createMcpHostServer } from '../src/host.js';
import { endpoint, fakeHost } from './helpers.js';

async function createSidResolver() {
  const { default: koffi } = await import('koffi');
  const kernel = koffi.load('kernel32.dll');
  const advapi = koffi.load('advapi32.dll');
  const parse = advapi.func('bool __stdcall ConvertStringSidToSidW(str16 text, _Out_ void ** sid)') as (
    text: string,
    sid: unknown[],
  ) => boolean;
  const format = advapi.func('bool __stdcall ConvertSidToStringSidW(void * sid, _Out_ void ** text)') as (
    sid: unknown,
    text: unknown[],
  ) => boolean;
  const free = kernel.func('void * __stdcall LocalFree(void * pointer)') as (pointer: unknown) => unknown;
  return (trustee: string): string => {
    const sid: unknown[] = [null];
    const text: unknown[] = [null];
    try {
      expect(parse(trustee, sid), `ConvertStringSidToSidW(${trustee})`).toBe(true);
      expect(format(sid[0], text), `ConvertSidToStringSidW(${trustee})`).toBe(true);
      return koffi.decode.string16(text[0]);
    } finally {
      if (text[0]) free(text[0]);
      if (sid[0]) free(sid[0]);
    }
  };
}

function matchesCurrentUserDacl(sddl: string, currentSid: string, resolveSid: (trustee: string) => string): boolean {
  // Keep protection, ACE order/count, flags and rights exact; only trustee spelling may vary.
  const aces = /^D:P\(D;;FA;;;([^;()]+)\)\(A;;FA;;;([^;()]+)\)$/.exec(sddl);
  return aces !== null && resolveSid(aces[1]!) === 'S-1-5-2' && resolveSid(aces[2]!) === resolveSid(currentSid);
}

it.skipIf(process.platform !== 'win32')('matches LA only to the resolved built-in Administrator SID', async () => {
  const resolveSid = await createSidResolver();
  // LA is machine-relative: use this Windows installation's real RID-500 SID, not a fabricated alias mapping.
  const administratorSid = resolveSid('LA');
  expect(administratorSid).toMatch(/^S-1-5-21-(?:\d+-){3}500$/);
  const sddl = 'D:P(D;;FA;;;NU)(A;;FA;;;LA)';
  expect(matchesCurrentUserDacl(sddl, administratorSid, resolveSid)).toBe(true);
  expect(matchesCurrentUserDacl(sddl, administratorSid.replace(/-500$/, '-501'), resolveSid)).toBe(false);
  // Even another domain's RID-500 account is a different trustee.
  const otherDomainSid = administratorSid.replace(
    /^S-1-5-21-(\d+)/,
    (_, part: string) => `S-1-5-21-${part === '0' ? '1' : '0'}`,
  );
  expect(matchesCurrentUserDacl(sddl, otherDomainSid, resolveSid)).toBe(false);
});

it.skipIf(process.platform !== 'win32')('keeps the DACL checks strict for numeric SIDs and aliases', async () => {
  const resolveSid = await createSidResolver();
  // Include accounts outside the S-1-5-21 family, such as LocalSystem and an Entra ID user.
  for (const sid of ['S-1-5-21-1-2-3-1001', 'S-1-5-18', 'S-1-12-1-1-2-3-4']) {
    expect(matchesCurrentUserDacl(`D:P(D;;FA;;;S-1-5-2)(A;;FA;;;${sid})`, sid, resolveSid)).toBe(true);
  }
  expect(matchesCurrentUserDacl('D:P(D;;FA;;;NU)(A;;FA;;;SY)', 'S-1-5-18', resolveSid)).toBe(true);

  const sid = 'S-1-5-21-1-2-3-1001';
  const deny = '(D;;FA;;;NU)';
  const allow = `(A;;FA;;;${sid})`;
  for (const sddl of [
    `D:${deny}${allow}`, // Not protected.
    `D:PAI${deny}${allow}`, // Additional descriptor flags.
    `D:P(D;ID;FA;;;NU)${allow}`, // Inherited ACE.
    `D:P(D;;FR;;;NU)${allow}`, // Deny is not full access.
    `D:P${deny}(A;;FR;;;${sid})`, // Allow is not full access.
    `D:P(D;;FA;;;WD)${allow}`, // Wrong deny trustee.
    `D:P${deny}(A;;FA;;;BA)`, // Wrong allow alias.
    `D:P${deny}(A;;FA;;;S-1-5-21-1-2-3-1002)`, // Wrong allow SID.
    `D:P${allow}${deny}`, // Wrong ACE order.
    `D:P${deny}`, // Missing allow.
    `D:P${allow}`, // Missing deny.
    `D:P${deny}${deny}${allow}`, // Extra deny.
    `D:P${deny}${allow}${allow}`, // Extra allow.
    `D:P${deny}${allow}(A;;FA;;;WD)`, // Additional trustee.
  ]) {
    expect(matchesCurrentUserDacl(sddl, sid, resolveSid), sddl).toBe(false);
  }
});

it.skipIf(process.platform !== 'win32')(
  'creates a protected current-user DACL with an explicit network-logon deny',
  async () => {
    const { default: koffi } = await import('koffi');
    const kernel = koffi.load('kernel32.dll');
    const advapi = koffi.load('advapi32.dll');
    const open = kernel.func(
      'intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void * attributes, uint32_t creation, uint32_t flags, intptr_t templateFile)',
    ) as (
      name: string,
      access: number,
      share: number,
      attributes: null,
      creation: number,
      flags: number,
      template: number,
    ) => number | bigint;
    const close = kernel.func('bool __stdcall CloseHandle(intptr_t handle)') as (handle: number | bigint) => boolean;
    const free = kernel.func('void * __stdcall LocalFree(void * pointer)') as (pointer: unknown) => unknown;
    const security = advapi.func(
      'uint32_t __stdcall GetSecurityInfo(intptr_t handle, int kind, uint32_t flags, void * owner, void * group, void * dacl, void * sacl, _Out_ void ** descriptor)',
    ) as (
      handle: number | bigint,
      kind: number,
      flags: number,
      owner: null,
      group: null,
      dacl: null,
      sacl: null,
      output: unknown[],
    ) => number;
    const sddl = advapi.func(
      'bool __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void * descriptor, uint32_t revision, uint32_t flags, _Out_ void ** text, void * length)',
    ) as (descriptor: unknown, revision: number, flags: number, text: unknown[], length: null) => boolean;
    const server = createMcpHostServer({ host: fakeHost(), pipeName: endpoint(), approve: async () => true });
    await server.start();
    try {
      const handle = open(server.pipeName, 0x00020000, 0, null, 3, 0, 0);
      expect(handle).not.toBe(-1);
      expect(handle).not.toBe(-1n);
      const descriptor: unknown[] = [null];
      const text: unknown[] = [null];
      try {
        expect(security(handle, 6, 4, null, null, null, null, descriptor)).toBe(0);
        expect(sddl(descriptor[0], 1, 4, text, null)).toBe(true);
        const value = koffi.decode.string16(text[0]);
        const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
        const { stdout } = await promisify(execFile)(whoami, ['/user', '/fo', 'csv', '/nh'], {
          windowsHide: true,
        });
        const sid = stdout.match(/"(S-[^"]+)"\s*$/)?.[1];
        expect(sid).toBeDefined();
        // Windows maps generic-all (GA) to file-all (FA) on pipe objects.
        const resolveSid = await createSidResolver();
        expect(matchesCurrentUserDacl(value, sid!, resolveSid), value).toBe(true);
      } finally {
        if (text[0]) free(text[0]);
        if (descriptor[0]) free(descriptor[0]);
        close(handle);
      }
    } finally {
      await server.close();
    }
  },
);
