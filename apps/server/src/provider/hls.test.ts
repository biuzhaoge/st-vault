import { expect, it, vi } from 'vitest';
import { parseMaster } from './hls.js';

it('preserves first-seen metadata pairs and rejects a variant without a URI', () => {
  const lines = [
    '#EXTM3U',
    ...['1:a', '2:a', '1:a', '1:b'].map((pair) => `#EXT-X-MOUFLON:PSCH:info:${pair}`),
    '#EXT-X-STREAM-INF:BANDWIDTH=1',
  ];
  expect(() => parseMaster(lines.join('\n'), 'https://example.test/')).toThrow('invalid-playlist');
  const parsed = parseMaster([...lines, 'v.m3u8'].join('\n'), 'https://example.test/');
  expect(parsed.keys).toEqual([
    { name: 'a', psch: '1' },
    { name: 'a', psch: '2' },
    { name: 'b', psch: '1' },
  ]);
});

it('resolves ordered variants across blank lines and comments without copying every remaining line', () => {
  const base = 'https://example.test/live/';
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 64; index++) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${index}`, '', '# comment', `${index}.m3u8`);
  }
  const text = lines.join('\n');
  const slices = vi.spyOn(Array.prototype, 'slice');
  let copies = 0;
  try {
    const { variants } = parseMaster(text, base);
    expect(variants.map(({ bandwidth, url }) => [bandwidth, url])).toEqual(
      Array.from({ length: 64 }, (_, index) => [index + 1, `${base}${index + 1}.m3u8`]),
    );
    for (const [index, input] of slices.mock.contexts.entries()) {
      if (Array.isArray(input) && input[0] === '#EXTM3U') {
        const [start = 0, end = input.length] = slices.mock.calls[index];
        copies += Math.max(0, end - start);
      }
    }
  } finally {
    slices.mockRestore();
  }
  expect(copies).toBeLessThanOrEqual(lines.length);
});
