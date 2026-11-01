const TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/ld+json",
  jsonld: "application/ld+json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  gpx: "application/gpx+xml",
  fit: "application/vnd.ant.fit",
  csv: "text/csv",
  html: "text/html",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  kude: "application/x-kude",
};

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

export function extensionOf(mime: string): string {
  const base = mime.split(";")[0]!.trim();
  if (base === "application/json") return "json";
  const found = Object.entries(TYPES).find(([, m]) => m === base);
  return found ? found[0] : "bin";
}
