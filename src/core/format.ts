/**
 * Tiedostomuoto, esikuvana glTF:n GLB:
 *
 *   otsake   12 tavua: taikaluku "KUDE", versio, kokonaispituus (u32 LE)
 *   HEAD     JSON: tekijä (DID), algoritmi, allekirjoitus
 *   JSON     kuvaus: resurssit- ja linkit-taulukot
 *   BIN      upotettujen resurssien tavut peräkkäin
 *
 * Jokainen osa on [pituus u32][tyyppi u32][data, täytetty neljään tavuun].
 * Kuvaus tulee ennen tavuja, jotta katselin voi piirtää järjestyksen heti.
 * Allekirjoitus lasketaan kuvauksen hashista, ja koska jokaisen resurssin hash
 * on kuvauksessa, se kattaa myös sisällön.
 */
import { concat, fromUtf8, toHex, utf8 } from "./bytes.js";
import { FULL_HASH, HASH_PREFIX, PrefixIndex, sha256, shortHashes } from "./hash.js";
import { Kude, KudeError, type Link, type Resource } from "./model.js";
import { decodeSignature, encodeSignature, SIGNATURE_ALG, type Signer, verifySignature } from "./sign.js";
import { type ByteSource, fromBytes } from "./source.js";

export const MAGIC = 0x4544554b; // "KUDE"
export const VERSION = 1;
const HEAD = 0x44414548; // "HEAD"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN = 0x004e4942; // "BIN\0"

const RESOURCE_COLUMNS = ["hash", "mime", "time", "author", "offset", "length", "url"] as const;
const LINK_COLUMNS = ["from", "predicate", "to"] as const;

interface Table {
  columns: string[];
  rows: unknown[][];
}

export interface EncodeOptions {
  signer?: Signer;
}

function pad(bytes: Uint8Array, fill: number): Uint8Array {
  const rem = bytes.length % 4;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + 4 - rem).fill(fill);
  out.set(bytes);
  return out;
}

function chunk(type: number, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  const v = new DataView(head.buffer);
  v.setUint32(0, data.length, true);
  v.setUint32(4, type, true);
  return concat([head, data]);
}

/** Kirjoittaa kuteen tiedostoksi. Kaikki upotetut tavut ladataan ensin. */
export async function encode(k: Kude, opts: EncodeOptions = {}): Promise<Uint8Array> {
  await k.loadAll();
  const short = shortHashes(k.resources.map((r) => r.hash));
  const end = (e: string) => (FULL_HASH.test(e) ? (short.get(e) ?? e) : e);

  const resExtra = [...new Set(k.resources.flatMap((r) => Object.keys(r.extra ?? {})))].filter(
    (c) => !(RESOURCE_COLUMNS as readonly string[]).includes(c),
  );
  const linkExtra = [...new Set(k.links.flatMap((l) => Object.keys(l.extra ?? {})))].filter(
    (c) => !(LINK_COLUMNS as readonly string[]).includes(c),
  );

  // Data-osan järjestys: ensin pienet (metatieto, tekstit, suttukuvat), sitten
  // raskas media lukujärjestyksessä. Ensimmäinen näkymä on silloin tiedoston alussa.
  const order = k.chain();
  const heavy = (r: Resource) => /^(image|video|audio)\//.test(r.mime) && !k.isPreview(r.hash);
  const rank = (r: Resource) => {
    if (r === k.resources[0]) return -1;
    const i = order.indexOf(r.hash);
    return (heavy(r) ? 1e9 : 0) + (i < 0 ? 1e6 : i);
  };
  const placed = new Map<string, { offset: number; length: number }>();
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const r of k.resources
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.url)
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r)) {
    placed.set(r.hash, { offset, length: r.bytes!.length });
    blobs.push(r.bytes!);
    offset += r.bytes!.length;
  }
  const resources: Table = {
    columns: [...RESOURCE_COLUMNS, ...resExtra],
    rows: k.resources.map((r) => {
      const at = placed.get(r.hash);
      return [
        r.hash,
        r.mime,
        r.time ?? null,
        r.author ?? null,
        at?.offset ?? null,
        at?.length ?? null,
        r.url ?? null,
        ...resExtra.map((c) => r.extra?.[c] ?? null),
      ];
    }),
  };
  const links: Table = {
    columns: [...LINK_COLUMNS, ...linkExtra],
    rows: k.links.map((l) => [end(l.from), l.predicate, end(l.to), ...linkExtra.map((c) => l.extra?.[c] ?? null)]),
  };

  const description = pad(utf8(JSON.stringify({ ...k.extraDescription, resources, links })), 0x20);
  const descHash = await sha256(description);

  const head: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(k.head)) {
    if (!["author", "alg", "signature", "description", "descriptionHash"].includes(key)) head[key] = value;
  }
  if (opts.signer) {
    head.author = opts.signer.did;
    head.alg = SIGNATURE_ALG;
    head.signature = encodeSignature(await opts.signer.sign(descHash));
  } else if (k.head.author) {
    head.author = k.head.author;
  }

  const body = concat([
    chunk(HEAD, pad(utf8(JSON.stringify(head)), 0x20)),
    chunk(JSON_CHUNK, description),
    chunk(BIN, pad(concat(blobs), 0)),
  ]);
  const header = new Uint8Array(12);
  const v = new DataView(header.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, VERSION, true);
  v.setUint32(8, 12 + body.length, true);
  return concat([header, body]);
}

/**
 * Avaa kuteen lähteestä. Vain otsake ja kuvaus luetaan; resurssien tavut
 * ladataan vasta, kun niitä pyydetään (`kude.load`).
 */
export async function open(source: ByteSource | Uint8Array): Promise<Kude> {
  const src = source instanceof Uint8Array ? fromBytes(source) : source;
  const header = await src.read(0, 12);
  const hv = new DataView(header.buffer, header.byteOffset, 12);
  if (hv.getUint32(0, true) !== MAGIC) throw new KudeError("tiedosto ei ole kude (taikaluku puuttuu)");
  const version = hv.getUint32(4, true);
  if (version !== VERSION) throw new KudeError(`kuteen versiota ${version} ei tueta`);
  const total = hv.getUint32(8, true);

  const k = new Kude();
  k.source = src;
  let pos = 12;
  let description: Uint8Array | undefined;
  while (pos + 8 <= total) {
    const ch = await src.read(pos, 8);
    const cv = new DataView(ch.buffer, ch.byteOffset, 8);
    const length = cv.getUint32(0, true);
    const type = cv.getUint32(4, true);
    const dataAt = pos + 8;
    if (type === BIN) {
      k.binOffset = dataAt;
      break; // tavut luetaan vasta tarvittaessa
    }
    const data = await src.read(dataAt, length);
    if (type === HEAD) {
      Object.assign(k.head, JSON.parse(fromUtf8(data)));
    } else if (type === JSON_CHUNK) {
      description = data.slice();
    } // tuntemattomat osat ohitetaan
    pos = dataAt + length;
  }
  if (!description) throw new KudeError("kuteesta puuttuu kuvaus");
  k.head.description = description;
  k.head.descriptionHash = toHex(await sha256(description));

  const { resources, links, ...rest } = JSON.parse(fromUtf8(description)) as {
    resources?: Table;
    links?: Table;
    [key: string]: unknown;
  };
  k.extraDescription = rest;
  if (!resources) throw new KudeError("kuvauksesta puuttuu resurssit-taulukko");

  k.resources = resources.rows.map((row) => {
    const r: Resource = { hash: "", mime: "application/octet-stream" };
    const extra: Record<string, unknown> = {};
    resources.columns.forEach((col, i) => {
      const value = row[i];
      if (value === null || value === undefined) return;
      switch (col) {
        case "hash":
        case "mime":
        case "time":
        case "author":
        case "url":
          r[col] = String(value);
          break;
        case "offset":
        case "length":
          r[col] = Number(value);
          break;
        default:
          extra[col] = value;
      }
    });
    if (!FULL_HASH.test(r.hash)) throw new KudeError(`virheellinen resurssin hash: ${r.hash}`);
    if (Object.keys(extra).length) r.extra = extra;
    return r;
  });
  if (!k.resources.length) throw new KudeError("kuteella ei ole rootia");

  const index = new PrefixIndex(k.resources.map((r) => r.hash));
  const end = (e: string) => (HASH_PREFIX.test(e) && !FULL_HASH.test(e) ? (index.resolve(e) ?? e) : e);
  k.links = (links?.rows ?? []).map((row) => {
    const l: Link = { from: "", predicate: "", to: "" };
    const extra: Record<string, unknown> = {};
    (links?.columns ?? []).forEach((col, i) => {
      const value = row[i];
      if (col === "from" || col === "predicate" || col === "to") l[col] = String(value ?? "");
      else if (value !== null && value !== undefined) extra[col] = value;
    });
    l.from = end(l.from);
    l.to = end(l.to);
    if (Object.keys(extra).length) l.extra = extra;
    return l;
  });
  return k;
}

/** Kuteen osoite: `kude:<kuvauksen hash>`. Saatavilla avatulle kuteelle. */
export function address(k: Kude): string | undefined {
  return k.head.descriptionHash ? `kude:${k.head.descriptionHash}` : undefined;
}

export interface Verification {
  /** Kaikki upotetut resurssit vastaavat hashejaan. */
  resourcesOk: boolean;
  problems: string[];
  /** undefined: allekirjoitusta ei ole. */
  signatureOk?: boolean;
  author?: string;
}

/** Tarkistaa allekirjoituksen ja halutessa jokaisen upotetun resurssin hashin. */
export async function verify(k: Kude, { resources = true } = {}): Promise<Verification> {
  const problems: string[] = [];
  let signatureOk: boolean | undefined;
  if (k.head.signature) {
    if (!k.head.author || !k.head.description) {
      signatureOk = false;
      problems.push("allekirjoitukselta puuttuu tekijä tai kuvaus");
    } else if (k.head.alg && k.head.alg !== SIGNATURE_ALG) {
      signatureOk = false;
      problems.push(`tuntematon allekirjoitusalgoritmi ${k.head.alg}`);
    } else {
      try {
        signatureOk = await verifySignature(
          k.head.author,
          await sha256(k.head.description),
          decodeSignature(k.head.signature),
        );
      } catch (e) {
        signatureOk = false;
        problems.push(`allekirjoitusta ei voitu tarkistaa: ${(e as Error).message}`);
      }
      if (!signatureOk && !problems.length) problems.push("allekirjoitus ei täsmää kuvaukseen");
    }
  }
  let resourcesOk = true;
  if (resources) {
    for (const r of k.resources.filter((x) => !x.url)) {
      try {
        await k.load(r.hash);
      } catch (e) {
        resourcesOk = false;
        problems.push((e as Error).message);
      }
    }
  }
  return {
    resourcesOk,
    problems,
    signatureOk,
    author: k.head.author,
  };
}
