/**
 * JPEG-kuvan EXIF: kuvaushetki aikaleimaksi ja sijainti yksityisyystarkistukseen.
 * Sijainti poistetaan häviöttömästi: GPS-hakemiston kentät ja arvot nollataan,
 * muu EXIF (esim. kuvan suunta) säilyy. Poisto tekee kuvasta uuden resurssin uudella hashilla.
 */

export interface ImageInfo {
  /** Kuvaushetki ISO-muodossa, aikavyöhykkeellä jos kamera kertoi sen. */
  time?: string;
  gps?: { lat?: number; lon?: number };
  orientation?: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const TAG = {
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  dateTime: 0x0132,
  dateTimeOriginal: 0x9003,
  offsetTimeOriginal: 0x9011,
  orientation: 0x0112,
} as const;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Arvon sijainti TIFF-alun suhteen. */
  valueAt: number;
  entryAt: number;
}

class Tiff {
  readonly view: DataView;
  readonly little: boolean;
  constructor(
    readonly bytes: Uint8Array,
    readonly start: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = this.view.getUint16(start);
    if (order !== 0x4949 && order !== 0x4d4d) throw new Error("ei TIFF-otsaketta");
    this.little = order === 0x4949;
    if (this.u16(2) !== 42) throw new Error("ei TIFF-otsaketta");
  }
  u16 = (at: number) => this.view.getUint16(this.start + at, this.little);
  u32 = (at: number) => this.view.getUint32(this.start + at, this.little);
  get ifd0() {
    return this.u32(4);
  }
  entries(ifd: number): Entry[] {
    if (ifd <= 0 || this.start + ifd + 2 > this.bytes.length) return [];
    const n = this.u16(ifd);
    const out: Entry[] = [];
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + i * 12;
      if (this.start + at + 12 > this.bytes.length) break;
      const type = this.u16(at + 2);
      const count = this.u32(at + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      out.push({ tag: this.u16(at), type, count, valueAt: size <= 4 ? at + 8 : this.u32(at + 8), entryAt: at });
    }
    return out;
  }
  ascii(e: Entry): string {
    let s = "";
    for (let i = 0; i < e.count; i++) {
      const c = this.bytes[this.start + e.valueAt + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  rationals(e: Entry): number[] {
    const out: number[] = [];
    for (let i = 0; i < e.count; i++) {
      const den = this.u32(e.valueAt + i * 8 + 4);
      out.push(den ? this.u32(e.valueAt + i * 8) / den : 0);
    }
    return out;
  }
  value(e: Entry): number {
    return e.type === 3 ? this.u16(e.valueAt) : this.u32(e.valueAt);
  }
}

/** Etsii JPEGin EXIF-segmentin ja palauttaa TIFF-alun sijainnin. */
function findExif(bytes: Uint8Array): number | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let pos = 2;
  while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return undefined; // kuvadata alkaa
    const len = (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
    const seg = pos + 4;
    if (
      marker === 0xe1 &&
      bytes[seg] === 0x45 && // E
      bytes[seg + 1] === 0x78 && // x
      bytes[seg + 2] === 0x69 && // i
      bytes[seg + 3] === 0x66 && // f
      bytes[seg + 4] === 0 &&
      bytes[seg + 5] === 0
    ) {
      return seg + 6;
    }
    pos += 2 + len;
  }
  return undefined;
}

function openTiff(bytes: Uint8Array): Tiff | undefined {
  const at = findExif(bytes);
  if (at === undefined) return undefined;
  try {
    return new Tiff(bytes, at);
  } catch {
    return undefined;
  }
}

const exifDate = (s: string) => {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : undefined;
};

export function readImageInfo(bytes: Uint8Array): ImageInfo {
  const t = openTiff(bytes);
  if (!t) return {};
  const info: ImageInfo = {};
  try {
    const ifd0 = t.entries(t.ifd0);
    const find = (list: Entry[], tag: number) => list.find((e) => e.tag === tag);
    const orientation = find(ifd0, TAG.orientation);
    if (orientation) info.orientation = t.value(orientation);
    const exifPtr = find(ifd0, TAG.exifIfd);
    const exif = exifPtr ? t.entries(t.value(exifPtr)) : [];
    const dto = find(exif, TAG.dateTimeOriginal) ?? find(ifd0, TAG.dateTime);
    if (dto) {
      const time = exifDate(t.ascii(dto));
      const offset = find(exif, TAG.offsetTimeOriginal);
      const tz = offset ? t.ascii(offset) : "";
      if (time) info.time = /^[+-]\d{2}:\d{2}$/.test(tz) ? time + tz : time;
    }
    const gpsPtr = find(ifd0, TAG.gpsIfd);
    const gps = gpsPtr ? t.entries(t.value(gpsPtr)) : [];
    if (gps.length) {
      const coord = (refTag: number, valTag: number, neg: string) => {
        const val = find(gps, valTag);
        if (!val || val.type !== 5 || val.count < 3) return undefined;
        const [d, m, s] = t.rationals(val) as [number, number, number];
        const ref = find(gps, refTag);
        const sign = ref && t.ascii(ref) === neg ? -1 : 1;
        return sign * (d + m / 60 + s / 3600);
      };
      info.gps = { lat: coord(1, 2, "S"), lon: coord(3, 4, "W") };
    }
  } catch {
    // Rikkinäinen EXIF ei estä kuvan käyttöä.
  }
  return info;
}

export const hasLocation = (bytes: Uint8Array) => readImageInfo(bytes).gps !== undefined;

/** Palauttaa kopion, josta GPS-tiedot on nollattu. Muut tavut pysyvät ennallaan. */
export function stripLocation(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  const t = openTiff(out);
  if (!t) return out;
  const ptr = t.entries(t.ifd0).find((e) => e.tag === TAG.gpsIfd);
  if (!ptr) return out;
  const ifd = t.value(ptr);
  const entries = t.entries(ifd);
  for (const e of entries) {
    const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
    if (size > 4 && t.start + e.valueAt + size <= out.length) out.fill(0, t.start + e.valueAt, t.start + e.valueAt + size);
    out.fill(0, t.start + e.entryAt, t.start + e.entryAt + 12);
  }
  // Hakemisto jää tyhjäksi: nolla kenttää ja nolla seuraavaa hakemistoa.
  out.fill(0, t.start + ifd, t.start + ifd + 2);
  const next = ifd + 2 + entries.length * 12;
  if (t.start + next + 4 <= out.length) out.fill(0, t.start + next, t.start + next + 4);
  return out;
}
