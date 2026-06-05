export interface DeviceKeypairJwks {
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
}

export async function generateDeviceKeypair(): Promise<DeviceKeypairJwks> {
  const keypair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;

  return {
    privateKeyJwk: await crypto.subtle.exportKey("jwk", keypair.privateKey) as JsonWebKey,
    publicKeyJwk: await crypto.subtle.exportKey("jwk", keypair.publicKey) as JsonWebKey,
  };
}

export async function publicKeyFromPrivateJwk(privateKeyJwk: JsonWebKey): Promise<JsonWebKey> {
  const publicKeyJwk: JsonWebKey = {
    kty: privateKeyJwk.kty,
    crv: privateKeyJwk.crv,
    x: privateKeyJwk.x,
    y: privateKeyJwk.y,
    ext: true,
    key_ops: ["verify"],
  };
  await importPublicKey(publicKeyJwk);
  return publicKeyJwk;
}

export async function signNonce(privateKeyJwk: JsonWebKey, nonce: string): Promise<string> {
  const key = await importPrivateKey(privateKeyJwk);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(nonce),
  );
  return base64Url(signature);
}

export function base64Url(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(privateKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function importPublicKey(publicKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}
