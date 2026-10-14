import { describe, expect, it } from 'vitest';
import { frameBatcher } from '../src/admin/live.ts';

describe('frameBatcher', () => {
  it('hands items over once per frame, oldest first, and drops them on cancel', () => {
    const frames: (() => void)[] = [];
    const flushed: number[][] = [];
    const batch = frameBatcher<number>(
      (items) => {
        flushed.push([...items]);
      },
      (callback) => frames.push(callback),
      () => {
        frames.length = 0;
      },
    );
    batch.push(1);
    batch.push(2);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(flushed).toEqual([[1, 2]]);
    batch.push(3);
    batch.cancel();
    expect(frames).toHaveLength(0);
    batch.push(4);
    frames.shift()?.();
    expect(flushed).toEqual([[1, 2], [4]]);
  });
});
