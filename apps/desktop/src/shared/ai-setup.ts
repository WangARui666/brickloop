import type { ModelInfo } from '@brickloop/ai';

export type ConnectionError = 'auth' | 'balance' | 'address' | 'quota' | 'network' | 'capability' | 'unknown';
export interface ConnectionResult {
  models: ModelInfo[];
  model: string;
  elapsedMs: number;
  error?: string;
  issue?: ConnectionError;
  status?: number;
  details?: string;
  needsModel?: boolean;
  capabilities?: { vision: boolean; tools: boolean; known: boolean };
}
