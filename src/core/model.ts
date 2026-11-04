import { fromUtf8, utf8 } from "./bytes.js";
import { FULL_HASH, hashOf, PrefixIndex } from "./hash.js";
import type { ByteSource } from "./source.js";

/** Ytimen viisi predikaattia. Muut predikaatit ovat URI-osoitteita, esim. `schema:about`. */
export const P = {
  alku: "alku",
  seuraava: "seuraava",
  lahde: "lähde",
  korvaa: "korvaa",
  esikatselu: "esikatselu",
} as const;

export const ROOT_MIME = "application/ld+json";

export class KudeError extends Error {
  override name = "KudeError";
}

export interface Resource {
  /** SHA-256 tavuista, 64 heksamerkkiä. */
  hash: string;
  mime: string;
  /** ISO 8601 -aikaleima. */
  time?: string;
  /** Tekijän DID. */
  author?: string;
  /** Linkatun resurssin osoite. Upotetulla resurssilla tätä ei ole. */
  url?: string;
  /** Tavut, jos ne on jo ladattu. */
  bytes?: Uint8Array;
  /** Upotetun resurssin sijainti data-osassa. */
  offset?: number;
  length?: number;
  /** Tuntemattomat sarakkeet säilytetään sellaisinaan. */
  extra?: Record<string, unknown>;
}

/**
 * Linkki on kolmikko mistä, predikaatti, mihin. Kuteen sisäinen pää on täysi hash,
 * muu pää on osoite (`kude:…`, `https://…`) tai kuteessa olemattoman resurssin hash.
 */
export interface Link {
  from: string;
  predicate: string;
  to: string;
  extra?: Record<string, unknown>;
}

/** Root-metatieto: JSON-olio, jonka avaimet tulevat schema.org-sanastosta. */
export type Meta = Record<string, unknown> & { "@context"?: unknown; "@type"?: string; name?: string };

export interface HeadInfo {
  author?: string;
  alg?: string;
  signature?: string;
  /** Kuvauksen tavut sellaisinaan; allekirjoitus tarkistetaan näistä. */
  description?: Uint8Array;
  /** Kuvauksen hash on kuteen tunniste: `kude:<hash>`. */
  descriptionHash?: string;
  [key: string]: unknown;
}

export interface AddOptions {
  time?: string;
  author?: string;
  extra?: Record<string, unknown>;
}

const now = () => new Date().toISOString();

export class Kude {
  resources: Resource[] = [];
  links: Link[] = [];
  head: HeadInfo = {};
  /** Kuvauksen tuntemattomat avaimet. */
  extraDescription: Record<string, unknown> = {};
  /** Mistä upotettujen resurssien tavut ladataan. */
  source?: ByteSource;
  binOffset = 0;
  /** Linkattujen resurssien haku. */
  fetcher: (url: string) => Promise<Uint8Array> = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new KudeError(`${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  /** Uusi kude, jonka root on annettu metatieto. */
  static async create(meta: Meta, opts: AddOptions = {}): Promise<Kude> {
    const k = new Kude();
    const bytes = encodeMeta(meta);
    k.resources.push({ hash: await hashOf(bytes), mime: ROOT_MIME, time: opts.time ?? now(), author: opts.author, bytes });
    return k;
  }

  get root(): Resource {
    const r = this.resources[0];
    if (!r) throw new KudeError("kuteella ei ole rootia");
    return r;
  }

  get(hash: string): Resource | undefined {
    return this.resources.find((r) => r.hash === hash);
  }

  has(hash: string): boolean {
    return this.get(hash) !== undefined;
  }

  /** Täysi hash lyhyestä tai täydestä hashista. */
  resolve(ref: string): string | undefined {
    if (FULL_HASH.test(ref)) return this.has(ref) ? ref : undefined;
    return new PrefixIndex(this.resources.map((r) => r.hash)).resolve(ref);
  }

  private must(ref: string): Resource {
    const hash = this.resolve(ref);
    const r = hash && this.get(hash);
    if (!r) throw new KudeError(`resurssia ${ref} ei ole kuteessa`);
    return r;
  }

  // ---- tavut ----

  /** Lataa resurssin tavut ja tarkistaa, että ne vastaavat hashia. */
  async load(ref: string): Promise<Uint8Array> {
    const r = this.must(ref);
    if (r.bytes) return r.bytes;
    let bytes: Uint8Array;
    if (r.offset !== undefined && r.length !== undefined) {
      if (!this.source) throw new KudeError(`resurssin ${r.hash.slice(0, 7)} tavuja ei voi ladata: ei lähdettä`);
      bytes = await this.source.read(this.binOffset + r.offset, r.length);
    } else if (r.url) {
      bytes = await this.fetcher(r.url);
    } else {
      throw new KudeError(`resurssilla ${r.hash.slice(0, 7)} ei ole tavuja eikä osoitetta`);
    }
    const actual = await hashOf(bytes);
    if (actual !== r.hash) {
      throw new KudeError(`resurssin ${r.hash.slice(0, 7)} tavut eivät vastaa hashia (saatiin ${actual.slice(0, 7)})`);
    }
    r.bytes = bytes;
    return bytes;
  }

  /** Lataa kaikki upotetut tavut, esimerkiksi ennen tallennusta. */
  async loadAll(): Promise<void> {
    await Promise.all(this.resources.filter((r) => !r.url).map((r) => this.load(r.hash)));
  }

  async text(ref: string): Promise<string> {
    return fromUtf8(await this.load(ref));
  }

  // ---- metatieto ----

  async meta(): Promise<Meta> {
    return JSON.parse(await this.text(this.root.hash)) as Meta;
  }

  /** Vaihtaa rootin. Rootin hash vaihtuu, ja siitä lähtevät linkit siirtyvät uuteen. */
  async setMeta(meta: Meta, opts: AddOptions = {}): Promise<Resource> {
    const old = this.root;
    const bytes = encodeMeta(meta);
    const hash = await hashOf(bytes);
    if (hash === old.hash) return old;
    if (this.has(hash)) throw new KudeError("sama metatieto on jo kuteessa toisena resurssina");
    const next: Resource = { ...old, hash, bytes, time: opts.time ?? now(), offset: undefined, length: undefined };
    this.resources[0] = next;
    this.rewrite(old.hash, hash);
    return next;
  }

  // ---- resurssit ----

  /** Lisää upotetun resurssin. Sama sisältö on sama resurssi, joten kaksoiskappaletta ei synny. */
  async add(bytes: Uint8Array, mime: string, opts: AddOptions = {}): Promise<Resource> {
    const hash = await hashOf(bytes);
    const existing = this.get(hash);
    if (existing) return existing;
    const r: Resource = { hash, mime, time: opts.time ?? now(), author: opts.author, bytes, extra: opts.extra };
    this.resources.push(r);
    return r;
  }

  /** Lisää linkatun resurssin. Hash lasketaan tavuista, jotka eivät tule kuteeseen. */
  async addLinked(url: string, bytes: Uint8Array, mime: string, opts: AddOptions = {}): Promise<Resource> {
    const hash = await hashOf(bytes);
    const existing = this.get(hash);
    if (existing) return existing;
    const r: Resource = { hash, mime, url, time: opts.time ?? now(), author: opts.author, extra: opts.extra };
    this.resources.push(r);
    return r;
  }

  /**
   * Lisää linkatun resurssin, jonka hash on jo tiedossa. Tavut voivat olla toisaalla
   * (esim. selain lähetti ne suoraan tallennukseen); hash tarkistetaan, kun ne ladataan.
   */
  addLinkedHash(url: string, hash: string, mime: string, opts: AddOptions = {}): Resource {
    if (!FULL_HASH.test(hash)) throw new KudeError(`virheellinen hash: ${hash}`);
    const existing = this.get(hash);
    if (existing) return existing;
    const r: Resource = { hash, mime, url, time: opts.time ?? now(), author: opts.author, extra: opts.extra };
    this.resources.push(r);
    return r;
  }

  // ---- linkit ----

  link(from: string, predicate: string, to: string): Link {
    const found = this.links.find((l) => l.from === from && l.predicate === predicate && l.to === to);
    if (found) return found;
    const l = { from, predicate, to };
    this.links.push(l);
    return l;
  }

  unlink(from: string, predicate: string, to?: string): void {
    this.links = this.links.filter((l) => !(l.from === from && l.predicate === predicate && (to === undefined || l.to === to)));
  }

  linksFrom(hash: string, predicate?: string): Link[] {
    return this.links.filter((l) => l.from === hash && (predicate === undefined || l.predicate === predicate));
  }

  linksTo(hash: string, predicate?: string): Link[] {
    return this.links.filter((l) => l.to === hash && (predicate === undefined || l.predicate === predicate));
  }

  /** Siirtää linkit vanhasta hashista uuteen. `korvaa`-linkit jäävät, jotta versioketju säilyy. */
  private rewrite(oldHash: string, newHash: string): void {
    const seen = new Set<string>();
    this.links = this.links
      .map((l) =>
        l.predicate === P.korvaa
          ? l
          : { ...l, from: l.from === oldHash ? newHash : l.from, to: l.to === oldHash ? newHash : l.to },
      )
      .filter((l) => {
        const key = `${l.from}\t${l.predicate}\t${l.to}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  // ---- lukujärjestys ----

  /** Blogin lukujärjestys: `alku` rootista ja sitten `seuraava`-ketju. Pysähtyy kehään. */
  chain(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = this.linksFrom(this.root.hash, P.alku)[0]?.to;
    while (cur && this.has(cur) && !seen.has(cur)) {
      out.push(cur);
      seen.add(cur);
      cur = this.linksFrom(cur, P.seuraava)[0]?.to;
    }
    return out;
  }

  /**
   * Kirjoittaa lukujärjestyksen. Linkit, jotka eivät muutu, jäävät paikalleen,
   * joten siirto muuttaa vain kolmea linkkiä.
   */
  setChain(order: string[]): void {
    if (new Set(order).size !== order.length) {
      throw new KudeError("sama pala on lukujärjestyksessä kahdesti");
    }
    for (const h of order) if (!this.has(h)) throw new KudeError(`palaa ${h.slice(0, 7)} ei ole kuteessa`);
    const wanted: Link[] = [];
    if (order.length) wanted.push({ from: this.root.hash, predicate: P.alku, to: order[0]! });
    for (let i = 0; i + 1 < order.length; i++) {
      wanted.push({ from: order[i]!, predicate: P.seuraava, to: order[i + 1]! });
    }
    const key = (l: Link) => `${l.from}\t${l.predicate}\t${l.to}`;
    const wantedKeys = new Set(wanted.map(key));
    const isChain = (l: Link) => l.predicate === P.seuraava || (l.predicate === P.alku && l.from === this.root.hash);
    this.links = this.links.filter((l) => !isChain(l) || wantedKeys.has(key(l)));
    const have = new Set(this.links.map(key));
    for (const l of wanted) if (!have.has(key(l))) this.links.push(l);
  }

  /**
   * Lisää palan lukujärjestykseen. `after` on pala, jonka perään lisätään;
   * `null` lisää alkuun ja pois jätetty loppuun.
   */
  insert(ref: string, after?: string | null): void {
    const hash = this.must(ref).hash;
    const order = this.chain();
    if (order.includes(hash)) {
      throw new KudeError("sama pala on jo lukujärjestyksessä; sama sisältö tuottaa saman hashin");
    }
    order.splice(this.position(order, after), 0, hash);
    this.setChain(order);
  }

  /** Lisää tavut uutena palana lukujärjestykseen. */
  async append(bytes: Uint8Array, mime: string, opts: AddOptions & { after?: string | null } = {}): Promise<Resource> {
    const hash = await hashOf(bytes);
    if (this.chain().includes(hash)) {
      throw new KudeError("sama pala on jo lukujärjestyksessä; sama sisältö tuottaa saman hashin");
    }
    const r = await this.add(bytes, mime, opts);
    this.insert(r.hash, opts.after);
    return r;
  }

  /** Siirtää palan toisen perään (`null` = alkuun). Resurssit ja hashit eivät muutu. */
  move(ref: string, after: string | null): void {
    const hash = this.must(ref).hash;
    const order = this.chain().filter((h) => h !== hash);
    if (after === hash) throw new KudeError("palaa ei voi siirtää itsensä perään");
    order.splice(this.position(order, after), 0, hash);
    this.setChain(order);
  }

  private position(order: string[], after: string | null | undefined): number {
    if (after === undefined) return order.length;
    if (after === null) return 0;
    const target = this.resolve(after) ?? after;
    const i = order.indexOf(target);
    if (i < 0) throw new KudeError(`palaa ${after.slice(0, 7)} ei ole lukujärjestyksessä`);
    return i + 1;
  }

  /**
   * Muokkaus: uusi pala, linkit siirtyvät uuteen hashiin ja uudesta tulee
   * `korvaa`-linkki vanhaan, jotta ulkopuoliset viittaukset löytävät uuden version.
   * Tekstipalan aika on oletuksena muokkaushetki, muiden alkuperäinen aika.
   */
  async edit(ref: string, bytes: Uint8Array, opts: AddOptions = {}): Promise<Resource> {
    const old = this.must(ref);
    if (old === this.resources[0]) return this.setMeta(JSON.parse(fromUtf8(bytes)) as Meta, opts);
    const hash = await hashOf(bytes);
    if (hash === old.hash) return old;
    if (this.has(hash)) throw new KudeError("sama sisältö on jo kuteessa; sama sisältö tuottaa saman hashin");
    const next: Resource = {
      hash,
      mime: old.mime,
      time: opts.time ?? (old.mime.startsWith("text/") ? now() : old.time),
      author: opts.author ?? old.author,
      bytes,
      extra: old.extra,
    };
    this.resources[this.resources.indexOf(old)] = next;
    this.rewrite(old.hash, hash);
    this.link(hash, P.korvaa, old.hash);
    return next;
  }

  /** Poistaa palan: ketju yhdistetään ohi, ja resurssi esikatseluineen poistuu kuteesta. */
  remove(ref: string): void {
    const r = this.must(ref);
    if (r === this.resources[0]) throw new KudeError("rootia ei voi poistaa");
    const order = this.chain();
    if (order.includes(r.hash)) this.setChain(order.filter((h) => h !== r.hash));
    const previews = this.linksFrom(r.hash, P.esikatselu).map((l) => l.to);
    this.links = this.links.filter((l) => l.from !== r.hash && l.to !== r.hash);
    this.resources = this.resources.filter((x) => x !== r);
    for (const p of previews) {
      if (this.has(p) && !this.links.some((l) => l.from === p || l.to === p)) {
        this.resources = this.resources.filter((x) => x.hash !== p);
      }
    }
  }

  // ---- esikatselu ----

  previewOf(hash: string): string | undefined {
    return this.linksFrom(hash, P.esikatselu).find((l) => this.has(l.to))?.to;
  }

  isPreview(hash: string): boolean {
    return this.links.some((l) => l.predicate === P.esikatselu && l.to === hash);
  }

  /** Pieni upotettu versio, joka näytetään heti: suttukuva tai kevennetty sarja. */
  async setPreview(ref: string, bytes: Uint8Array, mime: string): Promise<Resource> {
    const r = this.must(ref);
    const p = await this.add(bytes, mime, { time: r.time, author: r.author });
    for (const l of this.linksFrom(r.hash, P.esikatselu)) this.unlink(r.hash, P.esikatselu, l.to);
    this.link(r.hash, P.esikatselu, p.hash);
    return p;
  }

  // ---- tuonti ----

  /**
   * Tuo resurssin toisesta kuteesta sellaisenaan. Hash pysyy samana, ja
   * `lähde`-linkki osoittaa alkuperäiseen kuteeseen. Esikatselu tulee mukana.
   */
  async copyFrom(other: Kude, ref: string, source: string): Promise<Resource> {
    const hash = other.resolve(ref);
    const orig = hash && other.get(hash);
    if (!orig) throw new KudeError(`resurssia ${ref} ei ole lähdekuteessa`);
    const opts = { time: orig.time, author: orig.author, extra: orig.extra };
    const r = orig.url
      ? await this.addLinked(orig.url, await other.load(orig.hash), orig.mime, opts)
      : await this.add(await other.load(orig.hash), orig.mime, opts);
    this.link(r.hash, P.lahde, source);
    const preview = other.previewOf(orig.hash);
    if (preview) {
      const pr = other.get(preview)!;
      await this.setPreview(r.hash, await other.load(preview), pr.mime);
    }
    return r;
  }
}

export function encodeMeta(meta: Meta): Uint8Array {
  const withContext: Meta = meta["@context"] ? meta : { "@context": "https://schema.org", ...meta };
  return utf8(JSON.stringify(withContext, null, 2));
}
