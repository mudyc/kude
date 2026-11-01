/**
 * Rekursio: toinen kude on resurssi muiden joukossa. Kun linkki osoittaa
 * kuteeseen, katselin avaa sen ja seuraa sen linkkejä. Kehät ja syvyysraja
 * estävät yhtä linkkiä lataamasta koko merta.
 */
import { type Address, formatAddress, isKudeAddress, parseAddress } from "./address.js";
import { open } from "./format.js";
import type { Kude } from "./model.js";
import { fromUrl } from "./source.js";

export type Loader = (address: Address) => Promise<Kude | undefined>;

/**
 * Lataaja staattiselta palvelimelta: `kude:<hash>` → `<base>/<hash>.kude`,
 * `kude:<tekijä>/<nimi>` → `<base>/<tekijä>/<nimi>.kude`.
 */
export function staticLoader(base: string, opts: { fetch?: typeof fetch } = {}): Loader {
  const root = base.replace(/\/$/, "");
  return async (a) => {
    let url: string;
    if (a.kind === "pinned") url = `${root}/${a.hash}.kude`;
    else if (a.kind === "named") url = `${root}/${encodeURIComponent(a.author)}/${encodeURIComponent(a.name)}.kude`;
    else if (a.kind === "url") url = a.url;
    else return undefined;
    return open(fromUrl(url, opts));
  };
}

export interface WalkOptions {
  maxDepth?: number;
  onError?: (address: string, error: unknown) => void;
}

/** Avaa kuteet, joihin `start` linkittää, syvyyteen `maxDepth` asti. Avain on osoite. */
export async function walk(start: Kude, load: Loader, opts: WalkOptions = {}): Promise<Map<string, Kude>> {
  const maxDepth = opts.maxDepth ?? 2;
  const opened = new Map<string, Kude>();
  const seen = new Set<string>();
  if (start.head.descriptionHash) seen.add(`kude:${start.head.descriptionHash}`);
  let frontier: Kude[] = [start];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: Kude[] = [];
    for (const k of frontier) {
      for (const l of k.links) {
        if (!isKudeAddress(l.to)) continue;
        const a = parseAddress(l.to);
        const key = formatAddress({ ...a, fragment: undefined } as Address);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const child = await load(a);
          if (!child) continue;
          // Sama kude eri osoitteella on silti sama kude.
          const id = child.head.descriptionHash && `kude:${child.head.descriptionHash}`;
          if (id && id !== key && seen.has(id)) continue;
          if (id) seen.add(id);
          opened.set(key, child);
          next.push(child);
        } catch (e) {
          opts.onError?.(l.to, e);
        }
      }
    }
    frontier = next;
  }
  return opened;
}
