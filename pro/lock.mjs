// Locks pro/src.html behind a password and writes ../pro.html.
//
//   node pro/lock.mjs            encrypt pro/src.html -> pro.html (password from pro/.password)
//   node pro/lock.mjs --unlock   decrypt pro.html -> pro/src.html (recovers the source)
//
// pro/src.html and pro/.password are git-ignored: only the encrypted pro.html is
// published. The page is AES-256-GCM encrypted with a key derived from the
// password (PBKDF2-SHA256, 300k rounds, random salt), so the source cannot be
// read from the published file, and a wrong password fails outright rather than
// producing garbage. The data the page shows is Deribit's public feed either
// way; the lock keeps the view itself off the public site.

import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const here = new URL('.', import.meta.url);
const SRC = new URL('src.html', here);
const OUT = new URL('../pro.html', here);
const PW_FILE = new URL('.password', here);
const ROUNDS = 300000;

const args = process.argv.slice(2);
const pwArg = args.indexOf('--password');
const password = (pwArg >= 0 ? args[pwArg + 1] : readFileSync(PW_FILE, 'utf8')).trim();
if (!password) throw new Error('empty password');

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => Buffer.from(buf).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ROUNDS, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

if (args.includes('--unlock')) {
  const html = readFileSync(OUT, 'utf8');
  const m = html.match(/const LOCKED = (\{[^\n]*\});/);
  if (!m) throw new Error('pro.html does not look like a locked page');
  const L = JSON.parse(m[1]);
  const key = await deriveKey(unb64(L.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(L.iv) }, key, unb64(L.data));
  writeFileSync(SRC, dec.decode(plain));
  console.log(`unlocked -> ${SRC.pathname}`);
  process.exit(0);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const key = await deriveKey(salt);
const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(readFileSync(SRC, 'utf8')));
const locked = JSON.stringify({ salt: b64(salt), iv: b64(iv), rounds: ROUNDS, data: b64(data) });

const shell = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crypto option data :: pro</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23000'/%3E%3Cpath d='M3 4l5 4-5 4' fill='none' stroke='%23FFB000' stroke-width='2'/%3E%3Crect x='9' y='11' width='4' height='2' fill='%23FFB000'/%3E%3C/svg%3E">
<style>
  :root { --bg: #000; --green: #33FF66; --dim: #1A7F3C; --amber: #FFB000; }
  * { box-sizing: border-box; border-radius: 0; }
  body { margin: 0; min-height: 100dvh; display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; background: var(--bg); color: var(--green);
    font: 13px/1.45 "IBM Plex Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; }
  body::after { content: ""; position: fixed; inset: 0; z-index: 100; pointer-events: none;
    background: repeating-linear-gradient(to bottom, rgba(51,255,102,.03) 0, rgba(51,255,102,.03) 1px, transparent 1px, transparent 3px); }
  h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: .08em; text-shadow: 0 0 6px rgba(51,255,102,.35); }
  form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  label { color: var(--dim); }
  input { font: inherit; color: var(--green); background: var(--bg); border: 1px solid var(--dim); height: 32px; padding: 0 10px; width: 24ch; }
  input:focus { outline: 1px solid var(--green); outline-offset: 2px; }
  button { font: inherit; color: var(--green); background: var(--bg); border: 1px solid var(--dim); height: 32px; padding: 0 12px; cursor: pointer; }
  button:hover { border-color: var(--green); background: rgba(51,255,102,.08); }
  #msg { color: var(--amber); min-height: 1.45em; }
  .cursor { display: inline-block; margin-left: 2px; animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  a { color: var(--dim); text-decoration: none; }
  a:hover { color: var(--green); }
</style>
</head>
<body>
<h1>[ CRYPTO OPTION DATA :: PRO ]</h1>
<form id="f">
  <label for="pw">&gt; password:</label>
  <input id="pw" type="password" autocomplete="current-password" autofocus>
  <button type="submit">[ UNLOCK ]</button>
</form>
<div id="msg"></div>
<a href="index.html">[ public page ]</a>
<script>
  const LOCKED = ${locked};
  const enc = new TextEncoder(), dec = new TextDecoder();
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const msg = document.getElementById('msg');
  async function unlock(password) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(LOCKED.salt), iterations: LOCKED.rounds, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(LOCKED.iv) }, key, unb64(LOCKED.data));
    return dec.decode(plain);
  }
  async function tryUnlock(password, remember) {
    msg.textContent = '> unlocking...';
    const c = document.createElement('span'); c.className = 'cursor'; c.textContent = '\\u2588'; msg.append(c);
    try {
      const html = await unlock(password);
      if (remember) { try { sessionStorage.setItem('pro.key', password); } catch {} }
      document.open(); document.write(html); document.close();
    } catch {
      msg.textContent = '[ERR] wrong password';
      try { sessionStorage.removeItem('pro.key'); } catch {}
    }
  }
  document.getElementById('f').addEventListener('submit', e => {
    e.preventDefault();
    const pw = document.getElementById('pw').value;
    if (pw) tryUnlock(pw, true);
  });
  // Stays unlocked for this browser tab; the page's [ lock ] link clears it.
  try { const saved = sessionStorage.getItem('pro.key'); if (saved) tryUnlock(saved, false); } catch {}
</script>
</body>
</html>
`;
writeFileSync(OUT, shell);
console.log(`locked ${SRC.pathname} -> ${OUT.pathname} (${(data.byteLength / 1024).toFixed(1)} KB encrypted)`);
