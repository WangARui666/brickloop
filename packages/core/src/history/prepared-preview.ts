import type { BrkDocument } from '../document';
import type { Op } from '../ops';

/** Internal hand-off from adapters that already applied and validated a candidate.
 * Consumed synchronously by preview; never retained with committed history. */
export const preparedPreviews = new WeakMap<Op[], { base: BrkDocument; next: BrkDocument }>();
