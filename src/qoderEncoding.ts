/**
 * Qoder custom Base64 encoding/decoding.
 * Applies two layers of obfuscation on top of standard Base64:
 * 1. Three-segment rearrangement (tail + middle + head)
 * 2. Character substitution (custom alphabet replaces standard Base64 alphabet)
 */

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM_PAD = '$';
const STD_PAD = '=';

const customToStandard = new Map<string, string>();
const standardToCustom = new Map<string, string>();

for (let i = 0; i < 64; i++) {
  customToStandard.set(CUSTOM_ALPHABET[i], STD_ALPHABET[i]);
  standardToCustom.set(STD_ALPHABET[i], CUSTOM_ALPHABET[i]);
}
customToStandard.set(CUSTOM_PAD, STD_PAD);
standardToCustom.set(STD_PAD, CUSTOM_PAD);

export function encode(plaintext: Buffer): string {
  const stdBase64 = plaintext.toString('base64');
  const length = stdBase64.length;
  const segmentSize = Math.floor(length / 3);

  const tail = stdBase64.substring(length - segmentSize);
  const middle = stdBase64.substring(segmentSize, length - segmentSize);
  const head = stdBase64.substring(0, segmentSize);
  const rearranged = tail + middle + head;

  let result = '';
  for (const char of rearranged) {
    const mapped = standardToCustom.get(char);
    if (mapped === undefined) {
      throw new Error(`Character out of alphabet: ${char}`);
    }
    result += mapped;
  }
  return result;
}

export function decode(encoded: string): Buffer {
  let mapped = '';
  for (const char of encoded) {
    const stdChar = customToStandard.get(char);
    if (stdChar === undefined) {
      throw new Error(`Character out of custom alphabet: ${char}`);
    }
    mapped += stdChar;
  }

  const length = mapped.length;
  const segmentSize = Math.floor(length / 3);

  const tail = mapped.substring(length - segmentSize);
  const middle = mapped.substring(segmentSize, length - segmentSize);
  const head = mapped.substring(0, segmentSize);
  const stdBase64 = tail + middle + head;

  return Buffer.from(stdBase64, 'base64');
}
