/**
 * Kuteen selainsovellus: katselin (blogi, galleria, aikajana) ja lohkoeditori.
 * Kukaan ei käsittele kudetta käsin: editori kirjoittaa resurssit ja linkit.
 */
import {
  blog,
  encode,
  fromBytes,
  fromUrl,
  gallery,
  generateKeyPair,
  Kude,
  KudeError,
  type Meta,
  mimeOf,
  open,
  readImageInfo,
  type Resource,
  shortHashes,
  type Signer,
  signerFromJwk,
  sources,
  splitMarkdown,
  stripLocation,
  timeline,
  toBuffer,
  utf8,
  verify,
} from "../core/index.js";
import { escapeHtml, renderBlock } from "./render-md.js";

type View = "blogi" | "galleria" | "aikajana" | "muokkaa";
const VIEWS: [View, string][] = [
  ["blogi", "Blogi"],
  ["galleria", "Galleria"],
  ["aikajana", "Aikajana"],
  ["muokkaa", "Muokkaa"],
];
const KEY_STORAGE = "kude.avain";

const state: {
  kude?: Kude;
  fileName: string;
  view: View;
  dirty: boolean;
  focus?: string;
  /** Uuden tekstilohkon paikka: palan hash, null = alkuun. */
  draftAfter?: string | null;
  signer?: Signer;
  loading?: string;
} = { fileName: "uusi.kude", view: "blogi", dirty: false };

const app = document.getElementById("app")!;

// ---- DOM-apurit ----

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k === "value" || k === "checked" || k === "disabled") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function toast(message: string, kind: "info" | "virhe" = "info") {
  const el = h("div", { class: `ilmoitus ${kind}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), kind === "virhe" ? 6000 : 3000);
}

function fail(e: unknown) {
  console.error(e);
  toast(e instanceof Error ? e.message : String(e), "virhe");
}

const formatTime = (t?: string, withDate = true) => {
  if (!t) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const date = d.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric", year: "numeric" });
  const time = /T\d/.test(t) ? d.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }) : "";
  return withDate ? `${date}${time ? ` ${time}` : ""}` : time;
};

const shortDid = (did: string) => (did.length > 24 ? `${did.slice(0, 14)}…${did.slice(-6)}` : did);

// ---- tavut näkyviksi ----

const objectUrls = new Map<string, string>();

async function urlFor(k: Kude, r: Resource): Promise<string> {
  if (r.url) return r.url;
  const cached = objectUrls.get(r.hash);
  if (cached) return cached;
  const bytes = await k.load(r.hash);
  const url = URL.createObjectURL(new Blob([toBuffer(bytes)], { type: r.mime }));
  objectUrls.set(r.hash, url);
  return url;
}

function resetUrls() {
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
}

const lazy = new WeakMap<Element, () => void>();
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const load = lazy.get(e.target);
      lazy.delete(e.target);
      observer.unobserve(e.target);
      load?.();
    }
  },
  { rootMargin: "300px" },
);

function whenVisible(el: Element, load: () => void) {
  lazy.set(el, load);
  observer.observe(el);
}

/** Kuva: suttukuva heti (kertoo myös kuvasuhteen), oikea kuva vasta näkyviin tullessa. */
function imageFigure(k: Kude, r: Resource, onClick?: () => void): HTMLElement {
  const frame = h("div", { class: "kehys" });
  const preview = k.previewOf(r.hash);
  if (preview) {
    void urlFor(k, k.get(preview)!).then((u) => {
      const blur = h("img", { class: "suttu", src: u, alt: "" });
      blur.onload = () => {
        if (!frame.style.aspectRatio) frame.style.aspectRatio = `${blur.naturalWidth} / ${blur.naturalHeight}`;
      };
      frame.prepend(blur);
    }, fail);
  }
  whenVisible(frame, () => {
    urlFor(k, r).then((u) => {
      const img = h("img", { class: "taysi", src: u, alt: "", decoding: "async" });
      img.onload = () => {
        frame.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        img.classList.add("valmis");
      };
      frame.append(img);
    }, fail);
  });
  return h("figure", { class: "kuva", onclick: onClick }, frame);
}

/** Yhden resurssin sisältö blogissa. */
function resourceBody(k: Kude, r: Resource): HTMLElement {
  if (r.mime.startsWith("image/")) return imageFigure(k, r);
  if (r.mime.startsWith("video/") || r.mime.startsWith("audio/")) {
    const el = h(r.mime.startsWith("video/") ? "video" : "audio", { controls: true, preload: "metadata" });
    void urlFor(k, r).then((u) => (el.src = u), fail);
    return el;
  }
  const box = h("div", { class: "teksti" });
  if (r.mime === "text/markdown" || r.mime === "text/plain") {
    k.text(r.hash).then(
      (t) => (box.innerHTML = r.mime === "text/plain" ? `<p>${escapeHtml(t)}</p>` : renderBlock(t)),
      fail,
    );
  } else if (r.mime.includes("json")) {
    k.text(r.hash).then((t) => box.replaceChildren(jsonCard(t)), fail);
  } else {
    const a = h("a", { download: `${r.hash.slice(0, 7)}` }, `${r.mime} – lataa`);
    void urlFor(k, r).then((u) => (a.href = u), fail);
    box.append(a);
  }
  return box;
}

/** schema.org-olio kortiksi, esimerkiksi varuste painoineen. */
function jsonCard(text: string): HTMLElement {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const w = o.weight as { value?: number; unitCode?: string } | undefined;
    return h(
      "div",
      { class: "kortti" },
      h("strong", {}, String(o.name ?? o["@type"] ?? "olio")),
      w?.value !== undefined ? ` · ${w.value} ${w.unitCode === "GRM" ? "g" : (w.unitCode ?? "")}` : "",
      o.description ? h("p", {}, String(o.description)) : null,
    );
  } catch {
    return h("pre", {}, text);
  }
}

function sourceLine(k: Kude, hash: string): HTMLElement | null {
  const list = sources(k, hash);
  if (!list.length) return null;
  return h(
    "p",
    { class: "lahde" },
    "lähde: ",
    ...list.flatMap((s, i) => [
      i ? ", " : "",
      /^https?:/.test(s) ? h("a", { href: s, target: "_blank", rel: "noopener" }, s) : h("code", {}, s.length > 40 ? `${s.slice(0, 40)}…` : s),
    ]),
  );
}

// ---- näkymät ----

async function header(k: Kude): Promise<HTMLElement> {
  const meta = await k.meta();
  const [startKey, endKey] = dateKeys(String(meta["@type"] ?? ""));
  const start = meta[startKey] as string | undefined;
  const end = meta[endKey] as string | undefined;
  const badge = h("span", { class: "merkki" }, "…");
  if (state.dirty) {
    badge.textContent = "muokattu, tallentamatta";
  } else if (!k.head.signature) {
    badge.textContent = k.head.author ? `tekijä ${shortDid(k.head.author)} (ei allekirjoitusta)` : "allekirjoittamaton";
  } else {
    verify(k, { resources: false }).then((v) => {
      badge.textContent = v.signatureOk ? `✓ allekirjoittanut ${shortDid(v.author!)}` : "⚠ allekirjoitus ei täsmää";
      badge.classList.add(v.signatureOk ? "ok" : "varoitus");
      badge.title = v.author ?? "";
    }, fail);
  }
  return h(
    "header",
    { class: "kuteen-otsake" },
    h("h1", {}, String(meta.name ?? "Nimetön")),
    h(
      "p",
      { class: "meta" },
      [meta["@type"], [start && formatTime(start), end && end !== start && formatTime(end)].filter(Boolean).join("–")]
        .filter(Boolean)
        .join(" · "),
    ),
    meta.description ? h("p", { class: "kuvaus" }, String(meta.description)) : null,
    badge,
  );
}

async function blogView(k: Kude): Promise<HTMLElement> {
  const short = shortHashes(k.resources.map((r) => r.hash));
  const article = h("article", { class: "blogi" }, await header(k));
  const items = blog(k);
  if (!items.length) article.append(h("p", { class: "tyhja" }, "Kuteessa ei ole vielä paloja. Lisää niitä Muokkaa-näkymässä."));
  for (const r of items) {
    article.append(
      h(
        "section",
        { class: `pala${state.focus === r.hash ? " korostus" : ""}`, id: `r-${short.get(r.hash)}` },
        resourceBody(k, r),
        sourceLine(k, r.hash),
      ),
    );
  }
  return article;
}

function goToBlog(hash: string) {
  state.focus = hash;
  state.view = "blogi";
  void render().then(() => {
    const k = state.kude!;
    const s = shortHashes(k.resources.map((r) => r.hash)).get(hash);
    document.getElementById(`r-${s}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

async function galleryView(k: Kude): Promise<HTMLElement> {
  const images = gallery(k);
  return h(
    "section",
    { class: "galleria-nakyma" },
    await header(k),
    images.length
      ? h(
          "div",
          { class: "galleria" },
          ...images.map((r) =>
            h(
              "div",
              { class: "galleria-kohta" },
              imageFigure(k, r, () => goToBlog(r.hash)),
              h("span", { class: "aika" }, formatTime(r.time)),
            ),
          ),
        )
      : h("p", { class: "tyhja" }, "Ei kuvia."),
  );
}

async function timelineView(k: Kude): Promise<HTMLElement> {
  const list = h("ol", { class: "aikajana" });
  let lastDay = "";
  for (const r of timeline(k)) {
    const day = r.time ? new Date(r.time).toLocaleDateString("fi-FI", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "ilman aikaa";
    if (day !== lastDay) {
      list.append(h("li", { class: "paiva" }, day));
      lastDay = day;
    }
    const label = h("span", { class: "katkelma" }, r.mime);
    if (r.mime.startsWith("text/")) {
      k.text(r.hash).then((t) => (label.textContent = t.replace(/^#+\s*/, "").slice(0, 120)), fail);
    } else if (r.mime.startsWith("image/")) {
      label.textContent = "kuva";
    }
    list.append(
      h(
        "li",
        { class: "tapahtuma", onclick: () => goToBlog(r.hash), tabindex: 0 },
        h("time", {}, formatTime(r.time, false) || "–"),
        h("span", { class: "laji" }, r.mime.split("/")[0]!),
        label,
      ),
    );
  }
  return h("section", {}, await header(k), list);
}

// ---- editori ----

/** Tyypin päivämääräkentät schema.org-sanastosta. */
function dateKeys(type: string): [string, string] {
  if (type === "Trip") return ["departureTime", "arrivalTime"];
  if (type === "BlogPosting" || type === "Article") return ["datePublished", "dateModified"];
  return ["startDate", "endDate"];
}

const TYPES = ["BlogPosting", "Trip", "Collection", "ItemList", "Event", "Place", "CreativeWork", "Accommodation"];

/** Muutos kuteeseen: vanha allekirjoitus ei enää koske sisältöä. */
async function mutate(fn: (k: Kude) => Promise<unknown> | unknown, { rerender = true } = {}) {
  const k = state.kude!;
  try {
    await fn(k);
    state.dirty = true;
    k.head.signature = undefined;
    if (rerender) await render();
    else updateChrome();
  } catch (e) {
    fail(e);
    if (rerender) await render();
  }
}

async function metaForm(k: Kude): Promise<HTMLElement> {
  const meta = await k.meta();
  const field = (label: string, input: HTMLElement) => h("label", { class: "kentta" }, h("span", {}, label), input);
  const name = h("input", { value: String(meta.name ?? ""), placeholder: "Otsikko" });
  const type = h("input", { value: String(meta["@type"] ?? ""), list: "tyypit" });
  const [sk, ek] = dateKeys(String(meta["@type"] ?? ""));
  const start = h("input", { type: "date", value: String(meta[sk] ?? "").slice(0, 10) });
  const end = h("input", { type: "date", value: String(meta[ek] ?? "").slice(0, 10) });
  const desc = h("textarea", { rows: 2, placeholder: "Lyhyt kuvaus" });
  desc.value = String(meta.description ?? "");
  const license = h("input", { value: String(meta.license ?? ""), placeholder: "esim. https://creativecommons.org/licenses/by/4.0/" });

  const save = () =>
    mutate(
      async (kk) => {
        const current = await kk.meta();
        const next: Meta = { ...current };
        const [oldS, oldE] = dateKeys(String(current["@type"] ?? ""));
        delete next[oldS];
        delete next[oldE];
        const set = (key: string, v: string) => {
          if (v.trim()) next[key] = v.trim();
          else delete next[key];
        };
        set("name", name.value);
        set("@type", type.value);
        const [s, e] = dateKeys(type.value.trim());
        set(s, start.value);
        set(e, end.value);
        set("description", desc.value);
        set("license", license.value);
        if (state.signer && !next.author) next.author = state.signer.did;
        await kk.setMeta(next, { author: state.signer?.did });
      },
      { rerender: false },
    );
  for (const el of [name, type, start, end, desc, license]) el.addEventListener("change", save);

  return h(
    "fieldset",
    { class: "metatieto" },
    h("legend", {}, "Tiedot"),
    field("Otsikko", name),
    h("div", { class: "rivi" }, field("Tyyppi", type), field("Alkaa", start), field("Päättyy", end)),
    field("Kuvaus", desc),
    field("Lisenssi", license),
    h("datalist", { id: "tyypit" }, ...TYPES.map((t) => h("option", { value: t }))),
  );
}

/** Pieni suttukuva: pisin sivu noin 32 px. Kertoo myös kuvasuhteen. */
async function makePreview(bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const url = URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 32;
    const hgt = img.naturalHeight || 32;
    const scale = 32 / Math.max(w, hgt);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hgt * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.6));
    if (!blob) return undefined;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || "image/png" };
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addImages(files: File[], after: string | null | undefined) {
  await mutate(async (k) => {
    let prev = after;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = file.type || mimeOf(file.name);
      if (!mime.startsWith("image/")) {
        toast(`${file.name}: ei kuva, ohitettiin`, "virhe");
        continue;
      }
      const info = readImageInfo(bytes);
      const time = info.time ?? new Date(file.lastModified).toISOString();
      try {
        const r = await k.append(bytes, mime, { time, author: state.signer?.did, after: prev });
        const p = await makePreview(bytes, mime);
        if (p) await k.setPreview(r.hash, p.bytes, p.mime);
        prev = r.hash;
      } catch (e) {
        if (e instanceof KudeError) toast(`${file.name}: ${e.message}`, "virhe");
        else throw e;
      }
    }
  });
}

function pickImages(after: string | null | undefined) {
  const input = h("input", { type: "file", accept: "image/*", multiple: true });
  input.onchange = () => void addImages([...(input.files ?? [])], after);
  input.click();
}

/** Tekstilohkon tallennus. Tyhjä rivi jakaa tekstin useaksi palaksi. */
async function saveText(k: Kude, hash: string | undefined, value: string, after: string | null | undefined) {
  const blocks = splitMarkdown(value);
  const author = state.signer?.did;
  if (hash && !blocks.length) {
    k.remove(hash);
    return;
  }
  let prev: string | null | undefined = after;
  for (const [i, b] of blocks.entries()) {
    const r = i === 0 && hash ? await k.edit(hash, utf8(b), { author }) : await k.append(utf8(b), "text/markdown", { author, after: prev });
    prev = r.hash;
  }
}

function autosize(t: HTMLTextAreaElement) {
  const fit = () => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  };
  t.addEventListener("input", fit);
  requestAnimationFrame(fit);
}

function insertBar(after: string | null): HTMLElement {
  return h(
    "div",
    { class: "lisaa" },
    h("button", { type: "button", onclick: () => ((state.draftAfter = after), void render()) }, "+ teksti"),
    h("button", { type: "button", onclick: () => pickImages(after) }, "+ kuva"),
  );
}

function draftBlock(after: string | null): HTMLElement {
  const t = h("textarea", { class: "luonnos", placeholder: "Kirjoita… (tyhjä rivi aloittaa uuden palan)", rows: 3 });
  autosize(t);
  t.addEventListener("blur", () => {
    const value = t.value;
    state.draftAfter = undefined;
    if (!value.trim()) return void render();
    void mutate((k) => saveText(k, undefined, value, after));
  });
  requestAnimationFrame(() => t.focus());
  return h("div", { class: "lohko luonnos-lohko" }, t);
}

async function blockEditor(k: Kude, r: Resource, index: number, count: number): Promise<HTMLElement> {
  let hash = r.hash;
  const label = h("code", { class: "hash", title: hash }, hash.slice(0, 7));
  const body = h("div", { class: "lohko-sisalto" });
  const tools = h(
    "div",
    { class: "tyokalut" },
    h("span", { class: "laji" }, r.mime),
    label,
    h("span", { class: "vali" }),
    h("button", { type: "button", title: "Ylös", disabled: index === 0, onclick: () => mutate((kk) => kk.move(hash, kk.chain()[index - 2] ?? null)) }, "↑"),
    h("button", { type: "button", title: "Alas", disabled: index === count - 1, onclick: () => mutate((kk) => kk.move(hash, kk.chain()[index + 1]!)) }, "↓"),
    h("button", { type: "button", title: "Poista", class: "poista", onclick: () => mutate((kk) => kk.remove(hash)) }, "✕"),
  );

  if (r.mime === "text/markdown" || r.mime === "text/plain") {
    const t = h("textarea", { rows: 2 });
    t.value = await k.text(hash);
    autosize(t);
    t.addEventListener("change", () => {
      const value = t.value;
      const blocks = splitMarkdown(value);
      // Yksi pala: päivitetään paikallaan, jotta fokus ei katoa uudelleenpiirrossa.
      if (blocks.length === 1) {
        void mutate(
          async (kk) => {
            const next = await kk.edit(hash, utf8(blocks[0]!), { author: state.signer?.did });
            hash = next.hash;
            label.textContent = hash.slice(0, 7);
            label.title = hash;
          },
          { rerender: false },
        );
      } else {
        void mutate((kk) => saveText(kk, hash, value, undefined));
      }
    });
    body.append(t);
  } else if (r.mime.startsWith("image/")) {
    body.append(imageFigure(k, r));
    const bytes = await k.load(hash);
    const info = readImageInfo(bytes);
    const facts = h("p", { class: "kuvatiedot" }, info.time ? `kuvattu ${formatTime(info.time)}` : `aika ${formatTime(r.time)}`);
    if (info.gps) {
      facts.append(
        " · ",
        h("span", { class: "sijainti" }, "📍 sisältää sijainnin"),
        " ",
        h(
          "button",
          { type: "button", onclick: () => mutate(async (kk) => kk.edit(hash, stripLocation(await kk.load(hash)))) },
          "Poista sijainti",
        ),
      );
    }
    body.append(facts);
  } else {
    body.append(resourceBody(k, r));
  }
  return h("div", { class: "lohko" }, tools, body, sourceLine(k, hash));
}

async function editView(k: Kude): Promise<HTMLElement> {
  const chain = blog(k);
  const list = h("div", { class: "lohkot" });
  if (state.draftAfter === null) list.append(draftBlock(null));
  list.append(insertBar(null));
  for (const [i, r] of chain.entries()) {
    list.append(await blockEditor(k, r, i, chain.length));
    if (state.draftAfter === r.hash) list.append(draftBlock(r.hash));
    list.append(insertBar(r.hash));
  }
  if (!chain.length && state.draftAfter === undefined) {
    list.append(h("p", { class: "tyhja" }, "Aloita kirjoittamalla tai pudota kuvia tähän."));
  }
  return h("section", { class: "editori" }, await metaForm(k), list, keyPanel());
}

function keyPanel(): HTMLElement {
  const s = state.signer;
  return h(
    "details",
    { class: "avain" },
    h("summary", {}, s ? `Tekijä: ${shortDid(s.did)}` : "Tekijä ja allekirjoitus"),
    s
      ? h(
          "div",
          {},
          h("p", {}, "Kude allekirjoitetaan tallennettaessa tällä avaimella:"),
          h("code", { class: "did" }, s.did),
          h("p", { class: "huom" }, "Avain on vain tämän selaimen muistissa. Kadonnut avain on kadonnut identiteetti, joten ota siitä kopio."),
          h("button", { type: "button", onclick: exportKey }, "Lataa avain talteen"),
        )
      : h(
          "div",
          {},
          h("p", {}, "Allekirjoitus todistaa, kuka kuteen teki. Tekijä on did:key-tunniste."),
          h("button", { type: "button", onclick: createKey }, "Luo avain"),
          " ",
          h("button", { type: "button", onclick: importKey }, "Tuo avain"),
        ),
  );
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

async function loadKey() {
  try {
    const raw = storage()?.getItem(KEY_STORAGE);
    if (raw) state.signer = await signerFromJwk(JSON.parse(raw) as JsonWebKey);
  } catch (e) {
    console.warn("avainta ei voitu ladata", e);
  }
}

async function useJwk(jwk: JsonWebKey) {
  state.signer = await signerFromJwk(jwk);
  try {
    storage()?.setItem(KEY_STORAGE, JSON.stringify(jwk));
  } catch {
    toast("Avainta ei voitu tallentaa selaimeen; se on käytössä vain tämän istunnon ajan.", "virhe");
  }
  await render();
}

async function createKey() {
  try {
    await useJwk((await generateKeyPair()).privateJwk);
    toast("Avain luotu. Lataa se talteen.");
  } catch (e) {
    fail(e);
  }
}

function importKey() {
  const input = h("input", { type: "file", accept: ".json,application/json" });
  input.onchange = async () => {
    try {
      const f = input.files?.[0];
      if (f) await useJwk(JSON.parse(await f.text()) as JsonWebKey);
    } catch (e) {
      fail(e);
    }
  };
  input.click();
}

function exportKey() {
  const raw = storage()?.getItem(KEY_STORAGE);
  if (!raw) return toast("Avainta ei löytynyt selaimen muistista.", "virhe");
  download(utf8(JSON.stringify(JSON.parse(raw), null, 2)), "kude-avain.json", "application/json");
}

// ---- avaus ja tallennus ----

function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function setKude(k: Kude, fileName: string, view?: View) {
  resetUrls();
  state.kude = k;
  state.fileName = fileName;
  state.dirty = false;
  state.focus = undefined;
  state.draftAfter = undefined;
  if (view) state.view = view;
  await render();
}

async function openFile(file: File) {
  try {
    await setKude(await open(fromBytes(new Uint8Array(await file.arrayBuffer()))), file.name, "blogi");
  } catch (e) {
    fail(e);
  }
}

async function openUrl(url: string) {
  state.loading = url;
  await render();
  try {
    const k = await open(fromUrl(url));
    state.loading = undefined;
    await setKude(k, decodeURIComponent(url.split("/").pop()?.split("?")[0] || "kude.kude"), "blogi");
  } catch (e) {
    state.loading = undefined;
    fail(e);
    await render();
  }
}

async function newKude() {
  if (state.dirty && !confirm("Hylätäänkö tallentamattomat muutokset?")) return;
  const author = state.signer?.did;
  const k = await Kude.create(
    { "@type": "BlogPosting", name: "Nimetön", datePublished: new Date().toISOString().slice(0, 10), ...(author ? { author } : {}) },
    { author },
  );
  await setKude(k, "uusi.kude", "muokkaa");
  state.dirty = true;
  updateChrome();
}

function pickKude() {
  const input = h("input", { type: "file", accept: ".kude,application/x-kude" });
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void openFile(f);
  };
  input.click();
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "kude";

/** Tarkistus ennen julkaisua: sijainnilliset kuvat näytetään, ja tekijä valitsee. */
async function privacyCheck(k: Kude): Promise<string[] | undefined> {
  await k.loadAll();
  const located: Resource[] = [];
  for (const r of k.resources) {
    if (r.mime === "image/jpeg" && !k.isPreview(r.hash) && readImageInfo(r.bytes!).gps) located.push(r);
  }
  if (!located.length) return [];
  return new Promise((resolve) => {
    const keep = new Set<string>();
    const dialog = h(
      "dialog",
      { class: "tarkistus" },
      h("h2", {}, "Ennen tallennusta"),
      h("p", {}, `${located.length} kuvassa on sijainti. Kuva, joka on otettu kotona, kertoo kodin osoitteen.`),
      h(
        "div",
        { class: "tarkistus-kuvat" },
        ...located.map((r) => {
          const gps = readImageInfo(r.bytes!).gps!;
          const box = h("input", { type: "checkbox", onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? keep.add(r.hash) : keep.delete(r.hash)) });
          return h(
            "label",
            { class: "tarkistus-kuva" },
            imageFigure(k, r),
            h("span", {}, box, " julkaise sijainnin kanssa"),
            h("small", {}, `${gps.lat?.toFixed(4)}, ${gps.lon?.toFixed(4)}`),
          );
        }),
      ),
      h(
        "div",
        { class: "painikkeet" },
        h("button", { type: "button", onclick: () => (dialog.close(), resolve(undefined)) }, "Peruuta"),
        h(
          "button",
          { type: "button", class: "ensisijainen", onclick: () => (dialog.close(), resolve(located.map((r) => r.hash).filter((x) => !keep.has(x)))) },
          "Tallenna",
        ),
      ),
    );
    dialog.addEventListener("cancel", () => resolve(undefined));
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function save() {
  const k = state.kude;
  if (!k) return;
  try {
    const strip = await privacyCheck(k);
    if (!strip) return;
    for (const hash of strip) await k.edit(hash, stripLocation(await k.load(hash)));
    const bytes = await encode(k, { signer: state.signer });
    const meta = await k.meta();
    const name = state.fileName === "uusi.kude" ? `${slug(String(meta.name ?? "kude"))}.kude` : state.fileName;
    download(bytes, name, "application/x-kude");
    const view = state.view;
    await setKude(await open(bytes), name, view);
    toast(`Tallennettu ${name}${state.signer ? ", allekirjoitettu" : ""}${strip.length ? `, sijainti poistettu ${strip.length} kuvasta` : ""}.`);
  } catch (e) {
    fail(e);
  }
}

// ---- runko ----

function updateChrome() {
  const name = document.querySelector(".tiedosto");
  if (name) name.textContent = `${state.fileName}${state.dirty ? " •" : ""}`;
  document.title = state.kude ? `${state.fileName} – kude` : "kude";
}

function topBar(): HTMLElement {
  const k = state.kude;
  return h(
    "nav",
    { class: "ylapalkki" },
    h("span", { class: "nimi" }, "kude"),
    k ? h("span", { class: "tiedosto" }, "") : null,
    h(
      "div",
      { class: "toiminnot" },
      h("button", { type: "button", onclick: newKude }, "Uusi"),
      h("button", { type: "button", onclick: pickKude }, "Avaa"),
      k ? h("button", { type: "button", class: "ensisijainen", onclick: save }, "Tallenna") : null,
    ),
    k
      ? h(
          "div",
          { class: "valilehdet", role: "tablist" },
          ...VIEWS.map(([v, label]) =>
            h(
              "button",
              {
                type: "button",
                role: "tab",
                "aria-selected": String(state.view === v),
                class: state.view === v ? "valittu" : "",
                onclick: () => ((state.view = v), (state.focus = undefined), void render()),
              },
              label,
            ),
          ),
        )
      : null,
  );
}

function welcome(): HTMLElement {
  const url = h("input", { type: "url", placeholder: "https://…/seikkailu.kude" });
  return h(
    "section",
    { class: "tervetuloa" },
    h("h1", {}, "Kude"),
    h("p", { class: "johdanto" }, "Pieni tiedosto, jossa on vain resursseja ja linkkejä. Avaa kude tai aloita uusi. Voit myös pudottaa .kude-tiedoston tähän."),
    h(
      "div",
      { class: "painikkeet" },
      h("button", { type: "button", class: "ensisijainen", onclick: newKude }, "Uusi kude"),
      h("button", { type: "button", onclick: pickKude }, "Avaa tiedosto"),
      h("button", { type: "button", onclick: () => void openUrl("esimerkit/seikkailu.kude") }, "Avaa esimerkki"),
    ),
    h(
      "form",
      {
        class: "url-lomake",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (url.value) {
            history.replaceState(null, "", `?src=${encodeURIComponent(url.value)}`);
            void openUrl(url.value);
          }
        },
      },
      url,
      h("button", { type: "submit" }, "Avaa osoitteesta"),
    ),
  );
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const k = state.kude;
  let main: HTMLElement;
  try {
    if (state.loading) main = h("p", { class: "lataa" }, `Ladataan ${state.loading}…`);
    else if (!k) main = welcome();
    else if (state.view === "blogi") main = await blogView(k);
    else if (state.view === "galleria") main = await galleryView(k);
    else if (state.view === "aikajana") main = await timelineView(k);
    else main = await editView(k);
  } catch (e) {
    fail(e);
    main = h("p", { class: "tyhja" }, "Näkymää ei voitu piirtää.");
  }
  if (token !== renderToken) return; // uudempi piirto on jo menossa
  app.replaceChildren(topBar(), h("main", {}, main));
  updateChrome();
}

// Pudotus: .kude avataan, kuvat lisätään muokattavaan kuteeseen.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("pudotus");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("pudotus");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("pudotus");
  const files = [...(e.dataTransfer?.files ?? [])];
  const kude = files.find((f) => f.name.endsWith(".kude"));
  if (kude) return void openFile(kude);
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  if (!state.kude) return toast("Avaa tai luo kude ennen kuvien lisäämistä.", "virhe");
  state.view = "muokkaa";
  void addImages(images, undefined);
});
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

void (async () => {
  await loadKey();
  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  const view = VIEWS.find(([v]) => v === params.get("nakyma"))?.[0];
  if (src) {
    await openUrl(src);
    if (view && state.kude) {
      state.view = view;
      await render();
    }
  } else await render();
})();
