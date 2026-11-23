/** QOI 编码器单测：header/roundtrip/引用预测。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeQoi, encodeQoi } from './qoi.ts';

function rgba(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = a;
    }
  }
  return pixels;
}

test('header: qoif + 尺寸 + 通道/色域', () => {
  const bytes = encodeQoi({ width: 3, height: 2, pixels: rgba(3, 2, () => [255, 0, 0, 255]) });
  assert.equal(bytes[0], 0x71);
  assert.equal(bytes[1], 0x6f);
  assert.equal(bytes[2], 0x69);
  assert.equal(bytes[3], 0x66);
  // u32 大端：width=3 → bytes[4..8]=[0,0,0,3]；height=2 → bytes[8..12]=[0,0,0,2]
  assert.equal(bytes[7], 3);
  assert.equal(bytes[11], 2);
  assert.equal(bytes[12], 4);
  assert.equal(bytes[13], 0);
  assert.deepEqual(bytes.subarray(-8), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
});

test('roundtrip：纯色 run、渐变 luma/diff、透明度变化混合', () => {
  const cases = [
    { width: 8, height: 8, pixels: rgba(8, 8, () => [10, 20, 30, 255]) },
    {
      width: 16,
      height: 16,
      pixels: rgba(16, 16, (x) => [x * 16, 255 - x * 16, 128, 255]),
    },
    {
      width: 8,
      height: 4,
      pixels: rgba(8, 4, (x, y) => (x % 2 === 0 && y === 0 ? [0, 0, 0, 0] : [x * 30 % 256, y * 60, 7, y === 0 ? 0 : 255])),
    },
    {
      width: 70,
      height: 1,
      // 64 色以上触发 index 复用与 2 值循环
      pixels: rgba(70, 1, (x) => [(x * 37) % 256, (x * 91) % 256, (x * 53) % 256, x % 2 === 0 ? 255 : 128]),
    },
  ];
  for (const image of cases) {
    const bytes = encodeQoi(image);
    const decoded = decodeQoi(bytes);
    assert.equal(decoded.width, image.width);
    assert.equal(decoded.height, image.height);
    assert.deepEqual(decoded.pixels, image.pixels);
  }
});

test('run 上限 62 正确分段', () => {
  // 130 个相同像素 → 62 + 62 + 6 三段 run
  const image = { width: 130, height: 1, pixels: rgba(130, 1, () => [9, 9, 9, 255]) };
  const bytes = encodeQoi(image);
  const decoded = decodeQoi(bytes);
  assert.equal(decoded.pixels.length, 130 * 4);
  // RGB 全为 9，alpha 保持 255
  assert.ok(decoded.pixels.every((value, offset) => (offset % 4 === 3 ? value === 255 : value === 9)));
});

test('尺寸校验拒绝非法输入', () => {
  assert.throws(() => encodeQoi({ width: 0, height: 1, pixels: new Uint8Array(4) }));
  assert.throws(() => encodeQoi({ width: 2, height: 2, pixels: new Uint8Array(4) }));
});
