/// <reference types="vite/client" />
import type { DesktopApi } from '../../shared/api';

declare global {
  interface Window {
    brickloop: DesktopApi;
    brickloopMeshRequest(request: string, id: string): void;
  }
}
