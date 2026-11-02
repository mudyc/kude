# Kude — Technical Description

Version 1 of the format, as implemented in this repository.

A **kude** (Finnish for *weft*, the thread that runs through the warp and binds a fabric together) is a small file that contains only two kinds of things:

- **Resources**: byte sequences such as a text fragment, an image or a metadata object. A resource is named by the hash of its bytes.
- **Links**: triples of *from*, *predicate* and *to*. The predicate gives the link its meaning.

Everything a reader sees — a blog post, a gallery, a timeline — is a *view* computed from these two tables. Views are never stored.

This document covers the data model, the binary format, addressing, signing, the unpacked directory format, the canonical splitter and how the reference implementation reads and edits kudes.

---

## 1. Design criteria

The core is only acceptable if it meets all five of these criteria:

1. **Fits on half a page**, like git (four object types and a hash) or the web (URL, HTTP, HTML).
2. **Needs no new server.** A static file server, a CDN or a git host is enough.
3. **Is useful to one person immediately**, before anyone else participates, even when nothing is published.
4. **Is fast on mobile.** Few bytes before the first view, not just few round trips.
5. **Needs no separate linking work.** Links come from what people do anyway: writing, pasting, photographing. The editor writes the links; users never see triples.

---

## 2. Data model

### 2.1 Resources

| Field | Type | Meaning |
|---|---|---|
| `hash` | 64 lowercase hex chars | SHA-256 of the resource bytes; the resource's identity |
| `mime` | string | Media type, e.g. `text/markdown`, `image/jpeg` |
| `time` | ISO 8601 string, optional | When the content came into being (writing time, EXIF capture time, …) |
| `author` | DID string, optional | Who made the resource |
| `offset`, `length` | integers, optional | Location of embedded bytes in the data section |
| `url` | string, optional | Location of a *linked* resource whose bytes live outside the kude |

A resource is either **embedded** (it has `offset` and `length`) or **linked** (it has `url`). In both cases `hash` is the hash of the actual bytes, so a linked resource can be verified after it has been fetched.

The core has no place or other coordinates. Time is a property of the resource, not a link.

Identical bytes give an identical hash, so the same content is the same resource. Adding a resource whose hash already exists returns the existing resource.

### 2.2 The root

The resource on **row 0** is the root: the kude's metadata as a JSON object whose keys and type come from the schema.org vocabulary. Its media type is `application/ld+json`. Reading starts from the root.

```json
{
  "@context": "https://schema.org",
  "@type": "Trip",
  "name": "Three days in the wilderness",
  "departureTime": "2026-08-14",
  "arrivalTime": "2026-08-16",
  "description": "A three-day hike on the fells."
}
```

The `@context` key makes the root valid JSON-LD. Viewers read the keys directly and need no JSON-LD processing. If `@context` is missing when the root is written, the implementation adds `"@context": "https://schema.org"`. The root bytes are `JSON.stringify(meta, null, 2)`.

The root's `@type` is a contract. It tells the editor which blocks to offer and the viewer which views make sense, e.g. `Trip`, `BlogPosting` or `ItemList`.

### 2.3 Links

| Field | Meaning |
|---|---|
| `from` | Source end |
| `predicate` | Meaning of the link |
| `to` | Target end |

A link end is one of:

- the full hash of a resource in the same kude (held in memory as 64 hex chars);
- the full hash of a resource that is *not* in the kude, e.g. the old version behind a `korvaa` link;
- an address (see §5): `kude:…`, `https://…` and so on.

Links are a set: adding a link that already exists is a no-op.

### 2.4 Core predicates

The core knows five predicates. Four build reading order and history; one makes the first view instant. They are written by the editor and never shown to users.

| Predicate | From → to | Meaning |
|---|---|---|
| `alku` ("start") | root → piece | First piece in reading order |
| `seuraava` ("next") | piece → piece | Reading order of the blog |
| `lähde` ("source") | piece → URL or kude address | Where pasted or imported content came from |
| `korvaa` ("replaces") | new version → old version | An edit; a link to the old version can find the new one |
| `esikatselu` ("preview") | image → blurred image, series → reduced series | Small embedded version shown immediately |

All other predicates are URIs, for example from schema.org (`schema:about`, `schema:author`). A viewer that does not know a predicate shows the link as a plain link or ignores it.

The model is the RDF triple, but the nodes are content hashes. The lesson from the semantic web is applied: the core vocabulary stays tiny, and nobody writes triples by hand.

---

## 3. Reading order and editing semantics

### 3.1 Chain

The **chain** is the blog's reading order:

1. Start at the target of the first `alku` link from the root.
2. Repeatedly follow the first `seuraava` link from the current piece.
3. Stop when a target is missing from the kude or has already been visited (cycle guard).

### 3.2 Operations

These are the editing operations of `Kude` in `src/core/model.ts`.

| Operation | Effect on resources | Effect on links |
|---|---|---|
| `append(bytes, mime, {after})` | Adds the resource | Inserts it into the chain after `after` (`null` = at the start, omitted = at the end) |
| `move(hash, after)` | None | Only the `seuraava`/`alku` links that actually change: at most three are replaced |
| `edit(hash, bytes)` | New resource replaces the old one at the same row; the old resource leaves the kude | All non-`korvaa` links to and from the old hash are rewritten to the new hash; `new korvaa old` is added |
| `remove(hash)` | Removes the resource and any preview no longer referenced | Chain is joined around it; all links touching it are removed |
| `setMeta(meta)` | Root replaced in place (row 0) | Links rewritten to the new root hash; no `korvaa` |
| `setPreview(hash, bytes, mime)` | Adds the preview resource | Replaces any existing `esikatselu` link from `hash` |
| `copyFrom(other, hash, source)` | Copies the resource unchanged (same hash) along with its preview | Adds `hash lähde source` |

Notes:

- **Version chains.** `korvaa` links are never rewritten, so repeated edits form a chain C → B → A.
- **Edit times.** When a text piece is edited, `time` becomes the edit moment. Any other resource keeps its original time unless a time is given.
- **Duplicates.** Placing a hash in the chain twice is rejected (`KudeError`). The same content gives the same hash, which would make the chain branch. How common real duplicates are is an open question.
- **Signatures.** Any mutation makes an existing signature invalid. Re-encoding without a signer drops it.

---

## 4. Binary format

A kude file is modelled on glTF's binary container (GLB). It is a fixed 12-byte header followed by chunks. All integers are unsigned 32-bit little-endian.

```
offset  size  field
0       4     magic    0x4544554B  (bytes "KUDE")
4       4     version  1
8       4     total length of the file in bytes

then, repeated:
+0      4     chunk data length (including padding)
+4      4     chunk type
+8      n     chunk data, padded to a multiple of 4 bytes
```

| Chunk | Type value | Bytes | Padding | Content |
|---|---|---|---|---|
| `HEAD` | `0x44414548` | `HEAD` | spaces (0x20) | JSON: author, signature algorithm, signature |
| `JSON` | `0x4E4F534A` | `JSON` | spaces (0x20) | The description: resources and links tables |
| `BIN`  | `0x004E4942` | `BIN\0` | zeros (0x00) | Embedded resource bytes, concatenated |

The writer always emits `HEAD`, `JSON`, `BIN` in that order. A reader:

- rejects a wrong magic number or an unsupported version;
- parses `HEAD` and `JSON`;
- records where the `BIN` data starts and **stops reading there**, so resource bytes are fetched on demand;
- skips chunks of unknown type.

The description comes before the bytes, so a viewer can draw the reading order as soon as a few kilobytes have arrived.

### 4.1 HEAD

```json
{"author":"did:key:z6Mk…","alg":"Ed25519","signature":"<base64url, no padding>"}
```

All keys are optional. An unsigned kude may carry `author` without `signature`. Unknown keys are preserved when the file is re-encoded.

### 4.2 Description (JSON chunk)

The description has two tables. Each table is stored with its column names, so new columns can be added without breaking old readers:

```json
{
  "resources": {
    "columns": ["hash", "mime", "time", "author", "offset", "length", "url"],
    "rows": [
      ["9f2c4e1…(64 hex)", "application/ld+json", "2026-08-17T10:00:00+03:00", null, 0, 214, null],
      ["a1b2c3d…(64 hex)", "text/markdown", "2026-08-14T08:30:00+03:00", null, 214, 98, null],
      ["5e6f7a8…(64 hex)", "image/jpeg", "2026-08-14T09:41:00+03:00", null, 9120, 184233, null]
    ]
  },
  "links": {
    "columns": ["from", "predicate", "to"],
    "rows": [
      ["9f2c4e1", "alku", "a1b2c3d"],
      ["a1b2c3d", "seuraava", "5e6f7a8"],
      ["5e6f7a8", "esikatselu", "77aa0c3"]
    ]
  }
}
```

Rules:

- **Missing values** are `null`.
- **`offset`** is relative to the start of the `BIN` chunk data. A linked resource has `offset` and `length` set to `null` and `url` set.
- **`hash` in the resources table** is always the full 64-character SHA-256.
- **Link ends** that refer to a resource in the kude are written as the **shortest unique prefix** among the kude's resource hashes, at least 7 characters (as in git). A full hash that refers to a resource *not* in the kude is written in full. Anything else (addresses) is written as is.
- **On read**, a link end of 7–63 hex characters is resolved against the resource hashes by unique prefix. A 64-character end is kept as is. An unresolvable end is kept unchanged.
- **Extra columns** in either table are read into an `extra` map on the resource or link and written back. Missing extra values are written as `null`.
- **Extra top-level keys** in the description are preserved.

### 4.3 Data section order

Embedded bytes are laid out so that the first view comes from the start of the file:

1. the root;
2. light resources (anything that is not heavy media), in chain order, then resources outside the chain;
3. heavy media (`image/*`, `video/*`, `audio/*` that are not previews), in chain order, then the rest.

The order of rows in the resources table does not change; only offsets reflect this layout.

### 4.4 Identity

The kude's identity is the SHA-256 of the `JSON` chunk data **including its padding**. Its address is:

```
kude:<64-hex description hash>
```

Every resource hash is in the description, so this one hash pins the entire content: metadata, order, links and bytes.

### 4.5 Integrity

Every time resource bytes are loaded (embedded or linked), they are hashed and compared with the declared hash. A mismatch is an error. `verify()` loads all embedded resources and also checks the signature.

---

## 5. Addresses

Inside a kude, a short hash is enough. Elsewhere, addresses look like this:

```
a1b2c3d                     resource in the same kude (short hash)
kude:<hash>                 pinned version of a kude (like a git commit)
kude:<author>/<name>        the author's latest version (like a git branch)
kude:<hash>#<short hash>    one resource inside another kude
https://…                   any external resource
```

Parsing rules (`parseAddress` in `src/core/address.ts`):

| Input | Result |
|---|---|
| 7–64 hex chars | `local` |
| `kude:` + 7–64 hex chars, optional `#fragment` | `pinned` |
| `kude:` + anything else | `named`; the author is everything before the last `/`, so `kude:did:key:z6Mk…/trip` works |
| anything else | `url` |

**Resources are the smallest addressable unit.** Text is split into pieces, so pointing into a text means pointing at a piece; no anchor grammar is needed. Type-specific fragments (`#t=42` for media, `#:~:text=` text fragments, CSVW key-based cell references) travel inside the URL untouched, and the core does not interpret them.

**Pinned or following** is a choice of address. An archive pins a version; a living collection follows the latest.

### 5.1 Recursion

Another kude is a resource like any other. `walk(start, loader, {maxDepth})` follows `kude:` links breadth-first:

- **Depth.** The default `maxDepth` is 2, so one link does not load the whole sea.
- **Cycles.** Visited addresses and description hashes are tracked, so a cycle stops the walk, and the same kude reached by two addresses is opened once.
- **Static hosting.** `staticLoader(base)` resolves `kude:<hash>` to `<base>/<hash>.kude` and `kude:<author>/<name>` to `<base>/<author>/<name>.kude`, both URL-encoded.

---

## 6. Authorship and signatures

**Identity** of content is *author + hash*.

**Authors** are `did:key` identifiers for Ed25519 keys. A key needs no registry, but a lost key is a lost identity.

```
did:key:z + base58btc( 0xED 0x01 || 32-byte Ed25519 public key )
```

**Signing:**

```
signature = Ed25519-Sign(privateKey, SHA-256(JSON chunk data including padding))
```

- The signature is stored base64url-encoded without padding in `HEAD.signature`, with `HEAD.alg = "Ed25519"` and `HEAD.author` set to the signer's DID.
- Because the signed hash covers every resource hash, the signature also covers linked content.

**Verification** (`verify()`):

| Situation | Result |
|---|---|
| No signature | `signatureOk` is `undefined`; the kude does not claim to be signed |
| Signature present, `author` or description missing | Failure |
| Unknown `alg` | Failure |
| Otherwise | The public key is decoded from the DID and the signature is checked |

**Keys** are exchanged as JWK (`kty: OKP`, `crv: Ed25519`). Everything uses Web Crypto, which is available in current browsers and Node ≥ 20.

There is no access control in the format, for the same reason there is none in git: once a reader has the bytes, they have them. Access belongs to the storage layer (Drive, S3, a git host). A licence may be declared in the root (`license`) but is not enforced.

---

## 7. Media types and splitters

The core knows two content types, text pieces and images, plus the root. Everything else is a resource that is either linked as a whole or whose internal structure a type-specific splitter exposes as resources and links.

| Type | Status | Time | How it is linked |
|---|---|---|---|
| Metadata (JSON-LD, schema.org) | core, root | in fields (e.g. trip dates) | row 0 |
| Text piece (Markdown) | core, embedded | writing time or set by author | in the `seuraava` chain |
| Image (JPEG, WebP, PNG, SVG, …) | core, embedded | EXIF capture time | like a text piece; blurred preview via `esikatselu` |
| Another kude | core | its root dates | `kude:<hash>` or `kude:<author>/<name>` |
| Video, audio | linked | file creation time | URL; position via the type's own fragment |
| Route / time series (GPX, FIT) | linked, optional | first point | added by the author; reduced series as preview |
| Table (CSV, StatFin) | linked | publication time | URL; cell by key values when columns are described (CSVW) |
| Web page | linked | fetch time | URL, optionally with a text fragment |

A new type does not grow the core: a viewer either can show it or shows a link.

### 7.1 Canonical Markdown splitter

A splitter must be canonical. If two implementations split the same text differently, the piece hashes differ and links miss. The rules (`splitMarkdown` in `src/core/markdown.ts`) are a simplification of CommonMark top-level blocks:

1. Line endings are normalised to `\n`, and trailing spaces and tabs are removed from every line.
2. A blank line separates blocks, except inside a fenced code block (`` ``` `` or `~~~`, up to three leading spaces).
3. An ATX heading line (`#` … `######`) is always a block of its own.
4. A block's bytes are its lines joined with `\n`, UTF-8 encoded, without a trailing newline.

`joinMarkdown` joins blocks with a blank line, so `split(join(blocks)) == blocks`.

Known limitation: a loose list (blank lines between items) splits into one block per item.

The importer (`kude import`) also applies two rules:

- A block consisting only of `![alt](relative/path)` pointing to an existing file becomes an image resource.
- The first heading becomes the root's `name` and is not repeated as a piece.

### 7.2 Images and EXIF

For JPEG, the implementation reads the EXIF APP1 segment:

| Field | Tag(s) | Use |
|---|---|---|
| Capture time | `DateTimeOriginal` (0x9003), falling back to `DateTime` (0x0132); `OffsetTimeOriginal` (0x9011) appended if present | Resource time, as ISO 8601 |
| Orientation | 0x0112 | Reported only |
| GPS | GPS IFD (0x8825): latitude and longitude with N/S/E/W reference | Shown in the privacy check |

**Location removal** (`stripLocation`) is lossless:

- Every GPS IFD entry, and any out-of-line value it points to, is overwritten with zeros.
- The GPS IFD's entry count and next-IFD pointer are set to zero.
- All other bytes are unchanged, so orientation and capture time survive.
- The result has a new hash and so becomes a new resource through the normal `edit` path, which adds a `korvaa` link.

**Previews:** the browser editor draws the image onto a canvas so that the longest side is about 32 px. It encodes the result as WebP, or whatever the browser supports, and links it with `esikatselu`. A preview also tells the viewer the aspect ratio before the real image arrives.

---

## 8. Unpacked directory format

`kude unpack` writes a directory that can be edited by hand and versioned with git:

```
juuri.json        the root (row 0)
a1b2c3d.md        one file per embedded resource: <short hash>.<extension>
resurssit.tsv     columns: tiedosto, hash, mime, aika, tekijä, url  (+ extra columns as JSON)
linkit.tsv        columns: mistä, predikaatti, mihin
```

- **Row order** in `resurssit.tsv` is the resource order; the first row is the root.
- **Link ends** in `linkit.tsv` are file names for embedded resources and addresses or full hashes otherwise.
- **TSV escaping:** `\\`, `\t`, `\n` and `\r` are escaped.

`kude pack` reverses the process:

1. Each listed file is read and hashed.
2. Links are rebuilt from file names.
3. If a file's hash differs from the `hash` column, the file was edited: a `korvaa` link from the new hash to the recorded old hash is added (except for the root).
4. Files not listed in `resurssit.tsv` are reported and ignored.

As a result, editing a paragraph changes one file, and reordering changes only `linkit.tsv`.

---

## 9. Reading over the network

`fromUrl(url)` is a byte source for browsers and Node:

- **First request:** fetches the first 64 KiB with an HTTP `Range` request. The header and description usually fit, and so do the text pieces and previews, because of the data layout in §4.3.
- **Later reads:** reads outside that prefix are separate `Range` requests, one per image as it scrolls into view.
- **Fallbacks:**
  - If the server answers `200` instead of `206`, the whole file is kept in memory and every later read is served from it.
  - If the response is shorter than requested, the file has ended, and the prefix is treated as the whole file.

Hash-named content never changes, so resources can be cached with `Cache-Control: immutable`.

---

## 10. Views

Views are functions of the kude (`src/core/views.ts`); none is stored.

| View | Definition |
|---|---|
| Blog | The chain (§3.1) |
| Gallery | Non-preview `image/*` resources, sorted by `time` |
| Timeline | All resources except the root and previews, sorted by `time` (resources without a time last) |
| Sources | `lähde` targets of a resource |

Clicking an image in the gallery or an entry in the timeline opens the same resource in the blog. No inference is needed, because it is the same resource. Time is the shared join key of all views.

The browser viewer accepts `?src=<url>` to open a kude and `&nakyma=blogi|galleria|aikajana|muokkaa` to choose the view.

---

## 11. Privacy

The goal is narrow: nobody should publish their home location by accident when writing a short text with a photo. The editor changes nothing automatically.

- **Before saving,** JPEGs containing GPS data are listed with their coordinates. The author chooses per image whether to keep the location. Unticked images go through `stripLocation`.
- **Location is not in the core.** Viewers do not use EXIF location; a map only appears if the author links a route.
- **Remaining tension:** the GDPR right to erasure conflicts with permanent hash links. An author can delete their own copy and publish a signed tombstone (not yet implemented), but cannot force others to delete copies.

---

## 12. Reference implementation

```
src/core/         dependency-free library (browser + Node)
  bytes.ts        UTF-8, hex, base64url, base58btc
  hash.ts         SHA-256, shortest unique prefixes, prefix index
  model.ts        Kude, Resource, Link, predicates, editing operations
  format.ts       encode / open / verify / address
  source.ts       ByteSource: in-memory and HTTP Range
  address.ts      address parsing and formatting
  resolve.ts      staticLoader, walk (recursion with depth and cycle guards)
  sign.ts         did:key, Ed25519 key generation, signing, verification
  markdown.ts     canonical splitter
  exif.ts         EXIF time/GPS, lossless location removal
  views.ts        blog, gallery, timeline
  mime.ts         extension ↔ media type
src/web/          viewer and block editor (bundled to web/app.js)
src/cli/kude.ts   command line: info, verify, cat, unpack, pack, import, keygen, sign
examples/         example sources; rakenna.mjs builds web/esimerkit/*.kude
test/             unit tests (vitest)
```

Minimal use of the library:

```ts
import { Kude, encode, open, utf8, blog } from "kude";

const k = await Kude.create({ "@type": "BlogPosting", name: "Hello" });
await k.append(utf8("First paragraph."), "text/markdown");
await k.append(jpegBytes, "image/jpeg", { time: "2026-08-14T09:41:00+03:00" });
const bytes = await encode(k);

const again = await open(bytes);               // or open(fromUrl("https://…/hello.kude"))
for (const r of blog(again)) console.log(r.mime, await again.load(r.hash));
```

---

## 13. Out of scope and open questions

**Out of scope by design:**

- place or coordinates in the core;
- a large vocabulary;
- access control in the format;
- global search, which is aggregator work;
- real-time collaborative editing (collaboration works through branches and merges, as in git);
- views stored in the file.

**Not yet implemented:**

- routes, maps and charts;
- the gear/weight view;
- encryption, with the key carried in the URL fragment;
- tombstones;
- a resolver for `kude:<author>/<name>` beyond static hosting;
- a local index that notices changed files on disk;
- previews from the command line, because Node has no canvas.

**Open questions:**

| Question | Current direction |
|---|---|
| Piece size | A piece is an editor block: a paragraph or a heading |
| Same piece twice | Rejected for now; measure on real data first |
| Canonical splitter | Strict per-type rules, e.g. CommonMark top-level blocks |
| Type contract | The root `@type` and resource types are schema.org classes; no validation (SHACL) in the core |
| Identity registry | Start with `did:key`; the author is written into the signature so that later migration is possible |
| Cross-owner links | Copies are pinned on purpose; the `korvaa` chain tells about newer versions to those with access |
