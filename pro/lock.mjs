// Workstation locking tool. Everything private is encrypted with one password
// (pro/.password, git-ignored) via pro/crypto.mjs; only ciphertext is published.
//
//   node pro/lock.mjs                         pro/src.html -> pro.html (the locked page)
//   node pro/lock.mjs --unlock                pro.html -> pro/src.html (recover the source)
//   node pro/lock.mjs --file IN --out OUT     encrypt any text file (e.g. the CRM data)
//   node pro/lock.mjs --decrypt IN --out OUT  decrypt such a file
//   --password X                              use X instead of pro/.password

import { readFileSync, writeFileSync } from 'node:fs';
import { encrypt, decrypt } from './crypto.mjs';

const here = new URL('.', import.meta.url);
const SRC = new URL('src.html', here);
const OUT = new URL('../pro.html', here);
const PW_FILE = new URL('.password', here);

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const password = (opt('--password') ?? readFileSync(PW_FILE, 'utf8')).trim();
if (!password) throw new Error('empty password');

if (opt('--file')) {
  writeFileSync(opt('--out'), await encrypt(readFileSync(opt('--file'), 'utf8'), password));
  console.log(`encrypted ${opt('--file')} -> ${opt('--out')}`);
  process.exit(0);
}
if (opt('--decrypt')) {
  writeFileSync(opt('--out'), await decrypt(readFileSync(opt('--decrypt'), 'utf8'), password));
  console.log(`decrypted ${opt('--decrypt')} -> ${opt('--out')}`);
  process.exit(0);
}
if (args.includes('--unlock')) {
  const html = readFileSync(OUT, 'utf8');
  const m = html.match(/const LOCKED = (\{[^\n]*\});/);
  if (!m) throw new Error('pro.html does not look like a locked page');
  writeFileSync(SRC, await decrypt(m[1], password));
  console.log(`unlocked -> ${SRC.pathname}`);
  process.exit(0);
}

const locked = await encrypt(readFileSync(SRC, 'utf8'), password);
const shell = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workstation</title>
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
  input { font: inherit; color: var(--green); background: var(--bg); border: 1px solid var(--dim); height: 32px; padding: 0 10px; width: 34ch; max-width: 100%; }
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
<h1>[ WORKSTATION ]</h1>
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
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(LOCKED.salt), iterations: LOCKED.rounds, hash: 'SHA-256' }, base,
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
  // Stays unlocked for this browser tab; the workstation's [ lock ] link clears it.
  try { const saved = sessionStorage.getItem('pro.key'); if (saved) tryUnlock(saved, false); } catch {}
</script>
</body>
</html>
`;
writeFileSync(OUT, shell);
console.log(`locked ${SRC.pathname} -> ${OUT.pathname}`);
