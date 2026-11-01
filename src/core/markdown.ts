/**
 * Markdownin kanoninen jakaja. Saman tekstin on pilkottava aina samoin,
 * muuten palojen hashit eroavat ja linkit eivät osu.
 *
 * Sääntö (CommonMarkin ylimmän tason lohkojen yksinkertaistus):
 *  1. Rivinvaihdot normalisoidaan muotoon \n ja rivien loppuvälit poistetaan.
 *  2. Tyhjä rivi erottaa lohkot, paitsi aidatun koodilohkon (``` tai ~~~) sisällä.
 *  3. ATX-otsikko (# …) on aina oma lohkonsa.
 *  4. Lohkon tavut ovat sen rivit \n:llä yhdistettyinä, ilman loppurivinvaihtoa.
 *
 * Rajoitus: väljä lista (kohtien välissä tyhjä rivi) jakautuu kohdittain.
 */
export function splitMarkdown(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
  };
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      if (line.trimStart().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") {
        fence = undefined;
        flush();
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = open[1]!;
      cur.push(line);
      continue;
    }
    if (line === "") {
      flush();
      continue;
    }
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
      flush();
      cur.push(line);
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

export const joinMarkdown = (blocks: string[]) => blocks.join("\n\n") + "\n";

/** Lohko, jossa on vain kuva: `![alt](polku)`. */
export function imageOnly(block: string): { alt: string; src: string } | undefined {
  const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/.exec(block.trim());
  return m ? { alt: m[1]!, src: m[2]! } : undefined;
}

/** Ensimmäinen otsikko, jos sellainen on. */
export function firstHeading(blocks: string[]): string | undefined {
  for (const b of blocks) {
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(b);
    if (m) return m[1];
  }
  return undefined;
}
