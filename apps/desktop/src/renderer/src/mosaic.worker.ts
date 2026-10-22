import { generateMosaic } from '@brickloop/mosaic';
import type { MosaicOptions, RgbaImage } from '@brickloop/mosaic';
self.onmessage = (event: MessageEvent<{ image: RgbaImage; options: MosaicOptions }>) => {
  try {
    self.postMessage({ result: generateMosaic(event.data.image, event.data.options) });
  } catch {
    self.postMessage({ error: 'mosaicUi.failed' });
  }
};
