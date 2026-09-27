// Width / height from the header of a JPEG, PNG or WebP file, without decoding it.
//
// Used to refuse "decompression bombs" (a small file that declares a huge image) before a selfie
// reaches the face service, which would otherwise allocate gigabytes to decode it.

export interface ImageSize {
  width: number;
  height: number;
}

function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}

function pngSize(b: Uint8Array): ImageSize | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, k) => b[k] !== v)) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
  const u32 = (o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  return { width: u32(16), height: u32(20) };
}

function webpSize(b: Uint8Array): ImageSize | null {
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 30 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
  const chunk = tag(12);
  if (chunk === 'VP8 ') return { width: ((b[27] << 8) | b[26]) & 0x3fff, height: ((b[29] << 8) | b[28]) & 0x3fff };
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

/** Declared size of a JPEG / PNG / WebP image; null when the header cannot be read. */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  return jpegSize(bytes) ?? pngSize(bytes) ?? webpSize(bytes);
}
