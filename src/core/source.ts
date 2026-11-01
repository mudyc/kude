/**
 * Tavulähde: mistä kuteen tavut luetaan. Selaimessa URL luetaan Range-pyynnöillä,
 * jotta ensimmäinen näkymä tarvitsee vain kuvauksen eikä kaikkia kuvia.
 */
export interface ByteSource {
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function fromBytes(bytes: Uint8Array): ByteSource {
  return {
    async read(offset, length) {
      if (offset < 0 || offset + length > bytes.length) {
        throw new RangeError(`luku ${offset}+${length} ylittää tiedoston koon ${bytes.length}`);
      }
      return bytes.subarray(offset, offset + length);
    },
  };
}

export interface UrlSourceOptions {
  /** Kuinka monta tavua haetaan ensimmäisellä pyynnöllä. Kuvaus mahtuu yleensä tähän. */
  prefetch?: number;
  fetch?: typeof fetch;
  init?: RequestInit;
}

/**
 * Lukee URL:sta Range-pyynnöillä. Jos palvelin ei tue Rangea (vastaa 200),
 * koko tiedosto pidetään muistissa ja loput luvut tehdään siitä.
 */
export function fromUrl(url: string, opts: UrlSourceOptions = {}): ByteSource {
  const prefetch = opts.prefetch ?? 64 * 1024;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  let whole: Uint8Array | undefined;
  let prefix: Promise<Uint8Array> | undefined;

  const range = async (start: number, end: number): Promise<{ bytes: Uint8Array; partial: boolean }> => {
    const headers = new Headers(opts.init?.headers);
    headers.set("Range", `bytes=${start}-${end}`);
    const res = await doFetch(url, { ...opts.init, headers });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (res.status === 206) return { bytes, partial: true };
    whole = bytes;
    return { bytes, partial: false };
  };

  const slice = (b: Uint8Array, offset: number, length: number) => {
    if (offset + length > b.length) throw new RangeError(`${url}: luku ${offset}+${length} ylittää koon ${b.length}`);
    return b.subarray(offset, offset + length);
  };

  return {
    async read(offset, length) {
      if (whole) return slice(whole, offset, length);
      if (offset + length <= prefetch) {
        prefix ??= range(0, prefetch - 1).then(({ bytes, partial }) => {
          // Pienempi vastaus kuin pyydetty tarkoittaa, että tiedosto loppui.
          if (!partial || bytes.length < prefetch) whole = bytes;
          return bytes;
        });
        const p = await prefix;
        return slice(whole ?? p, offset, length);
      }
      const { bytes, partial } = await range(offset, offset + length - 1);
      return partial ? slice(bytes, 0, length) : slice(bytes, offset, length);
    },
  };
}
