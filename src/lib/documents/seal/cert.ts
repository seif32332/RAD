// Self-issued seal certificate of a legal company (owner decision 2026-09-27: a certificate issued
// by Radeef itself, no external CA). RSA-3072 / SHA-256, X.509 v3, self-signed, end entity only:
// it can sign documents, not other certificates. Recipients who want Acrobat to show the signer as
// trusted import it once (download on the verification page); integrity is checked either way.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'crypto';
import { bits, bool, ctx, int, nul, octets, oid, OID, printable, seq, set, time, tlv, utf8 } from './der';

export interface SealSubject {
  /** Legal name (Arabic), printed as the certificate's common name. */
  nameAr: string;
  nameEn: string | null;
  /** Commercial registration number: organizationIdentifier NTRSA-<number> (ETSI EN 319 412-1). */
  commercialRegNum: string | null;
}

export interface NewSealCertificate {
  certDer: Buffer;
  privateKeyPem: string;
  fingerprint: string; // SHA-256 of the certificate, hex
  serialHex: string;
  notBefore: Date;
  notAfter: Date;
}

const VALIDITY_YEARS = 10;
/**
 * The certificate is valid from 30 days before its creation: a document's signing time is its
 * issuedAt, reserved before the seal (the first issuance of a company creates the key seconds or,
 * after render retries, hours later; a renewal 30 days before expiry likewise). Without this Acrobat
 * reports the signer's identity as "not yet valid" at the signing time.
 */
const BACKDATE_MS = 30 * 86_400_000;

function name(subject: SealSubject): Buffer {
  const rdn = (type: string, value: Buffer) => set(seq(oid(type), value));
  const parts = [rdn(OID.country, printable('SA'))];
  if (subject.nameEn) parts.push(rdn(OID.organization, utf8(subject.nameEn)));
  parts.push(rdn(OID.organizationalUnit, utf8('Radeef document seal')));
  if (subject.commercialRegNum) parts.push(rdn('2.5.4.97', utf8(`NTRSA-${subject.commercialRegNum}`)));
  parts.push(rdn(OID.commonName, utf8(subject.nameAr)));
  return seq(...parts);
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

/** Generates a key pair and its self-signed certificate. `now` is injectable for tests. */
export function createSealCertificate(subject: SealSubject, now = new Date()): NewSealCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // Serial: 16 random bytes, positive and non-zero (RFC 5280 4.1.2.2).
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const created = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const notBefore = new Date(created.getTime() - BACKDATE_MS);
  const notAfter = new Date(created);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  const subjectName = name(subject);
  const sigAlg = seq(oid(OID.sha256WithRSA), nul());
  // SubjectKeyIdentifier: SHA-1 of the public key bits (RFC 5280 4.2.1.2 method 1); SHA-256 would
  // do, but readers expect the classic 20 bytes.
  const skid = createHash('sha1').update(spki).digest();
  const tbs = seq(
    ctx(0, int(2)), // v3
    int(serial),
    sigAlg,
    subjectName, // issuer = subject (self-signed)
    seq(time(notBefore), time(notAfter)),
    subjectName,
    spki,
    ctx(3, seq(
      extension(OID.basicConstraints, true, seq()), // cA FALSE (DEFAULT, omitted)
      // digitalSignature (bit 0) + nonRepudiation / contentCommitment (bit 1): 0b11000000, 6 unused bits.
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x06, 0xc0]))),
      extension(OID.subjectKeyIdentifier, false, octets(skid)),
    )),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, sigAlg, bits(signature));
  return {
    certDer,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: createHash('sha256').update(certDer).digest('hex'),
    serialHex: new X509Certificate(certDer).serialNumber,
    notBefore,
    notAfter,
  };
}

/** Checks that a stored certificate and key belong together (fails closed before any signing). */
export function assertKeyMatchesCertificate(certDer: Buffer, privateKeyPem: string): void {
  const cert = new X509Certificate(certDer);
  const fromKey = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' });
  const fromCert = cert.publicKey.export({ type: 'spki', format: 'der' });
  if (!fromKey.equals(fromCert)) throw new Error('seal key does not match its certificate');
}
