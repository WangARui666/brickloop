import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, validateIpcArguments } from '../src/shared/api';
import type { IpcChannel } from '../src/shared/api';

describe('library IPC boundary', () => {
  it.each<[IpcChannel, unknown[]]>([
    [IPC_CHANNELS.catalogSearch, ['3001', { includeAll: false }]],
    [IPC_CHANNELS.meshGet, ['ld:3001']],
    [IPC_CHANNELS.catalogPart, ['cu:custom-1']],
    [IPC_CHANNELS.thumbGet, ['ld:3001', 'c:bright-red']],
    [IPC_CHANNELS.packsImport, [{ action: 'choose', kind: 'directory' }]],
    [IPC_CHANNELS.packsImport, [{ action: 'commit', token: '12345678-1234-1234-1234-123456789abc', activate: true }]],
    [IPC_CHANNELS.setFavoriteColors, [['c:bright-red']]],
    [IPC_CHANNELS.packsExportTemplate, []],
  ])('accepts %s', (channel, args) => expect(() => validateIpcArguments(channel, args)).not.toThrow());
  it.each<[IpcChannel, unknown[]]>([
    [IPC_CHANNELS.meshGet, ['ld:../../secret']],
    [IPC_CHANNELS.meshGet, ['ld:C:\\secret']],
    [IPC_CHANNELS.meshGet, ['ld:3001', 'extra']],
    [IPC_CHANNELS.catalogSearch, ['', { includeAll: 'true' }]],
    [IPC_CHANNELS.catalogSearch, ['', { includeAll: true, limit: Infinity }]],
    [IPC_CHANNELS.packsActivate, ['../demo']],
    [IPC_CHANNELS.packsRemove, ['CON']],
    [IPC_CHANNELS.packsImport, [{ action: 'commit', token: 'bad' }]],
    [IPC_CHANNELS.packsImport, [{ action: 'choose', kind: 'file', source: 'C:/secret' }]],
    [IPC_CHANNELS.setFavoriteColors, [[null]]],
    [IPC_CHANNELS.thumbPut, ['../x', 'data:image/png;base64,AAAA']],
    [IPC_CHANNELS.thumbPut, ['a'.repeat(64), 'data:text/html;base64,AAAA']],
  ])('rejects malformed %s', (channel, args) => expect(() => validateIpcArguments(channel, args)).toThrow(TypeError));
});
