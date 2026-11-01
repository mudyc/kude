import { concat, fromBase58, fromBase64Url, toBase58, toBase64Url, toBuffer } from "./bytes.js";

/**
 * Tekijä on `did:key`-tunniste (Ed25519). Avain ei tarvitse rekisteriä,
 * mutta kadonnut avain on kadonnut identiteetti.
 */
const ED25519_PUB = new Uint8Array([0xed, 0x01]);
export const SIGNATURE_ALG = "Ed25519";

export interface Signer {
  did: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface KeyPair {
  did: string;
  /** Yksityinen avain JWK-muodossa. Säilytä se itse; ilman sitä et voi allekirjoittaa. */
  privateJwk: JsonWebKey;
}

export function didFromPublicKey(raw: Uint8Array): string {
  if (raw.length !== 32) throw new Error("Ed25519-julkisen avaimen pitää olla 32 tavua");
  return `did:key:z${toBase58(concat([ED25519_PUB, raw]))}`;
}

export function publicKeyFromDid(did: string): Uint8Array {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!m) throw new Error(`tuntematon DID: ${did}`);
  const bytes = fromBase58(m[1]!);
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error(`DID ei ole Ed25519-avain: ${did}`);
  }
  return bytes.subarray(2);
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { did: didFromPublicKey(fromBase64Url(privateJwk.x!)), privateJwk };
}

export async function signerFromJwk(jwk: JsonWebKey): Promise<Signer> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) {
    throw new Error("avaimen pitää olla Ed25519-yksityisavain JWK-muodossa");
  }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return {
    did: didFromPublicKey(fromBase64Url(jwk.x)),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, toBuffer(data))),
  };
}

export async function verifySignature(did: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", toBuffer(publicKeyFromDid(did)), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, toBuffer(signature), toBuffer(data));
}

export const encodeSignature = toBase64Url;
export const decodeSignature = fromBase64Url;
