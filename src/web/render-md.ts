/**
 * Pieni ja turvallinen Markdown-renderöinti yhdelle palalle. Teksti escapetaan
 * ennen muotoilua, ja linkeissä sallitaan vain http(s)- ja mailto-osoitteet.
 */

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SAFE_URL = /^(https?:|mailto:|#|\.{0,2}\/)/i;

function inline(raw: string): string {
  // Koodipätkät erotetaan ensin, jotta niiden sisältöä ei muotoilla.
  return raw
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.replace(/^`+|`+$/g, ""))}</code>`;
      let s = escapeHtml(part);
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) =>
        SAFE_URL.test(url) ? `<img src="${url}" alt="${alt}" loading="lazy">` : m,
      );
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
        if (url.startsWith("kude:")) return `<span class="kude-osoite" title="${url}">${text}</span>`;
        return SAFE_URL.test(url) ? `<a href="${url}" rel="noopener" target="_blank">${text}</a>` : m;
      });
      s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`);
      s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)|(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, (_, p1, a, p2, b) =>
        `${p1 ?? p2 ?? ""}<em>${a ?? b}</em>`,
      );
      return s;
    })
    .join("")
    .replace(/\n/g, " ");
}

export function renderBlock(md: string): string {
  const lines = md.split("\n");
  const first = lines[0] ?? "";

  const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(first);
  if (fence) {
    const body = lines.slice(1);
    if (body.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(body[body.length - 1]!)) body.pop();
    const lang = fence[2]!.trim().split(/\s/)[0];
    return `<pre><code${lang ? ` class="kieli-${escapeHtml(lang)}"` : ""}>${escapeHtml(body.join("\n"))}</code></pre>`;
  }

  const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(first);
  if (heading && lines.length === 1) {
    // Kuteen nimi on sivun h1, joten palojen otsikot alkavat h2:sta.
    const level = Math.min(6, heading[1]!.length + 1);
    return `<h${level}>${inline(heading[2]!)}</h${level}>`;
  }

  if (/^ {0,3}([-*_])( *\1){2,} *$/.test(first) && lines.length === 1) return "<hr>";

  if (lines.every((l) => /^ {0,3}>/.test(l))) {
    return `<blockquote>${renderBlock(lines.map((l) => l.replace(/^ {0,3}> ?/, "")).join("\n"))}</blockquote>`;
  }

  const bullet = /^ {0,3}([-*+]|\d{1,9}[.)])\s+/;
  if (bullet.test(first)) {
    const ordered = /^\s*\d/.test(first);
    const items: string[] = [];
    for (const l of lines) {
      if (bullet.test(l)) items.push(l.replace(bullet, ""));
      else if (items.length) items[items.length - 1] += "\n" + l.trim();
    }
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`;
  }

  return `<p>${inline(md)}</p>`;
}
