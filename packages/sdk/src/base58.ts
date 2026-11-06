// Things Cloud identifiers: Base58 (Bitcoin alphabet) of a 16-byte UUID, one leading "1" per leading zero byte.
// Things.app decodes every identifier in the sync log; a non-canonical one crashes it on every sync and cannot be
// removed. Every identifier is therefore validated before it is written.
import { InvalidIdentifierError } from "./errors.ts";
import { sha1 } from "./sha1.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Encodes 16 bytes as canonical Base58. */
export function encodeUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new InvalidIdentifierError("uuid must be 16 bytes");
  let zeros = 0;
  while (zeros < 16 && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)]! + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}

/** Decodes a canonical Base58 identifier. Throws unless it is exactly 16 bytes. */
export function decodeUuid(s: string): Uint8Array {
  if (!s) throw new InvalidIdentifierError("empty identifier");
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (let i = zeros; i < s.length; i++) {
    const idx = ALPHABET.indexOf(s[i]!);
    if (idx < 0) throw new InvalidIdentifierError(`invalid Base58 character in identifier ${JSON.stringify(s)}`);
    n = n * 58n + BigInt(idx);
  }
  const value: number[] = [];
  while (n > 0n) { value.unshift(Number(n & 0xffn)); n >>= 8n; }
  if (zeros + value.length !== 16) {
    throw new InvalidIdentifierError(`identifier ${JSON.stringify(s)} decodes to ${zeros + value.length} bytes, want 16 (non-canonical or wrong length)`);
  }
  const out = new Uint8Array(16);
  out.set(value, zeros);
  return out;
}

/** Throws unless `s` is a canonical identifier that is safe to write. */
export function validateId(s: string): void { decodeUuid(s); }

export function isValidId(s: string): boolean {
  try { decodeUuid(s); return true; } catch { return false; }
}

/** A new random (version 4) identifier in the wire format. */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return encodeUuid(b);
}

const RECURRENCE_ID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(-[0-9]{8})$/;
const enc = new TextEncoder();

/**
 * Derives the current identifier for an object created before Things Cloud's identifier migration:
 * `Base58(SHA1(legacyId)[:16])`. Recurring-instance ids (`<uuid>-YYYYMMDD`) hash in two steps: the uuid text first,
 * then its raw 16-byte digest followed by the `-YYYYMMDD` text. Hashing is byte-exact (no case folding).
 * The empty string is returned unchanged.
 */
export function encodeLegacyIdentifier(legacyId: string): string {
  if (legacyId === "") return "";
  let input = enc.encode(legacyId);
  const m = RECURRENCE_ID.exec(legacyId);
  if (m) {
    const prefix = sha1(enc.encode(m[1]!)).subarray(0, 16);
    const suffix = enc.encode(m[2]!);
    input = new Uint8Array(16 + suffix.length);
    input.set(prefix, 0);
    input.set(suffix, 16);
  }
  return encodeUuid(sha1(input).subarray(0, 16));
}
