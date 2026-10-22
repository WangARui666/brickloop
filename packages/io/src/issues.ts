export interface IoIssue {
  code: string;
  messageKey: string;
  severity: 'error' | 'warning' | 'info';
  file?: string;
  detail?: string;
}

export const ioMessagesZh = {
  ZIP_INVALID: 'ZIP 文件损坏或格式不受支持',
  ZIP_MEMBER_INVALID: 'ZIP 成员损坏',
  IO_ENCRYPTED_UNSUPPORTED: '不支持的加密格式',
  PROJECT_MANIFEST_INVALID: '工程清单无效',
  PROJECT_MEMBER_MISSING: '工程成员缺失',
  PROJECT_HASH_MISMATCH: '工程成员大小或 SHA-256 不匹配',
  PROJECT_UNLISTED_MEMBER: '工程中存在未登记的成员，已保留',
  PROJECT_JSON_INVALID: 'JSON 成员无效',
  PROJECT_DOCUMENT_INVALID: '工程文档无效',
  PROJECT_WORKSPACE_RESET: '工作区无效，已使用默认值',
  PROJECT_MIGRATED: '工程格式已迁移',
  PROJECT_VERSION_UNSUPPORTED: '没有适用于此工程版本的迁移',
  PROJECT_NEWER_VERSION: '工程由更新版本创建，只读打开',
  IO_MODEL_MISSING: '没有可读取的模型',
  IO_MODEL_INVALID: '模型无效',
  IO_MODEL_FALLBACK: '主模型读取失败，已尝试兼容模型',
  IO_PARSE_WARNING: '模型行无法完整解析',
  IO_PART_UNMAPPED: '零件未在当前目录中匹配，已建立动态定义',
  IO_COLOR_UNMAPPED: '颜色无乐高映射，已保留 LDraw 色号',
  IO_COLOR_FALLBACK: '颜色已降级为最接近的 LDraw 颜色',
  IO_PART_GEOMETRY_MISSING: '自制件几何缺失',
  IO_GROUPS_AS_COMMENTS: '编组已保存为注释，Studio 中不保留编组操作',
  IO_PRIVATE_DATA_OMITTED: '本软件专有信息不写入交换格式，请用工程文件完整保存',
  IO_STUDIO_DATA_OMITTED: 'Studio 专有数据未导入',
  IO_REFERENCE_IMAGE: '参考图已导入，位置配置作为扩展数据保留',
  IO_HIDDEN_DOWNGRADE: '共享子模型中不同出现的隐藏状态无法独立表达',
  IO_UID_REASSIGNED: '重复或无效的 Studio UID 已重新分配',
  RECOVERY_INVALID_SESSION: '恢复会话信息损坏',
  RECOVERY_NO_SNAPSHOT: '没有有效恢复快照',
  RECOVERY_INVALID_SNAPSHOT: '恢复快照损坏，已尝试较早快照',
  RECOVERY_JOURNAL_INVALID: '事务日志损坏，已停止重放',
  RECOVERY_REVISION_GAP: '事务日志不连续，已停止重放',
  RECOVERY_ASSET_MISSING: '事务资源缺失或损坏，已停止重放',
  SAVE_PERMISSION: '没有写入权限',
  SAVE_NO_SPACE: '磁盘空间不足',
  SAVE_BUSY: '文件被占用',
  SAVE_VALIDATION: '写入后的工程校验失败',
  SAVE_IO: '文件写入失败',
  SAVE_DURABILITY: '文件已替换，但后续刷盘失败',
} as const;
export type IoCode = keyof typeof ioMessagesZh;
export function issue(code: IoCode, file?: string, detail?: string, severity: IoIssue['severity'] = 'error'): IoIssue {
  return {
    code,
    messageKey: `io.${code}`,
    severity,
    ...(file === undefined ? {} : { file }),
    ...(detail === undefined ? {} : { detail }),
  };
}
export interface IoReport {
  counts: {
    parts: number;
    models: number;
    submodels: number;
    instances: number;
    steps: number;
    mappedParts: number;
    unmappedParts: number;
    mappedColors: number;
    unmappedColors: number;
  };
  degradations: IoIssue[];
  omitted: IoIssue[];
  warnings: IoIssue[];
  errors: IoIssue[];
}
export function createReport(): IoReport {
  return {
    counts: {
      parts: 0,
      models: 0,
      submodels: 0,
      instances: 0,
      steps: 0,
      mappedParts: 0,
      unmappedParts: 0,
      mappedColors: 0,
      unmappedColors: 0,
    },
    degradations: [],
    omitted: [],
    warnings: [],
    errors: [],
  };
}
