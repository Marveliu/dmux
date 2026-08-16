import { describe, expect, it } from 'vitest';
import { resolveMenuClickIndex } from '../src/components/popups/kebabMenuPopup.js';

describe('resolveMenuClickIndex', () => {
  // PopupContainer renders one row of top padding, so with paddingY = 1 the
  // action list occupies popup-interior rows 2..(actionCount + 1).
  it('maps rows within the action list to indices', () => {
    expect(resolveMenuClickIndex(2, 5)).toBe(0);
    expect(resolveMenuClickIndex(4, 5)).toBe(2);
    expect(resolveMenuClickIndex(6, 5)).toBe(4);
  });

  it('returns null for the padding row and rows past the list', () => {
    expect(resolveMenuClickIndex(1, 5)).toBeNull(); // top padding
    expect(resolveMenuClickIndex(7, 5)).toBeNull(); // footer margin
    expect(resolveMenuClickIndex(8, 5)).toBeNull(); // footer
  });
});
