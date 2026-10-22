export interface AnimationExportApi {
  animationChoose(title: string, format: 'mp4' | 'webm'): Promise<{ id: string; path: string } | null>;
  animationSave(id: string, bytes: Uint8Array): Promise<string>;
  animationCancel(id: string): Promise<void>;
}
export const ANIMATION_CHANNELS = {
  animationChoose: 'animation.choose',
  animationSave: 'animation.save',
  animationCancel: 'animation.cancel',
} as const;
export function validAnimationArguments(channel: string, args: readonly unknown[]) {
  const id = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
  switch (channel) {
    case ANIMATION_CHANNELS.animationChoose:
      return (
        args.length === 2 &&
        typeof args[0] === 'string' &&
        args[0].length <= 1024 &&
        (args[1] === 'mp4' || args[1] === 'webm')
      );
    case ANIMATION_CHANNELS.animationSave:
      return (
        args.length === 2 &&
        id(args[0]) &&
        args[1] instanceof Uint8Array &&
        args[1].byteLength > 0 &&
        args[1].byteLength <= 1024 ** 3
      );
    case ANIMATION_CHANNELS.animationCancel:
      return args.length === 1 && id(args[0]);
  }
  return false;
}
