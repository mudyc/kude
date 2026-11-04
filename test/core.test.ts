import { describe, expect, it } from "vitest";
import {
  address,
  encode,
  fromUrl,
  generateKeyPair,
  joinMarkdown,
  Kude,
  KudeError,
  open,
  P,
  parseAddress,
  shortHashes,
  signerFromJwk,
  splitMarkdown,
  utf8,
  verify,
  walk,
  gallery,
  timeline,
  hashOf,
  toBuffer,
} from "../src/core/index.js";

const md = (s: string) => utf8(s);

async function sample() {
  const k = await Kude.create({ "@type": "Trip", name: "Kolme päivää erämaassa" }, { time: "2026-08-17" });
  const a = await k.append(md("Lähdettiin aamulla."), "text/markdown", { time: "2026-08-14T08:30:00" });
  const b = await k.append(md("Illalla kodalla."), "text/markdown", { time: "2026-08-14T20:10:00" });
  const c = await k.append(md("Kotiin."), "text/markdown", { time: "2026-08-16T18:00:00" });
  return { k, a, b, c };
}

describe("hash", () => {
  it("lyhyt hash on seitsemän merkkiä ja pitenee vain törmäyksessä", () => {
    const m = shortHashes(["abcdef0123", "abcdef0999", "1234567aaa"]);
    expect(m.get("1234567aaa")).toBe("1234567");
    expect(m.get("abcdef0123")).toBe("abcdef01");
    expect(m.get("abcdef0999")).toBe("abcdef09");
  });
});

describe("lukujärjestys", () => {
  it("ketju seuraa alku- ja seuraava-linkkejä", async () => {
    const { k, a, b, c } = await sample();
    expect(k.chain()).toEqual([a.hash, b.hash, c.hash]);
    expect(k.linksFrom(k.root.hash, P.alku)).toHaveLength(1);
  });

  it("siirto muuttaa vain seuraava-linkkejä eikä resursseja", async () => {
    const { k, a, b, c } = await sample();
    const before = k.resources.map((r) => r.hash);
    k.move(c.hash, null);
    expect(k.chain()).toEqual([c.hash, a.hash, b.hash]);
    k.move(c.hash, b.hash);
    expect(k.chain()).toEqual([a.hash, b.hash, c.hash]);
    expect(k.resources.map((r) => r.hash)).toEqual(before);
  });

  it("muokkaus tekee uuden palan ja korvaa-linkin vanhaan", async () => {
    const { k, a, b, c } = await sample();
    const b2 = await k.edit(b.hash, md("Illalla kodalla, tuli paloi."));
    expect(k.chain()).toEqual([a.hash, b2.hash, c.hash]);
    expect(k.has(b.hash)).toBe(false);
    expect(k.linksFrom(b2.hash, P.korvaa).map((l) => l.to)).toEqual([b.hash]);
    // toinen muokkaus jatkaa versioketjua
    const b3 = await k.edit(b2.hash, md("Illalla kodalla."  + " Tuli."));
    expect(k.linksFrom(b3.hash, P.korvaa).map((l) => l.to)).toEqual([b2.hash]);
    expect(k.linksFrom(b2.hash, P.korvaa).map((l) => l.to)).toEqual([b.hash]);
  });

  it("poisto yhdistää ketjun ohi ja poistaa esikatselun", async () => {
    const { k, a, b, c } = await sample();
    const p = await k.setPreview(b.hash, md("pieni"), "image/webp");
    k.remove(b.hash);
    expect(k.chain()).toEqual([a.hash, c.hash]);
    expect(k.has(b.hash)).toBe(false);
    expect(k.has(p.hash)).toBe(false);
  });

  it("sama pala kahdesti hylätään", async () => {
    const { k } = await sample();
    await expect(k.append(md("Kotiin."), "text/markdown")).rejects.toThrow(KudeError);
  });

  it("metatiedon vaihto siirtää alku-linkin uuteen rootiin", async () => {
    const { k, a } = await sample();
    const oldRoot = k.root.hash;
    await k.setMeta({ "@type": "Trip", name: "Neljä päivää" });
    expect(k.root.hash).not.toBe(oldRoot);
    expect(k.chain()[0]).toBe(a.hash);
    expect((await k.meta()).name).toBe("Neljä päivää");
  });
});

describe("tiedostomuoto", () => {
  it("koodaus ja purku säilyttävät resurssit, linkit ja tuntemattomat sarakkeet", async () => {
    const { k, b } = await sample();
    k.get(b.hash)!.extra = { tulevaisuus: 42 };
    k.link(b.hash, "schema:about", "https://example.org/kota");
    const bytes = await encode(k);
    const k2 = await open(bytes);
    expect(k2.resources.map((r) => [r.hash, r.mime, r.time])).toEqual(k.resources.map((r) => [r.hash, r.mime, r.time]));
    expect(k2.links).toEqual(k.links);
    expect(k2.get(b.hash)!.extra).toEqual({ tulevaisuus: 42 });
    expect(await k2.text(b.hash)).toBe("Illalla kodalla.");
    expect(await encode(k2)).toEqual(bytes);
  });

  it("kuvauksessa linkkien päät ovat lyhyitä hasheja", async () => {
    const { k } = await sample();
    const bytes = await encode(k);
    const text = new TextDecoder().decode(bytes);
    const desc = JSON.parse(text.slice(text.indexOf('{"resources"'), text.indexOf("BIN") - 4).trim());
    for (const [from, , to] of desc.links.rows) {
      expect(from).toHaveLength(7);
      expect(to).toHaveLength(7);
    }
  });

  it("puuttuvaan resurssiin osoittava hash kirjoitetaan täytenä", async () => {
    const { k, b } = await sample();
    await k.edit(b.hash, md("uusi"));
    const k2 = await open(await encode(k));
    expect(k2.links.find((l) => l.predicate === P.korvaa)!.to).toBe(b.hash);
  });

  it("muutetut tavut havaitaan", async () => {
    const { k } = await sample();
    const bytes = await encode(k);
    const i = new TextDecoder().decode(bytes).indexOf("Kotiin");
    bytes[i] = "k".charCodeAt(0);
    const k2 = await open(bytes);
    const v = await verify(k2);
    expect(v.resourcesOk).toBe(false);
  });

  it("lukee ensin vain kuvauksen ja tavut Range-pyynnöillä", async () => {
    const { k, c } = await sample();
    const bytes = await encode(k);
    const ranges: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const r = new Headers(init?.headers).get("Range")!;
      ranges.push(r);
      const [s, e] = r.replace("bytes=", "").split("-").map(Number) as [number, number];
      return new Response(toBuffer(bytes.slice(s, e + 1)), { status: 206 });
    }) as typeof fetch;
    const k2 = await open(fromUrl("https://x/a.kude", { fetch: fakeFetch, prefetch: 16 }));
    const n = ranges.length;
    expect(k2.chain()).toHaveLength(3);
    expect(await k2.text(c.hash)).toBe("Kotiin.");
    expect(ranges.length).toBe(n + 1);
  });

  it("toimii palvelimella, joka ei tue Rangea", async () => {
    const { k, a } = await sample();
    const bytes = await encode(k);
    const fakeFetch = (async () => new Response(toBuffer(bytes), { status: 200 })) as unknown as typeof fetch;
    const k2 = await open(fromUrl("https://x/a.kude", { fetch: fakeFetch }));
    expect(await k2.text(a.hash)).toBe("Lähdettiin aamulla.");
  });
});

describe("allekirjoitus", () => {
  it("allekirjoitus täsmää ja rikkoutuu, jos kuvaus muuttuu", async () => {
    const { k } = await sample();
    const key = await generateKeyPair();
    expect(key.did).toMatch(/^did:key:z6Mk/);
    const signed = await encode(k, { signer: await signerFromJwk(key.privateJwk) });
    const v = await verify(await open(signed));
    expect(v.signatureOk).toBe(true);
    expect(v.author).toBe(key.did);

    const text = new TextDecoder().decode(signed);
    const tampered = signed.slice();
    tampered[text.indexOf("seuraava")] = "S".charCodeAt(0);
    const v2 = await verify(await open(tampered));
    expect(v2.signatureOk).toBe(false);
  });

  it("allekirjoittamaton kude ei väitä olevansa allekirjoitettu", async () => {
    const { k } = await sample();
    const v = await verify(await open(await encode(k)));
    expect(v.signatureOk).toBeUndefined();
  });
});

describe("tuonti ja osoitteet", () => {
  it("tuotu resurssi säilyttää hashin ja saa lähde-linkin", async () => {
    const varusteet = await Kude.create({ "@type": "ItemList", name: "Kaikki varusteeni" });
    const teltta = await varusteet.add(
      utf8(JSON.stringify({ "@type": "IndividualProduct", name: "Teltta", weight: { value: 1450, unitCode: "GRM" } })),
      "application/ld+json",
    );
    const vOpened = await open(await encode(varusteet));
    const { k } = await sample();
    const src = address(vOpened)!;
    const copy = await k.copyFrom(vOpened, teltta.hash.slice(0, 7), src);
    expect(copy.hash).toBe(teltta.hash);
    expect(k.linksFrom(copy.hash, P.lahde)[0]!.to).toBe(src);
  });

  it("osoitteet jäsentyvät", () => {
    expect(parseAddress("a1b2c3d")).toEqual({ kind: "local", hash: "a1b2c3d" });
    expect(parseAddress("kude:abcdef0#1234567")).toEqual({ kind: "pinned", hash: "abcdef0", fragment: "1234567" });
    expect(parseAddress("kude:did:key:z6Mkabc/seikkailu")).toEqual({
      kind: "named",
      author: "did:key:z6Mkabc",
      name: "seikkailu",
      fragment: undefined,
    });
    expect(parseAddress("https://example.org/v.mp4#t=42")).toEqual({ kind: "url", url: "https://example.org/v.mp4#t=42" });
  });

  it("rekursio pysähtyy kehään", async () => {
    const a = await Kude.create({ name: "A" });
    const b = await Kude.create({ name: "B" });
    const store = new Map<string, Kude>();
    // B linkittää A:han osoitteella, A linkittää B:hen nimellä.
    a.link(a.root.hash, "schema:hasPart", "kude:did:key:zB/b");
    const aOpened = await open(await encode(a));
    b.link(b.root.hash, "schema:isPartOf", address(aOpened)!);
    const bOpened = await open(await encode(b));
    store.set("kude:did:key:zB/b", bOpened);
    store.set(address(aOpened)!, aOpened);
    let loads = 0;
    const loaded = await walk(aOpened, async (addr) => {
      loads++;
      return store.get(addr.kind === "named" ? `kude:${addr.author}/${addr.name}` : `kude:${(addr as { hash: string }).hash}`);
    }, { maxDepth: 5 });
    expect([...loaded.keys()]).toEqual(["kude:did:key:zB/b"]);
    expect(loads).toBe(1);
  });
});

describe("näkymät", () => {
  it("galleria ja aikajana lajittelevat ajan mukaan, esikatselut pois", async () => {
    const { k, a, b } = await sample();
    const img1 = await k.append(utf8("kuva1"), "image/jpeg", { time: "2026-08-14T20:25:00" });
    const img2 = await k.append(utf8("kuva2"), "image/jpeg", { time: "2026-08-14T09:41:00" });
    await k.setPreview(img1.hash, utf8("suttu"), "image/webp");
    expect(gallery(k).map((r) => r.hash)).toEqual([img2.hash, img1.hash]);
    expect(timeline(k).map((r) => r.hash).slice(0, 3)).toEqual([a.hash, img2.hash, b.hash]);
  });
});

describe("markdown-jakaja", () => {
  it("pilkkoo ylimmän tason lohkoihin ja säilyttää koodilohkon", () => {
    const text = "# Otsikko\nKappale yksi\njatkuu.\r\n\n\n```\nkoodi\n\nlisää\n```\nKolmas  \n";
    expect(splitMarkdown(text)).toEqual(["# Otsikko", "Kappale yksi\njatkuu.", "```\nkoodi\n\nlisää\n```", "Kolmas"]);
  });

  it("on kanoninen: pilkottu ja yhdistetty teksti pilkkoutuu samoin", async () => {
    const blocks = splitMarkdown("A\n\nB\n\n## C\nD");
    expect(splitMarkdown(joinMarkdown(blocks))).toEqual(blocks);
    expect(await hashOf(utf8(blocks[1]!))).toBe(await hashOf(utf8("B")));
  });
});

describe("arvot ja linkatut resurssit", () => {
  it("data:-osoite ja toisen kuteen osoite säilyvät linkin päinä", async () => {
    const k = await Kude.create({ "@type": "Thing", name: "talo" });
    const a = await k.add(utf8('{"id":"a"}'), "application/json");
    k.link(a.hash, "bs:hormeja", "data:,2");
    k.link(a.hash, "bs:nimi", "data:,Piipun%20juuri");
    k.link(a.hash, "bs:tyyppi", "bs:tyyppi/savupiippu");
    k.link(a.hash, "bs:liittyy", "kude:estate:123/common#abcdef1234567890");
    const back = await open(await encode(k));
    expect(back.linksFrom(a.hash).map((l) => l.to)).toEqual([
      "data:,2",
      "data:,Piipun%20juuri",
      "bs:tyyppi/savupiippu",
      "kude:estate:123/common#abcdef1234567890",
    ]);
    expect(parseAddress("kude:estate:123/common#abcdef1234567890")).toEqual({
      kind: "named",
      author: "estate:123",
      name: "common",
      fragment: "abcdef1234567890",
    });
  });

  it("linkatun resurssin voi lisätä pelkällä hashilla", async () => {
    const k = await Kude.create({ "@type": "Thing" });
    const hash = await hashOf(utf8("kuva"));
    k.addLinkedHash("photos/x.jpg", hash, "image/jpeg");
    expect(() => k.addLinkedHash("x", "abc", "image/jpeg")).toThrow(KudeError);
    const back = await open(await encode(k));
    expect(back.get(hash)?.url).toBe("photos/x.jpg");
    back.fetcher = async () => utf8("kuva");
    expect(await back.text(hash)).toBe("kuva");
  });
});
