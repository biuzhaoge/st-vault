import { expect, it } from 'vitest';
import { captureRotation } from './rotation.js';

it('prioritizes a request arriving during the sweep and skips pending urgent work', () => {
  const urgent = new Set<string>();
  const rotation = captureRotation(
    ['a', 'b', 'c', 'd'].map((id) => ({ id })),
    2,
    urgent,
    (id) => id === 'd',
  );
  expect(rotation.next()).toEqual({ subject: { id: 'c' }, cursor: 3 });
  urgent.add('d');
  urgent.add('b');
  expect(rotation.next()).toEqual({ subject: { id: 'b' }, cursor: 2 });
  expect(rotation.next()).toEqual({ subject: { id: 'a' }, cursor: 1 });
  expect(rotation.next()).toEqual({ subject: { id: 'd' }, cursor: 0 });
  expect(rotation.next()).toBeNull();
});
