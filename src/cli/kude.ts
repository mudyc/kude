#!/usr/bin/env node
/**
 * kude-komentorivi.
 *
 *   kude info <a.kude>                    metatieto, resurssit, linkit ja lukujärjestys
 *   kude verify <a.kude>                  hashit ja allekirjoitus
 *   kude cat <a.kude> <hash>              resurssin tavut stdoutiin
 *   kude unpack <a.kude> [kansio]         kansioksi: yksi tiedosto per resurssi + TSV:t
 *   kude pack <kansio> [a.kude]           kansiosta takaisin kuteeksi
 *   kude import <teksti.md> [a.kude]      Markdown paloiksi; kuvalohkoista kuvaresurssit
 *   kude keygen [avain.json]              Ed25519-avain, tekijä on did:key
 *   kude sign <a.kude> [ulos.kude]        allekirjoitus avaimella (--key)
 *
 * Valitsimet: --key <avain.json> allekirjoittaa, --type <schema.org-tyyppi>, --name <otsikko>.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  encode,
  extensionOf,
  firstHeading,
  generateKeyPair,
  hashOf,
  imageOnly,
  Kude,
  KudeError,
  mimeOf,
  open,
  P,
  readImageInfo,
  type Resource,
  ROOT_MIME,
  shortHashes,
  type Signer,
  signerFromJwk,
  splitMarkdown,
  utf8,
  verify,
} from "../core/index.js";

const ROOT_FILE = "juuri.json";
const RESOURCES_TSV = "resurssit.tsv";
const LINKS_TSV = "linkit.tsv";
const RES_COLS = ["tiedosto", "hash", "mime", "aika", "tekijä", "url"];

interface Args {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true");
    } else positional.push(a);
  }
  return { positional, flags };
}

const readKude = async (path: string) => open(new Uint8Array(await readFile(path)));

async function loadSigner(flags: Record<string, string>): Promise<Signer | undefined> {
  const path = flags.key ?? process.env.KUDE_KEY;
  if (!path) return undefined;
  return signerFromJwk(JSON.parse(await readFile(path, "utf8")) as JsonWebKey);
}

// ---- TSV ----

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const unesc = (s: string) =>
  s.replace(/\\([\\tnr])/g, (_, c: string) => ({ "\\": "\\", t: "\t", n: "\n", r: "\r" })[c]!);

function writeTsv(columns: string[], rows: string[][]): string {
  return [columns, ...rows].map((r) => r.map(esc).join("\t")).join("\n") + "\n";
}

function readTsv(text: string): Record<string, string>[] {
  const [head, ...lines] = text.split("\n").filter((l) => l.length);
  if (!head) return [];
  const cols = head.split("\t").map(unesc);
  return lines.map((line) => {
    const cells = line.split("\t").map(unesc);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

// ---- komennot ----

async function info(path: string) {
  const k = await readKude(path);
  const meta = await k.meta();
  const short = shortHashes(k.resources.map((r) => r.hash));
  const s = (h: string) => short.get(h) ?? h;
  console.log(`${meta.name ?? "(nimetön)"}  [${meta["@type"] ?? "?"}]`);
  console.log(`osoite   kude:${k.head.descriptionHash}`);
  if (k.head.author) console.log(`tekijä   ${k.head.author}${k.head.signature ? " (allekirjoitettu)" : ""}`);
  console.log("\nresurssit");
  for (const r of k.resources) {
    const size = r.url ? r.url : `${r.length ?? r.bytes?.length ?? 0} t`;
    console.log(`  ${s(r.hash).padEnd(8)} ${r.mime.padEnd(22)} ${(r.time ?? "").padEnd(25)} ${size}`);
  }
  console.log("\nlinkit");
  for (const l of k.links) console.log(`  ${s(l.from).padEnd(8)} ${l.predicate.padEnd(12)} ${s(l.to)}`);
  console.log("\nlukujärjestys");
  for (const h of k.chain()) {
    const r = k.get(h)!;
    const preview = r.mime.startsWith("text/") ? (await k.text(h)).split("\n")[0]!.slice(0, 60) : r.mime;
    console.log(`  ${s(h).padEnd(8)} ${preview}`);
  }
}

async function verifyCmd(path: string): Promise<number> {
  const k = await readKude(path);
  const v = await verify(k);
  console.log(`resurssit    ${v.resourcesOk ? "ok" : "VIRHE"} (${k.resources.filter((r) => !r.url).length} upotettua)`);
  console.log(
    `allekirjoitus ${v.signatureOk === undefined ? "ei ole" : v.signatureOk ? `ok, ${v.author}` : "EI TÄSMÄÄ"}`,
  );
  for (const p of v.problems) console.log(`  - ${p}`);
  return v.resourcesOk && v.signatureOk !== false ? 0 : 1;
}

async function cat(path: string, ref: string) {
  const k = await readKude(path);
  process.stdout.write(await k.load(ref));
}

async function unpack(path: string, dir?: string) {
  const k = await readKude(path);
  await k.loadAll();
  const out = dir ?? basename(path, extname(path));
  await mkdir(out, { recursive: true });
  const short = shortHashes(k.resources.map((r) => r.hash));
  const names = new Map<string, string>();
  k.resources.forEach((r, i) => {
    names.set(r.hash, i === 0 ? ROOT_FILE : `${short.get(r.hash)}.${extensionOf(r.mime)}`);
  });
  const extraCols = [...new Set(k.resources.flatMap((r) => Object.keys(r.extra ?? {})))];
  const rows: string[][] = [];
  for (const r of k.resources) {
    const file = names.get(r.hash)!;
    if (!r.url) await writeFile(join(out, file), r.bytes!);
    rows.push([
      r.url ? "" : file,
      r.hash,
      r.mime,
      r.time ?? "",
      r.author ?? "",
      r.url ?? "",
      ...extraCols.map((c) => (r.extra?.[c] === undefined ? "" : JSON.stringify(r.extra[c]))),
    ]);
  }
  await writeFile(join(out, RESOURCES_TSV), writeTsv([...RES_COLS, ...extraCols], rows));
  const end = (e: string) => names.get(e) ?? e;
  await writeFile(
    join(out, LINKS_TSV),
    writeTsv(["mistä", "predikaatti", "mihin"], k.links.map((l) => [end(l.from), l.predicate, end(l.to)])),
  );
  console.log(`${out}/: ${k.resources.length} resurssia, ${k.links.length} linkkiä`);
}

async function pack(dir: string, outPath: string | undefined, flags: Record<string, string>) {
  const rows = readTsv(await readFile(join(dir, RESOURCES_TSV), "utf8"));
  if (!rows.length) throw new KudeError(`${RESOURCES_TSV} on tyhjä; rivi 0 on root`);
  const k = new Kude();
  const byFile = new Map<string, string>();
  const replaced: [string, string][] = [];
  for (const [i, row] of rows.entries()) {
    const extra: Record<string, unknown> = {};
    for (const [c, v] of Object.entries(row)) if (!RES_COLS.includes(c) && v !== "") extra[c] = JSON.parse(v);
    const base = {
      mime: row.mime || (i === 0 ? ROOT_MIME : mimeOf(row.tiedosto ?? "")),
      time: row.aika || undefined,
      author: row["tekijä"] || undefined,
      extra: Object.keys(extra).length ? extra : undefined,
    };
    let r: Resource;
    if (row.tiedosto) {
      const bytes = new Uint8Array(await readFile(join(dir, row.tiedosto)));
      const hash = await hashOf(bytes);
      r = { ...base, hash, bytes };
      if (row.hash && row.hash !== hash) replaced.push([hash, row.hash]);
      byFile.set(row.tiedosto, hash);
    } else if (row.url && row.hash) {
      r = { ...base, hash: row.hash, url: row.url };
    } else {
      throw new KudeError(`${RESOURCES_TSV} rivi ${i + 1}: tarvitaan tiedosto tai url ja hash`);
    }
    if (k.has(r.hash)) throw new KudeError(`${row.tiedosto || row.url}: sama sisältö on jo kuteessa`);
    k.resources.push(r);
  }
  const listed = new Set(rows.map((r) => r.tiedosto));
  const unlisted = (await readdir(dir)).filter((f) => !listed.has(f) && f !== RESOURCES_TSV && f !== LINKS_TSV);
  if (unlisted.length) console.warn(`ohitettiin tiedostot, joita ei ole ${RESOURCES_TSV}:ssä: ${unlisted.join(", ")}`);

  const old = new Map(rows.filter((r) => r.tiedosto).map((r) => [r.hash, byFile.get(r.tiedosto!)!]));
  const end = (e: string) => byFile.get(e) ?? old.get(e) ?? e;
  if (existsSync(join(dir, LINKS_TSV))) {
    for (const row of readTsv(await readFile(join(dir, LINKS_TSV), "utf8"))) {
      k.link(end(row["mistä"] ?? ""), row.predikaatti ?? "", end(row.mihin ?? ""));
    }
  }
  // Muokattu tiedosto: uusi hash ja korvaa-linkki vanhaan (paitsi rootille).
  for (const [now, before] of replaced) if (now !== k.root.hash) k.link(now, P.korvaa, before);

  const outFile = outPath ?? `${dir.replace(/\/$/, "")}.kude`;
  const signer = await loadSigner(flags);
  await writeFile(outFile, await encode(k, { signer }));
  const edits = replaced.length ? `, ${replaced.length} muokattua` : "";
  console.log(`${outFile}: ${k.resources.length} resurssia, ${k.links.length} linkkiä${edits}${signer ? ", allekirjoitettu" : ""}`);
}

async function importMarkdown(path: string, outPath: string | undefined, flags: Record<string, string>) {
  const text = await readFile(path, "utf8");
  const blocks = splitMarkdown(text);
  const signer = await loadSigner(flags);
  const author = signer?.did;
  const meta = {
    "@type": flags.type ?? "BlogPosting",
    name: flags.name ?? firstHeading(blocks) ?? basename(path, extname(path)),
    ...(flags.description ? { description: flags.description } : {}),
    ...(author ? { author } : {}),
  };
  // Ensimmäinen otsikko on kuteen nimi rootissa, joten sitä ei toisteta palana.
  if (!flags.name && blocks[0] && firstHeading(blocks.slice(0, 1)) === meta.name) blocks.shift();
  const k = await Kude.create(meta, { author });
  const base = dirname(resolve(path));
  for (const block of blocks) {
    const img = imageOnly(block);
    if (img && !/^[a-z]+:/i.test(img.src) && existsSync(join(base, img.src))) {
      const bytes = new Uint8Array(await readFile(join(base, img.src)));
      const time = readImageInfo(bytes).time;
      await k.append(bytes, mimeOf(img.src), { time, author });
      if (readImageInfo(bytes).gps) console.warn(`huom: ${img.src} sisältää sijainnin (poista ennen julkaisua)`);
    } else {
      await k.append(utf8(block), "text/markdown", { author });
    }
  }
  const outFile = outPath ?? path.replace(/\.(md|markdown)$/i, "") + ".kude";
  await writeFile(outFile, await encode(k, { signer }));
  console.log(`${outFile}: ${k.chain().length} palaa`);
}

async function keygen(out?: string) {
  const pair = await generateKeyPair();
  const json = JSON.stringify(pair.privateJwk, null, 2) + "\n";
  if (out) {
    await writeFile(out, json, { mode: 0o600 });
    console.log(`${out}: ${pair.did}`);
  } else process.stdout.write(json);
}

async function sign(path: string, out: string | undefined, flags: Record<string, string>) {
  const signer = await loadSigner(flags);
  if (!signer) throw new KudeError("anna avain: --key avain.json (tai KUDE_KEY)");
  const k = await readKude(path);
  await writeFile(out ?? path, await encode(k, { signer }));
  console.log(`${out ?? path}: allekirjoitettu, ${signer.did}`);
}

const USAGE = `käyttö:
  kude info <a.kude>
  kude verify <a.kude>
  kude cat <a.kude> <hash>
  kude unpack <a.kude> [kansio]
  kude pack <kansio> [a.kude] [--key avain.json]
  kude import <teksti.md> [a.kude] [--type Trip] [--name …] [--key avain.json]
  kude keygen [avain.json]
  kude sign <a.kude> [ulos.kude] --key avain.json`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional: p, flags } = parseArgs(rest);
  const need = (n: number) => {
    if (p.length < n) throw new KudeError(USAGE);
  };
  switch (cmd) {
    case "info":
      need(1);
      await info(p[0]!);
      return 0;
    case "verify":
      need(1);
      return verifyCmd(p[0]!);
    case "cat":
      need(2);
      await cat(p[0]!, p[1]!);
      return 0;
    case "unpack":
      need(1);
      await unpack(p[0]!, p[1]);
      return 0;
    case "pack":
      need(1);
      await pack(p[0]!, p[1], flags);
      return 0;
    case "import":
      need(1);
      await importMarkdown(p[0]!, p[1], flags);
      return 0;
    case "keygen":
      await keygen(p[0]);
      return 0;
    case "sign":
      need(1);
      await sign(p[0]!, p[1], flags);
      return 0;
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof KudeError ? e.message : e);
    process.exit(1);
  },
);
