import { Color } from 'three/webgpu';

/** Mix in linear light, then attenuate. HSL lightness desaturation lifts dark RGB channels
 * under the editor's bright lighting and ACES tone mapping, washing yellow toward cream. */
export function dimContextColor(color: Color): Color {
  const luminance = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  return color.lerp(new Color().setScalar(luminance), 0.2).multiplyScalar(0.24);
}
