'use strict';

// ═══════════════════════════════════════════════════════════════
// CRYPTO — mirrors library.go parameters exactly
// AES-256-GCM with PBKDF2-SHA256 key derivation
// ═══════════════════════════════════════════════════════════════
const CRYPTO = {
  SALT_SIZE: 16, NONCE_SIZE: 12, ITERATIONS: 100000, KEY_SIZE: 256,

  async decryptWithPassword(encryptedData, password) {
    const view = new Uint8Array(encryptedData);
    const salt  = view.slice(0, this.SALT_SIZE);
    const nonce = view.slice(this.SALT_SIZE, this.SALT_SIZE + this.NONCE_SIZE);
    const ct    = view.slice(this.SALT_SIZE + this.NONCE_SIZE);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
      'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt, iterations:this.ITERATIONS, hash:'SHA-256' }, km, this.KEY_SIZE);
    const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:nonce }, key, ct);
    return new Uint8Array(plain);
  },

  async decryptWithKey(encryptedData, keyBuffer) {
    const view  = new Uint8Array(encryptedData);
    const nonce = view.slice(0, this.NONCE_SIZE);
    const ct    = view.slice(this.NONCE_SIZE);
    const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:nonce }, key, ct);
    return new Uint8Array(plain);
  },

  hexToBuffer(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) b[i/2] = parseInt(hex.substr(i,2), 16);
    return b;
  },

  formatBytes(n, d=2) {
    if (!n) return '—';
    const k=1024, s=['B','KB','MB','GB'], i=Math.floor(Math.log(n)/Math.log(k));
    return (n/k**i).toFixed(d)+' '+s[i];
  }
};
