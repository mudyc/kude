/**
 * Osoitteet:
 *
 *   a1b2c3d                    resurssi samassa kuteessa (lyhyt hash)
 *   kude:<hash>                kiinnitetty versio (kuten gitin commit)
 *   kude:<tekijä>/<nimi>       tekijän uusin versio (kuten gitin haara)
 *   kude:<hash>#<lyhyt hash>   yksi resurssi toisen kuteen sisällä
 *   https://…                  mikä tahansa ulkoinen resurssi
 *
 * Tyypin oma sisäinen osoitus (`#t=42`, `#:~:text=`) kulkee URL:ssä sellaisenaan.
 */
import { HASH_PREFIX } from "./hash.js";

export type Address =
  | { kind: "local"; hash: string }
  | { kind: "pinned"; hash: string; fragment?: string }
  | { kind: "named"; author: string; name: string; fragment?: string }
  | { kind: "url"; url: string };

export function parseAddress(s: string): Address {
  if (HASH_PREFIX.test(s)) return { kind: "local", hash: s };
  if (s.startsWith("kude:")) {
    const rest = s.slice(5);
    const hashAt = rest.indexOf("#");
    const body = hashAt < 0 ? rest : rest.slice(0, hashAt);
    const fragment = hashAt < 0 ? undefined : rest.slice(hashAt + 1);
    if (HASH_PREFIX.test(body)) return { kind: "pinned", hash: body, fragment };
    const slash = body.lastIndexOf("/");
    if (slash > 0 && slash < body.length - 1) {
      return { kind: "named", author: body.slice(0, slash), name: body.slice(slash + 1), fragment };
    }
    throw new Error(`virheellinen kude-osoite: ${s}`);
  }
  return { kind: "url", url: s };
}

export function formatAddress(a: Address): string {
  switch (a.kind) {
    case "local":
      return a.hash;
    case "pinned":
      return `kude:${a.hash}${a.fragment ? `#${a.fragment}` : ""}`;
    case "named":
      return `kude:${a.author}/${a.name}${a.fragment ? `#${a.fragment}` : ""}`;
    case "url":
      return a.url;
  }
}

export const isKudeAddress = (s: string) => s.startsWith("kude:");
