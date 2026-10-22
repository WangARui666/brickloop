export type ErrorCode =
  | 'NOT_FOUND'
  | 'CYCLE'
  | 'INVALID_CONTEXT'
  | 'EMPTY_SELECTION'
  | 'INVALID_ARGUMENT'
  | 'INVALID_DOCUMENT'
  | 'TRANSACTION_ACTIVE'
  | 'NO_TRANSACTION'
  | 'READ_ONLY_NEWER';
export interface CommandError {
  code: ErrorCode;
  messageKey: string;
  details?: unknown;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: CommandError };
export class CoreError extends Error {
  readonly error: CommandError;
  constructor(code: ErrorCode, details?: unknown) {
    super(`core.errors.${code}`);
    this.error = { code, messageKey: `core.errors.${code}`, ...(details === undefined ? {} : { details }) };
  }
}
export function fail(code: ErrorCode, details?: unknown): never {
  throw new CoreError(code, details);
}
export function attempt<T>(action: () => T): Result<T> {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    if (error instanceof CoreError) return { ok: false, error: error.error };
    if (error instanceof RangeError || error instanceof TypeError)
      return {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', messageKey: 'core.errors.INVALID_ARGUMENT', details: error.message },
      };
    throw error;
  }
}

/** Default Chinese text for the exported i18n keys; UI adapters may translate them. */
export const coreErrorMessagesZh: Record<`core.errors.${ErrorCode}`, string> = {
  'core.errors.NOT_FOUND': '找不到指定对象',
  'core.errors.CYCLE': '此操作会产生循环引用',
  'core.errors.INVALID_CONTEXT': '编辑上下文已失效或目标不在当前上下文中',
  'core.errors.EMPTY_SELECTION': '请先选择要编辑的对象',
  'core.errors.INVALID_ARGUMENT': '命令参数无效',
  'core.errors.INVALID_DOCUMENT': '文档结构不符合约束',
  'core.errors.TRANSACTION_ACTIVE': '当前事务尚未结束',
  'core.errors.NO_TRANSACTION': '当前没有进行中的事务',
  'core.errors.READ_ONLY_NEWER': '此文档由更新版本创建，请以只读方式打开',
};
