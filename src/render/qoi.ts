/**
 * QOI（Quite OK Image）编码器 —— 纯 TS 实现，无依赖。
 * ------------------------------------------------------------------
 * 自带 FFmpeg 运行时按 uniplayer 源码锁构建（--disable-autodetect，
 * 无 zlib → 无 PNG 解码）。QOI 是 ffmpeg 内建编解码器（本运行时已验证），
 * 无损、支持 8-bit alpha，用作文字覆盖层（canvas → QOI → ffmpeg overlay）
 * 的传输格式，替代 PNG。
 * 规范：https://qoiformat.org/ —— header + RGBA chunk 流 + 8 字节结束标记。
 */

const QOI_OP_INDEX = 0x00; // 00..63
const QOI_OP_DIFF = 0x40; // 64..127
const QOI_OP_LUMA = 0x80; // 128..191
const QOI_OP_RUN = 0xc0; // 192..253
const QOI_OP_RGB = 0xfe;
const QOI_OP_RGBA = 0xff;

const MAX_RUN = 62;
const INDEX_SIZE = 64;

export interface QoiImage {
  width: number;
  height: number;
  /** RGBA 交错像素，长度 = width * height * 4。 */
  pixels: Uint8Array;
}

class ByteWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initial: number) {
    this.buffer = new Uint8Array(initial);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  byte(value: number): void {
    this.ensure(1);
    this.buffer[this.length++] = value & 0xff;
  }

  bytes(values: number[]): void {
    this.ensure(values.length);
    for (const value of values) this.buffer[this.length++] = value & 0xff;
  }

  u32(value: number): void {
    this.bytes([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }

  finish(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

/** RGBA 像素编码为 QOI（channels=4，colorspace=0 sRGB + 线性 alpha）。 */
export function encodeQoi(image: QoiImage): Uint8Array {
  const { width, height, pixels } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new Error('invalid qoi dimensions');
  }
  if (pixels.length !== width * height * 4) {
    throw new Error('qoi pixel buffer size mismatch');
  }
  const writer = new ByteWriter(width * height * 4 + 1024);
  writer.bytes([0x71, 0x6f, 0x69, 0x66]); // "qoif"
  writer.u32(width);
  writer.u32(height);
  writer.byte(4); // channels RGBA
  writer.byte(0); // colorspace sRGB

  const index = new Uint8Array(INDEX_SIZE * 4);
  let run = 0;
  let prevR = 0;
  let prevG = 0;
  let prevB = 0;
  let prevA = 255;

  const flushRun = (): void => {
    if (run > 0) {
      writer.byte(QOI_OP_RUN | (run - 1));
      run = 0;
    }
  };

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    const a = pixels[offset + 3];

    if (r === prevR && g === prevG && b === prevB && a === prevA) {
      run += 1;
      if (run === MAX_RUN) {
        flushRun();
      }
      continue;
    }
    flushRun();

    const indexSlot =
      ((r * 3 + g * 5 + b * 7 + a * 11) % INDEX_SIZE) * 4;
    if (
      index[indexSlot] === r &&
      index[indexSlot + 1] === g &&
      index[indexSlot + 2] === b &&
      index[indexSlot + 3] === a
    ) {
      writer.byte(QOI_OP_INDEX | (indexSlot / 4));
    } else if (a === prevA) {
      const diffR = (r - prevR + 2) & 0xff;
      const diffG = (g - prevG + 2) & 0xff;
      const diffB = (b - prevB + 2) & 0xff;
      if (diffR < 4 && diffG < 4 && diffB < 4) {
        writer.byte(QOI_OP_DIFF | (diffR << 4) | (diffG << 2) | diffB);
      } else {
        // LUMA：dg ∈ [-32,31]，(dr-dg)、(db-dg) ∈ [-8,7]
        const dg = g - prevG;
        const dr = r - prevR;
        const db = b - prevB;
        const lumaG = dg + 32;
        const lumaRG = dr - dg + 8;
        const lumaBG = db - dg + 8;
        if (lumaG >= 0 && lumaG < 64 && lumaRG >= 0 && lumaRG < 16 && lumaBG >= 0 && lumaBG < 16) {
          writer.byte(QOI_OP_LUMA | lumaG);
          writer.byte((lumaRG << 4) | lumaBG);
        } else {
          writer.byte(QOI_OP_RGB);
          writer.bytes([r, g, b]);
        }
      }
    } else {
      writer.byte(QOI_OP_RGBA);
      writer.bytes([r, g, b, a]);
    }

    index[indexSlot] = r;
    index[indexSlot + 1] = g;
    index[indexSlot + 2] = b;
    index[indexSlot + 3] = a;
    prevR = r;
    prevG = g;
    prevB = b;
    prevA = a;
  }
  flushRun();
  writer.bytes([0, 0, 0, 0, 0, 0, 0, 1]);
  return writer.finish();
}

/** 极简 QOI 解码（仅单测 roundtrip 用；不做恶意输入防护，生产不解码）。 */
export function decodeQoi(bytes: Uint8Array): QoiImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x71 || bytes[1] !== 0x6f || bytes[2] !== 0x69 || bytes[3] !== 0x66) {
    throw new Error('not a qoi file');
  }
  const width = view.getUint32(4);
  const height = view.getUint32(8);
  const pixels = new Uint8Array(width * height * 4);
  const index = new Uint8Array(INDEX_SIZE * 4);
  let position = 14;
  let run = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (run > 0) {
      run -= 1;
    } else {
      const op = bytes[position++];
      if (op === QOI_OP_RGB) {
        r = bytes[position++];
        g = bytes[position++];
        b = bytes[position++];
      } else if (op === QOI_OP_RGBA) {
        r = bytes[position++];
        g = bytes[position++];
        b = bytes[position++];
        a = bytes[position++];
      } else if ((op & 0xc0) === QOI_OP_INDEX) {
        const slot = (op & 0x3f) * 4;
        r = index[slot];
        g = index[slot + 1];
        b = index[slot + 2];
        a = index[slot + 3];
      } else if ((op & 0xc0) === QOI_OP_DIFF) {
        r = (r + ((op >> 4) & 0x03) - 2) & 0xff;
        g = (g + ((op >> 2) & 0x03) - 2) & 0xff;
        b = (b + (op & 0x03) - 2) & 0xff;
      } else if ((op & 0xc0) === QOI_OP_LUMA) {
        const lumaG = (op & 0x3f) - 32;
        const second = bytes[position++];
        const lumaRG = (second >> 4) - 8;
        const lumaBG = (second & 0x0f) - 8;
        r = (r + lumaG + lumaRG) & 0xff;
        g = (g + lumaG) & 0xff;
        b = (b + lumaG + lumaBG) & 0xff;
      } else if ((op & 0xc0) === QOI_OP_RUN) {
        run = op & 0x3f;
      }
      const slot = ((r * 3 + g * 5 + b * 7 + a * 11) % INDEX_SIZE) * 4;
      index[slot] = r;
      index[slot + 1] = g;
      index[slot + 2] = b;
      index[slot + 3] = a;
    }
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = a;
  }
  return { width, height, pixels };
}
