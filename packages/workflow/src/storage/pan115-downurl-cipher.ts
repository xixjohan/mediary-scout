import { createHash } from "node:crypto";

const RSA_N = BigInt(
  "0x8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b8602136477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad6338c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f10a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683",
);
const RSA_E = 0x10001n;

const G_KTS = [
  240, 229, 105, 174, 191, 220, 191, 138, 26, 69, 232, 190, 125, 166, 115, 184,
  222, 143, 231, 196, 69, 218, 134, 196, 155, 100, 139, 20, 106, 180, 241, 170,
  56, 1, 53, 158, 38, 105, 44, 134, 0, 107, 79, 165, 54, 52, 98, 166, 42,
  150, 104, 24, 242, 74, 253, 189, 107, 151, 143, 77, 143, 137, 19, 183, 108,
  142, 147, 237, 14, 13, 72, 62, 215, 47, 136, 216, 254, 254, 126, 134, 80,
  149, 79, 209, 235, 131, 38, 52, 219, 102, 123, 156, 126, 157, 122, 129, 50,
  234, 182, 51, 222, 58, 169, 89, 52, 102, 59, 170, 186, 129, 96, 72, 185,
  213, 129, 156, 248, 108, 132, 119, 255, 84, 120, 38, 95, 190, 232, 30, 54,
  159, 52, 128, 92, 69, 44, 155, 118, 213, 27, 143, 204, 195, 184, 245,
];

const G_KEY_S = [0x29, 0x23, 0x21, 0x5e];
const G_KEY_L = [120, 6, 173, 76, 51, 134, 93, 24, 76, 1, 63, 70];

function m115GetKey(length: number, key?: number[]): number[] {
  if (key && key.length > 0) {
    const res: number[] = [];
    for (let i = 0; i < length; i++) {
      const v1 = ((key[i]! + G_KTS[length * i]!) & 0xff);
      const v2 = G_KTS[length * (length - 1 - i)]!;
      res.push(v1 ^ v2);
    }
    return res;
  }
  if (length === 12) {
    return [...G_KEY_L];
  }
  return [...G_KEY_S];
}

function xor115Enc(src: number[], srclen: number, key: number[], keylen: number): number[] {
  const mod4 = srclen % 4;
  const ret: number[] = [];
  if (mod4 !== 0) {
    for (let i = 0; i < mod4; i++) {
      ret.push(src[i]! ^ key[i % keylen]!);
    }
  }
  for (let i = mod4; i < srclen; i++) {
    ret.push(src[i]! ^ key[(i - mod4) % keylen]!);
  }
  return ret;
}

function m115SymEncode(src: number[], srclen: number, key1: number[], key2: number[]): number[] {
  const k1 = m115GetKey(4, key1);
  const k2 = m115GetKey(12, key2);
  const ret = xor115Enc(src, srclen, k1, 4);
  ret.reverse();
  return xor115Enc(ret, srclen, k2, 12);
}

function m115SymDecode(src: number[], srclen: number, key1: number[], key2: number[]): number[] {
  const k1 = m115GetKey(4, key1);
  const k2 = m115GetKey(12, key2);
  const ret = xor115Enc(src, srclen, k2, 12);
  ret.reverse();
  return xor115Enc(ret, srclen, k1, 4);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function rsaEncryptBlock(bsrc: Uint8Array): Uint8Array {
  const block = new Uint8Array(128);
  block.fill(0xff);
  block[0] = 0x00;
  block[1] = 0x02;
  block[128 - bsrc.length - 1] = 0x00;
  block.set(bsrc, 128 - bsrc.length);

  let isrc = 0n;
  for (const b of block) {
    isrc = (isrc << 8n) | BigInt(b);
  }

  let ienc = modPow(isrc, RSA_E, RSA_N);
  const out = new Uint8Array(128);
  for (let i = 127; i >= 0; i--) {
    out[i] = Number(ienc & 0xffn);
    ienc >>= 8n;
  }
  return out;
}

function rsaDecryptBlock(bsrc: Uint8Array): Uint8Array {
  let isrc = 0n;
  for (const b of bsrc) {
    isrc = (isrc << 8n) | BigInt(b);
  }

  let idec = modPow(isrc, RSA_E, RSA_N);
  const out = new Uint8Array(128);
  for (let i = 127; i >= 0; i--) {
    out[i] = Number(idec & 0xffn);
    idec >>= 8n;
  }

  let idx = 1;
  while (idx < 128 && out[idx] !== 0) {
    idx++;
  }
  return out.slice(idx + 1);
}

function m115AsymEncode(src: number[]): string {
  const m = 128 - 11;
  const out: number[] = [];
  const u8 = Uint8Array.from(src);
  for (let i = 0; i < u8.length; i += m) {
    const chunk = u8.slice(i, Math.min(i + m, u8.length));
    const encrypted = rsaEncryptBlock(chunk);
    for (const b of encrypted) {
      out.push(b);
    }
  }
  return Buffer.from(out).toString("base64");
}

function m115AsymDecode(src: number[]): number[] {
  const m = 128;
  const out: number[] = [];
  const u8 = Uint8Array.from(src);
  for (let i = 0; i < u8.length; i += m) {
    const chunk = u8.slice(i, Math.min(i + m, u8.length));
    const decrypted = rsaDecryptBlock(chunk);
    for (const b of decrypted) {
      out.push(b);
    }
  }
  return out;
}

/**
 * 为 115 的 /app/chrome/downurl 接口加密请求参数
 */
export function encode115DownurlPayload(srcText: string, tm: string): { data: string; key: string } {
  const md5sum = createHash("md5").update(`!@###@#${tm}DFDR@#@#`).digest("hex");
  const bkey = Array.from(Buffer.from(md5sum, "ascii"));
  const bsrc = Array.from(Buffer.from(srcText, "utf8"));

  const tmp = m115SymEncode(bsrc, bsrc.length, bkey, []);
  const tmp2 = bkey.slice(0, 16).concat(tmp);

  return {
    data: m115AsymEncode(tmp2),
    key: md5sum,
  };
}

/**
 * 为 115 的 /app/chrome/downurl 接口解密响应数据
 */
export function decode115DownurlResponse(srcBase64: string, keyHex: string): string {
  const bkey1 = Array.from(Buffer.from(keyHex, "ascii"));
  const rawBytes = Array.from(Buffer.from(srcBase64, "base64"));

  const tmp = m115AsymDecode(rawBytes);
  const bkey2 = tmp.slice(0, 16);
  const bsrc2 = tmp.slice(16);

  const decrypted = m115SymDecode(bsrc2, bsrc2.length, bkey1, bkey2);
  return Buffer.from(decrypted).toString("utf8");
}
