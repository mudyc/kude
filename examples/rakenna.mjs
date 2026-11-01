// Rakentaa esimerkkikuteet kirjaston avulla: varusteet ja seikkailu, johon
// osa varusteista tuodaan `lähde`-linkillä. Aja `npm run build:lib` ensin.
//   node examples/rakenna.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Kude, encode, open, address, utf8, P } from "../dist/core/index.js";

const here = new URL("./seikkailu/", import.meta.url);
const out = new URL("../web/esimerkit/", import.meta.url);
await mkdir(out, { recursive: true });

// 1. Kaikki varusteet omassa kuteessaan.
const varusteet = await Kude.create({ "@type": "ItemList", name: "Kaikki varusteeni" }, { time: "2026-06-01T12:00:00Z" });
const varuste = (name, grams) =>
  varusteet.append(
    utf8(JSON.stringify({ "@context": "https://schema.org", "@type": "IndividualProduct", name, weight: { "@type": "QuantitativeValue", value: grams, unitCode: "GRM" } })),
    "application/ld+json",
    { time: "2026-06-01T12:00:00Z" },
  );
const teltta = await varuste("Teltta", 1450);
const pussi = await varuste("Makuupussi", 980);
await varuste("Retkikeitin", 320);
const varusteBytes = await encode(varusteet);
await writeFile(new URL("varusteet.kude", out), varusteBytes);
const varusteetAuki = await open(varusteBytes);
const lahde = address(varusteetAuki);

// 2. Seikkailu: tekstipaloja ja kuvia omilla ajoillaan.
const k = await Kude.create(
  {
    "@type": "Trip",
    name: "Kolme päivää erämaassa",
    departureTime: "2026-08-14",
    arrivalTime: "2026-08-16",
    description: "Kolmen päivän retki tunturissa.",
    license: "https://creativecommons.org/licenses/by/4.0/",
  },
  { time: "2026-08-17T10:00:00+03:00" },
);
const text = (s, time) => k.append(utf8(s), "text/markdown", { time });
const image = async (file, time) => k.append(new Uint8Array(await readFile(new URL(file, here))), "image/svg+xml", { time });

await text("Lähdettiin aamulla kuuden jälkeen. Reppu painoi enemmän kuin piti, mutta sää oli *täydellinen*.", "2026-08-14T08:30:00+03:00");
await image("aamu.svg", "2026-08-14T09:41:00+03:00");
await text("## Ensimmäinen päivä", "2026-08-14T12:00:00+03:00");
await text("Polku kulki ensin kuusikossa ja nousi sitten tunturin rinteelle. Pidettiin tauko puron varressa ja keitettiin kahvit.", "2026-08-14T13:15:00+03:00");
await image("rinne.svg", "2026-08-15T11:20:00+03:00");
await text("## Kodalla", "2026-08-15T19:00:00+03:00");
await text("Illalla kodalla tuli paloi pitkään. Joku kertoi tarinan, jota kukaan ei uskonut, ja kaikki nauroivat silti.", "2026-08-15T20:10:00+03:00");
await image("ilta.svg", "2026-08-15T20:25:00+03:00");
await text("Kotiin palattiin kolmantena päivänä väsyneinä ja tyytyväisinä. Ensi kerralla kevyempi teltta.", "2026-08-16T18:00:00+03:00");
await text("## Varusteet", "2026-08-16T18:05:00+03:00");
// Tuodut varusteet: sama hash kuin varustekuteessa ja `lähde`-linkki sinne.
for (const v of [teltta, pussi]) {
  const r = await k.copyFrom(varusteetAuki, v.hash, lahde);
  k.insert(r.hash);
}
k.link(k.chain()[0], "schema:about", "https://fi.wikipedia.org/wiki/Tunturi");

await writeFile(new URL("seikkailu.kude", out), await encode(k));
console.log(`varusteet.kude ${lahde}\nseikkailu.kude ${k.chain().length} palaa, ${k.links.filter((l) => l.predicate === P.lahde).length} lähdelinkkiä`);
