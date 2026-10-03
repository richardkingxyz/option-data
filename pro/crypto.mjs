// Shared encryption for everything behind the workstation password.
//
// Format (JSON): { v: 1, iv, data } with base64 fields. AES-256-GCM; the key is
// PBKDF2-SHA256 (ROUNDS) of the password with one fixed application salt, so the
// browser derives the key once per unlock and can open every file. GCM's auth tag
// means a wrong password fails cleanly instead of producing garbage.
import { webcrypto as crypto } from 'node:crypto';

export const ROUNDS = 600000;
export const SALT = 'option-data-workstation-v1';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => Buffer.from(buf).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

export async function deriveKey(password, usages = ['encrypt', 'decrypt']) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(SALT), iterations: ROUNDS, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, usages);
}

export async function encrypt(text, password) {
  const key = await deriveKey(password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return JSON.stringify({ v: 1, rounds: ROUNDS, salt: SALT, iv: b64(iv), data: b64(data) });
}

export async function decrypt(json, password) {
  const L = typeof json === 'string' ? JSON.parse(json) : json;
  const key = await deriveKey(password, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(L.iv) }, key, unb64(L.data));
  return dec.decode(plain);
}
