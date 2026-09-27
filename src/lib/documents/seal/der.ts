// Minimal DER encoder for the document seal (X.509 certificate + CMS SignedData). Only the types the
// seal needs; no parser. Node's crypto signs and verifies but cannot build certificates or CMS.

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

/** TLV with a raw tag byte. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

export const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
/** SET OF: DER sorts the encoded elements. */
export const setOf = (...items: Buffer[]) => tlv(0x31, Buffer.concat([...items].sort(Buffer.compare)));
export const nul = () => Buffer.from([0x05, 0x00]);
export const octets = (b: Buffer) => tlv(0x04, b);
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printable = (s: string) => tlv(0x13, Buffer.from(s, 'ascii'));
export const bool = (v: boolean) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
/** BIT STRING with no unused bits. */
export const bits = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
/** Context tag, constructed ([n] EXPLICIT, or [n] IMPLICIT of a constructed type). */
export const ctx = (n: number, content: Buffer) => tlv(0xa0 | n, content);

/** INTEGER from a non-negative number or big-endian bytes (a leading 0 is added when the high bit is set). */
export function int(v: number | Buffer): Buffer {
  let b: Buffer;
  if (typeof v === 'number') {
    const out: number[] = [];
    let n = v;
    do { out.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
    b = Buffer.from(out);
  } else {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    b = v.subarray(i);
  }
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime until 2049, GeneralizedTime from 2050 (RFC 5280 4.1.2.5). Seconds precision, Z. */
export function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const year = d.getUTCFullYear();
  return year < 2050 ? tlv(0x17, Buffer.from(iso.slice(2) + 'Z', 'ascii')) : tlv(0x18, Buffer.from(iso + 'Z', 'ascii'));
}

export const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  commonName: '2.5.4.3',
  country: '2.5.4.6',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectKeyIdentifier: '2.5.29.14',
} as const;
