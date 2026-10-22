import { Duplex } from 'node:stream';
import koffi from 'koffi';
import type { LocalListener } from './local-transport.js';

// Node's net.listen cannot supply a pipe DACL or PIPE_REJECT_REMOTE_CLIENTS.
// Use byte-mode, nonblocking Win32 I/O so no native call blocks the JS thread.
type Handle = number | bigint;
const kernel = koffi.load('kernel32.dll');
const advapi = koffi.load('advapi32.dll');
const lastError = kernel.func('uint32_t __stdcall GetLastError()') as () => number;
const closeHandle = kernel.func('bool __stdcall CloseHandle(intptr_t handle)') as (handle: Handle) => boolean;
const localFree = kernel.func('void * __stdcall LocalFree(void * memory)') as (pointer: unknown) => unknown;
const getProcess = kernel.func('intptr_t __stdcall GetCurrentProcess()') as () => Handle;
const openToken = advapi.func(
  'bool __stdcall OpenProcessToken(intptr_t process, uint32_t access, _Out_ intptr_t * token)',
) as (process: Handle, access: number, token: Handle[]) => boolean;
const tokenInfo = advapi.func(
  'bool __stdcall GetTokenInformation(intptr_t token, int kind, _Out_ void * data, uint32_t size, _Out_ uint32_t * needed)',
) as (token: Handle, kind: number, data: Buffer | null, size: number, needed: number[]) => boolean;
const sidString = advapi.func('bool __stdcall ConvertSidToStringSidW(void * sid, _Out_ void ** text)') as (
  sid: unknown,
  text: unknown[],
) => boolean;
const descriptor = advapi.func(
  'bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 sddl, uint32_t revision, _Out_ void ** descriptor, void * size)',
) as (sddl: string, revision: number, output: unknown[], size: null) => boolean;
const attributesType = koffi.struct({ length: 'uint32_t', descriptor: 'void *', inherit: 'int32_t' });
const createPipe = kernel.func('__stdcall', 'CreateNamedPipeW', 'intptr_t', [
  'str16',
  'uint32_t',
  'uint32_t',
  'uint32_t',
  'uint32_t',
  'uint32_t',
  'uint32_t',
  koffi.pointer(attributesType),
]) as (
  name: string,
  access: number,
  mode: number,
  instances: number,
  outSize: number,
  inSize: number,
  timeout: number,
  attributes: { length: number; descriptor: unknown; inherit: number },
) => Handle;
const connectPipe = kernel.func('bool __stdcall ConnectNamedPipe(intptr_t pipe, void * overlapped)') as (
  handle: Handle,
  overlapped: null,
) => boolean;
const readFile = kernel.func(
  'bool __stdcall ReadFile(intptr_t handle, _Out_ void * buffer, uint32_t size, _Out_ uint32_t * count, void * overlapped)',
) as (handle: Handle, buffer: Buffer, size: number, count: number[], overlapped: null) => boolean;
const writeFile = kernel.func(
  'bool __stdcall WriteFile(intptr_t handle, void * buffer, uint32_t size, _Out_ uint32_t * count, void * overlapped)',
) as (handle: Handle, buffer: Buffer, size: number, count: number[], overlapped: null) => boolean;

function nativeError(operation: string): Error {
  return new Error(`${operation} failed (Windows error ${lastError()}).`);
}
function currentSid(): string {
  const tokens: Handle[] = [0];
  if (!openToken(getProcess(), 0x0008, tokens)) throw nativeError('OpenProcessToken');
  const token = tokens[0]!;
  try {
    const needed = [0];
    tokenInfo(token, 1, null, 0, needed);
    const data = Buffer.alloc(needed[0]!);
    if (!tokenInfo(token, 1, data, data.length, needed)) throw nativeError('GetTokenInformation');
    const sid: unknown = koffi.decode(data, 'void *');
    const text: unknown[] = [null];
    if (!sidString(sid, text)) throw nativeError('ConvertSidToStringSid');
    try {
      return koffi.decode.string16(text[0]);
    } finally {
      localFree(text[0]);
    }
  } finally {
    closeHandle(token);
  }
}

class WindowsPipeStream extends Duplex {
  private reading = true;
  private readTimer: NodeJS.Timeout;
  private writeTimer: NodeJS.Timeout | undefined;
  constructor(private readonly handle: Handle) {
    super();
    this.readTimer = setInterval(() => this.poll(), 5);
  }
  override _read(): void {
    this.reading = true;
  }
  private poll(): void {
    for (let i = 0; i < 16 && this.reading && !this.destroyed; i++) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const count = [0];
      if (!readFile(this.handle, buffer, buffer.length, count, null)) {
        const code = lastError();
        if (code !== 232) this.destroy(); // ERROR_NO_DATA means an empty nonblocking pipe.
        return;
      }
      if (!count[0]) return;
      this.reading = this.push(buffer.subarray(0, count[0]));
    }
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let offset = 0;
    const write = () => {
      if (this.destroyed) {
        callback(new Error('Pipe closed.'));
        return;
      }
      const count = [0];
      const remaining = chunk.subarray(offset);
      if (!writeFile(this.handle, remaining, remaining.length, count, null)) {
        callback(nativeError('WriteFile'));
        return;
      }
      offset += count[0]!;
      if (offset === chunk.length) {
        this.writeTimer = undefined;
        callback();
      } else this.writeTimer = setTimeout(write, 5);
    };
    write();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearInterval(this.readTimer);
    clearTimeout(this.writeTimer);
    closeHandle(this.handle);
    callback(error);
  }
}

export function listenWindowsPipe(name: string, accept: (stream: Duplex) => void): LocalListener {
  const sd: unknown[] = [null];
  // Protected DACL: only this token's user SID. Explicitly deny network logons too.
  if (!descriptor(`D:P(D;;GA;;;NU)(A;;GA;;;${currentSid()})`, 1, sd, null)) {
    throw nativeError('Create pipe security descriptor');
  }
  const attributes = { length: koffi.sizeof(attributesType), descriptor: sd[0], inherit: 0 };
  const create = (first: boolean) => {
    const handle = createPipe(
      name,
      0x00000003 | (first ? 0x00080000 : 0),
      0x00000001 | 0x00000008,
      255,
      65536,
      65536,
      0,
      attributes,
    );
    if (handle === -1 || handle === -1n) throw nativeError('CreateNamedPipe');
    return handle;
  };
  let pending: Handle | undefined;
  try {
    pending = create(true);
  } catch (error) {
    localFree(sd[0]);
    throw error;
  }
  const streams = new Set<Duplex>();
  let closed = false;
  const timer = setInterval(() => {
    if (pending === undefined) return;
    const connected = connectPipe(pending, null);
    const code = connected ? 0 : lastError();
    if (!connected && code !== 535) {
      if (code === 536) return; // ERROR_PIPE_LISTENING
      closeHandle(pending);
      pending = undefined;
      try {
        pending = create(false);
      } catch {
        close();
      }
      return;
    }
    const stream = new WindowsPipeStream(pending);
    pending = undefined; // Ownership moves to the Duplex; never close the same handle twice.
    streams.add(stream);
    stream.once('close', () => streams.delete(stream));
    try {
      pending = create(false);
    } catch {
      stream.destroy();
      close();
      return;
    }
    accept(stream);
  }, 5);
  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (pending !== undefined) closeHandle(pending);
    pending = undefined;
    for (const stream of streams) stream.destroy();
    localFree(sd[0]);
  }
  return { close: async () => close() };
}
