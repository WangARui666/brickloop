import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createMcpHostServer } from '../src/host.js';
import { endpoint, fakeHost } from './helpers.js';

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
        const sid = stdout.match(/S-1-5-21-[\d-]+/)?.[0];
        expect(sid).toBeDefined();
        // Windows maps generic-all (GA) to file-all (FA) on pipe objects.
        expect(value).toBe(`D:P(D;;FA;;;NU)(A;;FA;;;${sid})`);
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
