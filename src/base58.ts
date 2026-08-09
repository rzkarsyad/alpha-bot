// Pool accounts have to be read as raw bytes — jsonParsed does not understand
// AMM layouts — so pubkeys come out as 32-byte slices that need base58 encoding.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode raw bytes as a base58 string, Bitcoin/Solana alphabet. */
export function toBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);

  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }

  // Each leading zero byte is encoded as a literal '1'.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}

/** Read a 32-byte pubkey at `offset`, or null if the slice runs past the end. */
export function readPubkey(data: Uint8Array, offset: number): string | null {
  if (offset < 0 || offset + 32 > data.length) return null;
  return toBase58(data.subarray(offset, offset + 32));
}
