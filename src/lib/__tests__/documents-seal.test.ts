// PAdES seal (src/lib/documents/seal): the self-issued certificate, the incremental update and the
// CMS signature. The signature is checked independently with OpenSSL when it is installed (it is on
// the CI runners and in Git for Windows).
import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'crypto';
import { execFileSync } from 'child_process';
import { createSealCertificate, assertKeyMatchesCertificate } from '../documents/seal/cert';
import { SealError, sealPdf } from '../documents/seal/pades';
import { byteRange, hasOpenssl, minimalPdf, opensslVerify } from './seal-fixtures';

const cert = createSealCertificate({ nameAr: 'شركة الاختبار للمقاولات', nameEn: 'Test Contracting Co.', commercialRegNum: '1010999999' }, new Date('2026-09-01T00:00:00Z'));
const input = { certDer: cert.certDer, privateKeyPem: cert.privateKeyPem, signingTime: new Date('2026-09-27T09:30:00Z'), name: 'شركة الاختبار', reason: 'مستند رسمي رقم ACM-SAL-2026-000001' };

describe('seal certificate', () => {
  it('is a self-signed X.509 v3 end-entity certificate of the legal company, valid from 30 days before its creation to 10 years after', () => {
    const x = new X509Certificate(cert.certDer);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.subject).toContain('CN=شركة الاختبار للمقاولات');
    expect(x.subject).toContain('O=Test Contracting Co.');
    expect(x.subject).toContain('organizationIdentifier=NTRSA-1010999999');
    expect(x.issuer).toBe(x.subject);
    expect(x.ca).toBe(false);
    expect(x.keyUsage ?? []).toEqual([]); // Node lists only extended key usages; none is set on purpose
    expect(new Date(x.validFrom).toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect(new Date(x.validTo).toISOString()).toBe('2036-09-01T00:00:00.000Z');
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(cert.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries critical key usage digitalSignature + nonRepudiation and cA false', () => {
    const text = hasOpenssl ? execFileSync('openssl', ['x509', '-inform', 'DER', '-noout', '-text'], { input: cert.certDer }).toString() : '';
    if (!hasOpenssl) return;
    expect(text).toMatch(/Key Usage: critical\s+Digital Signature, Non Repudiation/);
    expect(text).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
  });

  it('detects a key that does not belong to the certificate', () => {
    const other = createSealCertificate({ nameAr: 'أخرى', nameEn: null, commercialRegNum: null });
    expect(() => assertKeyMatchesCertificate(cert.certDer, cert.privateKeyPem)).not.toThrow();
    expect(() => assertKeyMatchesCertificate(cert.certDer, other.privateKeyPem)).toThrow(/does not match/);
  });
});

describe('sealPdf', () => {
  const original = minimalPdf();
  const sealed = sealPdf(original, input);
  const text = sealed.toString('latin1');

  it('appends an incremental update and leaves the rendered bytes untouched', () => {
    expect(sealed.subarray(0, original.length).equals(original)).toBe(true);
    expect(text).toContain('/Prev ');
    expect(text).toMatch(/\/Size 8\/Root 2 0 R\/Info 5 0 R\/ID\[\(abc\)\(def\)\]\/Prev \d+>>/);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('adds a PAdES baseline signature: ETSI.CAdES.detached, invisible locked field, server time', () => {
    expect(text).toContain('/Type/Sig/Filter/Adobe.PPKLite/SubFilter/ETSI.CAdES.detached');
    expect(text).toContain("/M(D:20260927093000+00'00')");
    expect(text).toContain('/AcroForm<</Fields[7 0 R]/SigFlags 3>>');
    expect(text).toContain('/Annots[7 0 R]');
    expect(text).toContain('/Subtype/Widget/FT/Sig/T(Seal)/V 6 0 R/F 132/Rect[0 0 0 0]/P 3 0 R');
  });

  it('signs every byte except the signature itself', () => {
    const [a, b, c, d] = byteRange(sealed);
    expect(a).toBe(0);
    expect(sealed[b]).toBe(0x3c); // '<'
    expect(sealed[c - 1]).toBe(0x3e); // '>'
    expect(c + d).toBe(sealed.length);
  });

  it('is deterministic for the same input, key and time (a retry gives the same file)', () => {
    expect(sealPdf(original, input).equals(sealed)).toBe(true);
  });

  it.runIf(hasOpenssl)('verifies with OpenSSL, and any change to the signed bytes breaks it', () => {
    expect(opensslVerify(sealed, cert.certDer)).toBe(true);
    const tampered = Buffer.from(sealed);
    const at = tampered.indexOf('BT ET');
    tampered[at] = 0x43; // 'B' -> 'C' in the page content
    expect(opensslVerify(tampered, cert.certDer)).toBe(false);
    const other = createSealCertificate({ nameAr: 'جهة أخرى', nameEn: null, commercialRegNum: null });
    expect(opensslVerify(sealed, other.certDer)).toBe(false);
  });

  it('refuses a signing time outside the certificate validity (readers would call the signer invalid)', () => {
    // Issued (issuedAt reserved) just before the key existed: still inside the backdated validity.
    expect(() => sealPdf(minimalPdf(), { ...input, signingTime: new Date('2026-08-31T23:59:00Z') })).not.toThrow();
    expect(() => sealPdf(minimalPdf(), { ...input, signingTime: new Date('2026-08-01T00:00:00Z') })).toThrow(SealError);
    expect(() => sealPdf(minimalPdf(), { ...input, signingTime: new Date('2036-09-02T00:00:00Z') })).toThrow(SealError);
  });

  it('fails closed on layouts it does not handle', () => {
    expect(() => sealPdf(sealed, input)).toThrow(SealError); // already updated incrementally
    expect(() => sealPdf(Buffer.from('not a pdf'), input)).toThrow(SealError);
    const withForm = Buffer.from(minimalPdf().toString('latin1').replace('/Lang(ar)>>', '/Lang(ar)/AcroForm<<>>>>'), 'latin1');
    expect(() => sealPdf(withForm, input)).toThrow(SealError);
    const xrefStream = Buffer.from(minimalPdf().toString('latin1').replace(/startxref\n\d+/, 'startxref\n9'), 'latin1');
    expect(() => sealPdf(xrefStream, input)).toThrow(SealError);
  });
});
