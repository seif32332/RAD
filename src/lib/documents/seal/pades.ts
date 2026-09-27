// PAdES seal (ETSI EN 319 142-1 baseline B-B) of an issued PDF, as an incremental update: the
// rendered bytes stay untouched and a signature, its invisible field and the updated catalog / page
// are appended. Any later change to the signed ranges breaks the signature in any PDF reader.
//
// Written for the renderer's own output (Typst: classic xref table, no object streams, first page
// without /Annots); anything else fails closed with SealError rather than guessing.
// Signing time comes from the server clock (owner decision 2026-09-27: no external TSA); it is the
// document's issuedAt, also recorded in the hash-chained DocumentEvent log.
import { createHash, createPrivateKey, sign, X509Certificate } from 'crypto';
import { ctx, int, nul, octets, oid, OID, seq, set, tlv } from './der';

export class SealError extends Error {}

export interface SealInput {
  certDer: Buffer;
  privateKeyPem: string;
  signingTime: Date;
  /** Signer shown by readers next to the certificate (the legal company). */
  name: string;
  reason: string;
}

/** Bytes reserved for the CMS signature (RSA-3072 + certificate is about 2.5 KB). */
const CONTENTS_BYTES = 8192;

// ---------------------------------------------------------------------------------------------
// DER reading (only what the seal needs from its own certificate)

interface Tlv { tag: number; start: number; contentStart: number; end: number }

function readTlv(buf: Buffer, at: number): Tlv {
  const tag = buf[at];
  let len = buf[at + 1];
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  return { tag, start: at, contentStart: p, end: p + len };
}

function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = parent.contentStart; p < parent.end;) {
    const t = readTlv(buf, p);
    out.push(t);
    p = t.end;
  }
  return out;
}

/** Issuer Name and serial INTEGER (encoded) of a certificate. */
function issuerAndSerial(certDer: Buffer): { issuer: Buffer; serial: Buffer } {
  const tbs = children(certDer, readTlv(certDer, 0))[0];
  const f = children(certDer, tbs);
  const i = f[0].tag === 0xa0 ? 1 : 0; // [0] version present in v3
  return { serial: certDer.subarray(f[i].start, f[i].end), issuer: certDer.subarray(f[i + 2].start, f[i + 2].end) };
}

// ---------------------------------------------------------------------------------------------
// CMS SignedData, detached, with the attributes PAdES B-B requires (no signing-time attribute:
// the claimed time is the /M entry of the signature dictionary).

export function buildCms(digest: Buffer, certDer: Buffer, privateKeyPem: string): Buffer {
  const { issuer, serial } = issuerAndSerial(certDer);
  const certHash = createHash('sha256').update(certDer).digest();
  const attrs = [
    seq(oid(OID.contentType), set(oid(OID.data))),
    seq(oid(OID.messageDigest), set(octets(digest))),
    // ESSCertIDv2 { certHash, issuerSerial { issuer: GeneralNames [4] directoryName, serial } }; hash = sha256 (DEFAULT, omitted).
    seq(oid(OID.signingCertificateV2), set(seq(seq(seq(octets(certHash), seq(seq(tlv(0xa4, issuer)), serial)))))),
  ].sort(Buffer.compare);
  const attrsContent = Buffer.concat(attrs);
  const signature = sign('sha256', tlv(0x31, attrsContent), createPrivateKey(privateKeyPem));
  const signerInfo = seq(
    int(1),
    seq(issuer, serial),
    seq(oid(OID.sha256)),
    tlv(0xa0, attrsContent), // [0] IMPLICIT signedAttrs
    seq(oid(OID.rsaEncryption), nul()),
    octets(signature),
  );
  return seq(
    oid(OID.signedData),
    ctx(0, seq(
      int(1),
      set(seq(oid(OID.sha256))),
      seq(oid(OID.data)), // detached: no eContent
      tlv(0xa0, certDer), // [0] IMPLICIT certificates
      set(signerInfo),
    )),
  );
}

// ---------------------------------------------------------------------------------------------
// PDF incremental update

/** PDF text string as UTF-16BE hex with BOM (Arabic names), always valid in a dictionary. */
function pdfText(s: string): string {
  const b = Buffer.from(s, 'utf16le');
  for (let i = 0; i < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  return `<FEFF${b.toString('hex').toUpperCase()}>`;
}

/** PDF date D:YYYYMMDDHHmmSS+00'00' (UTC). */
function pdfDate(d: Date): string {
  return `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}+00'00'`;
}

interface XrefInfo { offsets: Map<number, number>; trailer: string; startxref: number }

function readXref(s: string): XrefInfo {
  const sx = s.lastIndexOf('startxref');
  if (sx < 0) throw new SealError('startxref not found');
  const startxref = Number(/startxref\s+(\d+)/.exec(s.slice(sx))?.[1]);
  if (!Number.isFinite(startxref) || !s.startsWith('xref', startxref)) throw new SealError('xref stream or unexpected layout (unsupported)');
  const offsets = new Map<number, number>();
  const tIdx = s.indexOf('trailer', startxref);
  if (tIdx < 0) throw new SealError('trailer not found');
  const lines = s.slice(startxref + 4, tIdx).split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length;) {
    const [first, count] = lines[i].split(/\s+/).map(Number);
    for (let k = 0; k < count; k++) {
      const [off, gen, kind] = lines[i + 1 + k].split(/\s+/);
      if (kind === 'n') {
        if (Number(gen) !== 0) throw new SealError('non-zero generation (unsupported)');
        offsets.set(first + k, Number(off));
      }
    }
    i += 1 + count;
  }
  const trailer = /<<([\s\S]*?)>>\s*startxref/.exec(s.slice(tIdx))?.[1];
  if (!trailer) throw new SealError('trailer dictionary not found');
  if (/\/Prev\b/.test(trailer)) throw new SealError('already updated incrementally (unsupported)');
  return { offsets, trailer, startxref };
}

function objectBody(s: string, x: XrefInfo, num: number): string {
  const off = x.offsets.get(num);
  if (off === undefined) throw new SealError(`object ${num} not in xref`);
  const head = new RegExp(`^${num} 0 obj\\s*`).exec(s.slice(off, off + 32));
  if (!head) throw new SealError(`object ${num} not at its xref offset`);
  const end = s.indexOf('endobj', off);
  const body = s.slice(off + head[0].length, end).trim();
  if (!body.startsWith('<<') || !body.endsWith('>>') || body.includes('stream')) throw new SealError(`object ${num} is not a plain dictionary`);
  return body;
}

const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s*(\\d+)\\s+0\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

/** Adds an entry before the closing >> of a plain dictionary. */
const withEntry = (dict: string, entry: string) => `${dict.slice(0, -2)}${entry}>>`;

/**
 * Seals a PDF. Deterministic for the same input, key and time (RSA PKCS#1 v1.5 has no randomness),
 * so a retry after a crash produces the same bytes.
 */
export function sealPdf(pdf: Buffer, input: SealInput): Buffer {
  // A signing time outside the certificate's validity makes readers call the signer invalid.
  const cert = new X509Certificate(input.certDer);
  if (input.signingTime < new Date(cert.validFrom) || input.signingTime > new Date(cert.validTo)) {
    throw new SealError('signing time outside the seal certificate validity');
  }
  const s = pdf.toString('latin1');
  if (!s.startsWith('%PDF-')) throw new SealError('not a PDF');
  const x = readXref(s);
  const size = Number(/\/Size\s+(\d+)/.exec(x.trailer)?.[1]);
  const root = ref(x.trailer, 'Root');
  if (!size || root === null) throw new SealError('trailer without /Size or /Root');

  const catalog = objectBody(s, x, root);
  if (/\/AcroForm\b/.test(catalog)) throw new SealError('document already has a form (unsupported)');
  const pagesNum = ref(catalog, 'Pages');
  if (pagesNum === null) throw new SealError('catalog without /Pages');
  const firstKid = /\/Kids\s*\[\s*(\d+)\s+0\s+R/.exec(objectBody(s, x, pagesNum))?.[1];
  if (!firstKid) throw new SealError('page tree without kids');
  const pageNum = Number(firstKid);
  const page = objectBody(s, x, pageNum);
  if (!/\/Type\s*\/Page\b/.test(page)) throw new SealError('first kid is not a page (unsupported)');
  if (/\/Annots\b/.test(page)) throw new SealError('first page already has annotations (unsupported)');

  const sigNum = size;
  const widgetNum = size + 1;
  const hexLen = CONTENTS_BYTES * 2;
  const byteRangeSlot = '/ByteRange[0 0000000000 0000000000 0000000000]';
  const objects: Array<[number, string]> = [
    [root, withEntry(catalog, `/AcroForm<</Fields[${widgetNum} 0 R]/SigFlags 3>>`)],
    [pageNum, withEntry(page, `/Annots[${widgetNum} 0 R]`)],
    [sigNum, `<</Type/Sig/Filter/Adobe.PPKLite/SubFilter/ETSI.CAdES.detached${byteRangeSlot}/Contents<${'0'.repeat(hexLen)}>/M(${pdfDate(input.signingTime)})/Name${pdfText(input.name)}/Reason${pdfText(input.reason)}>>`],
    // Invisible field (zero rectangle: no appearance needed, PDF/A-2 6.3.3); Print + Locked.
    [widgetNum, `<</Type/Annot/Subtype/Widget/FT/Sig/T(Seal)/V ${sigNum} 0 R/F 132/Rect[0 0 0 0]/P ${pageNum} 0 R>>`],
  ];

  const base = s.endsWith('\n') ? s : `${s}\n`;
  let body = '';
  const offsets = new Map<number, number>();
  for (const [num, dict] of objects) {
    offsets.set(num, base.length + body.length);
    body += `${num} 0 obj\n${dict}\nendobj\n`;
  }
  const xrefAt = base.length + body.length;
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  let xref = 'xref\n';
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) xref += `${String(offsets.get(nums[k])).padStart(10, '0')} 00000 n\r\n`;
    i = j + 1;
  }
  const keep = ['Info', 'ID'].map((k) => new RegExp(`/${k}\\s*(\\d+\\s+0\\s+R|\\[[^\\]]*\\])`).exec(x.trailer)?.[0] ?? '').join('');
  const trailer = `trailer\n<</Size ${size + 2}/Root ${root} 0 R${keep}/Prev ${x.startxref}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const out = Buffer.from(base + body + xref + trailer, 'latin1');

  // ByteRange: everything except the <hex> of /Contents.
  const text = out.toString('latin1');
  const sigObjAt = offsets.get(sigNum)!;
  const contentsAt = text.indexOf('/Contents<', sigObjAt) + '/Contents'.length;
  const afterContents = contentsAt + hexLen + 2;
  const range = [0, contentsAt, afterContents, out.length - afterContents];
  const rangeText = `/ByteRange[${range.join(' ')}]`.padEnd(byteRangeSlot.length, ' ');
  if (rangeText.length !== byteRangeSlot.length) throw new SealError('byte range does not fit');
  out.write(rangeText, text.indexOf(byteRangeSlot, sigObjAt), 'latin1');

  const digest = createHash('sha256').update(out.subarray(0, contentsAt)).update(out.subarray(afterContents)).digest();
  const cms = buildCms(digest, input.certDer, input.privateKeyPem);
  if (cms.length > CONTENTS_BYTES) throw new SealError('signature larger than its reserved space');
  out.write(cms.toString('hex').toUpperCase().padEnd(hexLen, '0'), contentsAt + 1, 'latin1');
  return out;
}
