/*
 * Device signal.
 *
 * A stable-ish hash of coarse browser characteristics, used only to raise a
 * duplicate-account case for a human to review. It is explicitly imprecise:
 * two different people on identical devices produce the same value, and the
 * same person produces a different value after a browser or hardware change.
 * Nothing here identifies a person, and no decision is made from it alone.
 */

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  // crypto.subtle needs a secure context; fall back to a weak non-crypto hash
  // rather than failing registration on plain http during development.
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (const b of bytes) h = ((h * 33) ^ b) >>> 0;
  return `fallback-${h.toString(16)}`;
}

export async function deviceSignal() {
  const parts = [
    navigator.userAgent,
    navigator.platform || '',
    navigator.hardwareConcurrency || '',
    navigator.language,
    (navigator.languages || []).join(','),
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    new Date().getTimezoneOffset(),
  ];
  return {
    hash: await sha256Hex(parts.join('|')),
    platform: navigator.platform || null,
    screen: `${screen.width}x${screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    languages: (navigator.languages || [navigator.language]).slice(0, 4).join(','),
  };
}
