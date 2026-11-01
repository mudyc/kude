/**
 * Näkymät kulkevat samat resurssit eri järjestyksissä. Mitään niistä ei tallenneta.
 */
import { type Kude, P, type Resource } from "./model.js";

const timeValue = (r: Resource) => {
  const t = r.time ? Date.parse(r.time) : NaN;
  return Number.isNaN(t) ? Infinity : t;
};

export const byTime = (a: Resource, b: Resource) => timeValue(a) - timeValue(b);

/** Blogi: `alku`- ja `seuraava`-linkit rootista. */
export function blog(k: Kude): Resource[] {
  return k.chain().map((h) => k.get(h)!);
}

/** Sisältö ilman rootia ja esikatseluja. */
export function content(k: Kude): Resource[] {
  return k.resources.slice(1).filter((r) => !k.isPreview(r.hash));
}

/** Galleria: kuvat aikaleiman mukaan. */
export function gallery(k: Kude): Resource[] {
  return content(k).filter((r) => r.mime.startsWith("image/")).sort(byTime);
}

/** Aikajana: kaikki resurssit ajan mukaan, myös linkatut. */
export function timeline(k: Kude): Resource[] {
  return content(k).sort(byTime);
}

/** Mistä resurssi on tullut (`lähde`-linkit). */
export const sources = (k: Kude, hash: string) => k.linksFrom(hash, P.lahde).map((l) => l.to);
