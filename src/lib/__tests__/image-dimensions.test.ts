import { describe, expect, it } from 'vitest';
import { readImageSize } from '@/lib/image-dimensions';

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const dqt = [0xff, 0xdb, ...be16(4), 0, 0];
  const frame = [0xff, sof, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...dqt, ...frame, 0xff, 0xd9]);
}

function png(width: number, height: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), ...be32(10).reverse(), 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

describe('readImageSize', () => {
  it('reads baseline and progressive JPEG frames (after other segments)', () => {
    expect(readImageSize(jpeg(640, 853))).toEqual({ width: 640, height: 853 });
    expect(readImageSize(jpeg(480, 640, 0xc2))).toEqual({ width: 480, height: 640 });
  });

  it('reads PNG and WebP headers', () => {
    expect(readImageSize(png(720, 960))).toEqual({ width: 720, height: 960 });
    expect(readImageSize(webpVp8x(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it('exposes a decompression bomb: tiny file, huge declared size', () => {
    const bomb = png(30000, 30000);
    expect(bomb.byteLength).toBeLessThan(100);
    expect(readImageSize(bomb)).toEqual({ width: 30000, height: 30000 });
  });

  it('returns null for anything it cannot read', () => {
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(readImageSize(new Uint8Array(ascii('GIF89a')))).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
  });
});
