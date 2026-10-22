import type { ConnectorFile } from '@brickloop/connect';
import type { Collider, ColliderOverride } from '@brickloop/collide';
import { isPartId } from './library-api';

export interface AssemblyPart {
  missing?: string[][];
  connectors: ConnectorFile;
  collider: Collider;
  overrideVersion: number;
}
export interface AnnotationSave {
  connectors: ConnectorFile;
  collider: ColliderOverride;
}
export interface AssemblyApi {
  assemblyCatalog(): Promise<AssemblyCatalog>;
  assemblyPart(partId: string): Promise<AssemblyPart>;
  assemblyInfer(partId: string): Promise<ConnectorFile>;
  assemblySave(value: AnnotationSave): Promise<AssemblyPart>;
  setMaintenanceMode(enabled: boolean): Promise<boolean>;
}
export const ASSEMBLY_CHANNELS = {
  assemblyCatalog: 'assembly.catalog',
  assemblyPart: 'assembly.part',
  assemblyInfer: 'assembly.infer',
  assemblySave: 'assembly.save',
  setMaintenanceMode: 'settings.maintenance',
} as const;
export function validAssemblyArguments(channel: string, args: readonly unknown[]): boolean {
  if (channel === ASSEMBLY_CHANNELS.assemblyCatalog) return args.length === 0;
  if (args.length !== 1) return false;
  const value = args[0];
  switch (channel) {
    case ASSEMBLY_CHANNELS.assemblyPart:
    case ASSEMBLY_CHANNELS.assemblyInfer:
      return isPartId(value);
    case ASSEMBLY_CHANNELS.setMaintenanceMode:
      return typeof value === 'boolean';
    case ASSEMBLY_CHANNELS.assemblySave:
      return typeof value === 'object' && value !== null && 'connectors' in value && 'collider' in value;
    default:
      return false;
  }
}
export interface AssemblyCatalog {
  parts: { id: string; factory: boolean; colors: string[] }[];
  colors: string[];
}
