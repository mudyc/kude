import { toBuffer, toHex } from "./bytes.js";

/** Täysi hash: SHA-256 heksana. */
export const FULL_HASH = /^[0-9a-f]{64}$/;
/** Lyhyt tai täysi hash kuten gitissä: vähintään seitsemän merkkiä. */
export const HASH_PREFIX = /^[0-9a-f]{7,64}$/;
export const SHORT_LENGTH = 7;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(bytes)));
}

/** Resurssin nimi on sen tavujen hash. */
export async function hashOf(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes));
}

/**
 * Lyhyimmät yksikäsitteiset etuliitteet: seitsemän merkkiä, ja pidempi vain,
 * jos kaksi hashia alkaa samoin.
 */
export function shortHashes(hashes: Iterable<string>, min = SHORT_LENGTH): Map<string, string> {
  const sorted = [...new Set(hashes)].sort();
  const out = new Map<string, string>();
  const common = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  sorted.forEach((h, i) => {
    const prev = i > 0 ? common(h, sorted[i - 1]!) : 0;
    const next = i < sorted.length - 1 ? common(h, sorted[i + 1]!) : 0;
    out.set(h, h.slice(0, Math.max(min, prev + 1, next + 1)));
  });
  return out;
}

/** Etsii täyden hashin etuliitteellä. Palauttaa undefined, jos osumia on nolla tai useita. */
export class PrefixIndex {
  private buckets = new Map<string, string[]>();
  constructor(hashes: Iterable<string>) {
    for (const h of hashes) {
      const key = h.slice(0, SHORT_LENGTH);
      const list = this.buckets.get(key);
      if (list) list.push(h);
      else this.buckets.set(key, [h]);
    }
  }
  resolve(prefix: string): string | undefined {
    if (!HASH_PREFIX.test(prefix)) return undefined;
    const hits = (this.buckets.get(prefix.slice(0, SHORT_LENGTH)) ?? []).filter((h) => h.startsWith(prefix));
    return hits.length === 1 ? hits[0] : undefined;
  }
}
