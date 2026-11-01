import { describe, expect, it } from "vitest";
import { readImageInfo, stripLocation } from "../src/core/index.js";

/** Pieni JPEG, jossa on EXIF: kuvaushetki, suunta ja GPS (60.175 N, 24.9375 E). */
function jpegWithExif(): Uint8Array {
  const tiff = new Uint8Array(190);
  const v = new DataView(tiff.buffer);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    v.setUint16(at, tag, true);
    v.setUint16(at + 2, type, true);
    v.setUint32(at + 4, count, true);
    v.setUint32(at + 8, value, true);
  };
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (tiff[at + i] = c.charCodeAt(0)));
  const rationals = (at: number, vals: [number, number][]) =>
    vals.forEach(([n, d], i) => {
      v.setUint32(at + i * 8, n, true);
      v.setUint32(at + i * 8 + 4, d, true);
    });

  ascii(0, "II");
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true);
  // IFD0 @8: suunta, Exif-osoitin, GPS-osoitin
  v.setUint16(8, 3, true);
  entry(10, 0x0112, 3, 1, 6);
  entry(22, 0x8769, 4, 1, 50);
  entry(34, 0x8825, 4, 1, 88);
  v.setUint32(46, 0, true);
  // Exif IFD @50: DateTimeOriginal -> 68
  v.setUint16(50, 1, true);
  entry(52, 0x9003, 2, 20, 68);
  v.setUint32(64, 0, true);
  ascii(68, "2026:08:14 09:41:00\0");
  // GPS IFD @88: 4 kenttää, arvot @142 ja @166
  v.setUint16(88, 4, true);
  entry(90, 1, 2, 2, "N".charCodeAt(0));
  entry(102, 2, 5, 3, 142);
  entry(114, 3, 2, 2, "E".charCodeAt(0));
  entry(126, 4, 5, 3, 166);
  v.setUint32(138, 0, true);
  rationals(142, [[60, 1], [10, 1], [30, 1]]);
  rationals(166, [[24, 1], [56, 1], [15, 1]]);

  const app1Len = 2 + 6 + tiff.length;
  const header = [0xff, 0xd8, 0xff, 0xe1, app1Len >> 8, app1Len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0];
  const out = new Uint8Array(header.length + tiff.length + 2);
  out.set(header);
  out.set(tiff, header.length);
  out.set([0xff, 0xd9], header.length + tiff.length);
  return out;
}

describe("exif", () => {
  it("lukee kuvaushetken, suunnan ja sijainnin", () => {
    const info = readImageInfo(jpegWithExif());
    expect(info.time).toBe("2026-08-14T09:41:00");
    expect(info.orientation).toBe(6);
    expect(info.gps!.lat).toBeCloseTo(60.175, 6);
    expect(info.gps!.lon).toBeCloseTo(24.9375, 6);
  });

  it("poistaa sijainnin mutta säilyttää ajan ja suunnan", () => {
    const original = jpegWithExif();
    const stripped = stripLocation(original);
    expect(stripped.length).toBe(original.length);
    const info = readImageInfo(stripped);
    expect(info.gps).toBeUndefined();
    expect(info.time).toBe("2026-08-14T09:41:00");
    expect(info.orientation).toBe(6);
    // koordinaattien tavut on nollattu, ei vain piilotettu
    expect([...stripped.subarray(12 + 142, 12 + 190)].every((b) => b === 0)).toBe(true);
    expect(readImageInfo(original).gps).toBeDefined();
  });

  it("ei kaadu kuviin ilman EXIFiä", () => {
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({});
    expect(readImageInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual({});
  });
});
