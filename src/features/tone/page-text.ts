// Turns a fetched web page into plain text the researcher can read. Search
// results only carry a short snippet, which is where facts like "who played
// the intro" get lost, so the model can ask for the whole article.

const DROP = ["script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "iframe", "template", "button", "select"];
const BLOCK = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|main|blockquote|figcaption|dd|dt|pre|table)\b[^>]*>/gi;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", eacute: "é", uuml: "ü", ouml: "ö",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** The inner HTML of the longest <tag> element, or undefined. */
function longest(html: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let best: string | undefined;
  for (const match of html.matchAll(re)) if (!best || match[1].length > best.length) best = match[1];
  return best;
}

/** Readable text of a page: the article if it has one, without menus, scripts or footers. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROP) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), " ");
  const article = longest(body, "article");
  const main = longest(body, "main");
  // A teaser <article> in a sidebar is shorter than the real content; only trust a substantial one.
  body = article && article.length > 2000 ? article : main && main.length > 2000 ? main : (longest(body, "body") ?? body);
  const text = decode(body.replace(BLOCK, "\n").replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 1)
    .join("\n");
  return { title, text };
}

// Words that mark the paragraphs worth keeping from a long page.
const GEAR =
  /\b(guitar|guitars|amp|amps|amplifier|pedal|pedals|chorus|flanger|phaser|delay|echo|reverb|fuzz|distortion|overdrive|boost|wah|tremolo|vibrato|octave|compressor|cab|cabinet|speaker|pickup|pickups|humbucker|single.coil|tuning|tuned|capo|played|plays|playing|solo|riff|rhythm|recorded|recording|studio|session|producer|engineer|mic|miked|tone|rig|marshall|fender|mesa|boogie|vox|orange|peavey|hiwatt|boss|ibanez|electro.harmonix|big muff|strat|stratocaster|telecaster|les paul|gibson|rickenbacker|prs|gretsch|line 6|kemper|axe.fx)\b/i;

/**
 * Cuts a page to `max` characters, keeping the opening and then the
 * paragraphs about gear or the song, so a long interview still fits.
 */
export function pageExcerpt(text: string, keywords: string[], max = 8000): string {
  if (text.length <= max) return text;
  const words = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 3);
  const relevant = (p: string) => GEAR.test(p) || words.some((w) => p.toLowerCase().includes(w));
  const paragraphs = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  let skipped = false;
  for (const [i, p] of paragraphs.entries()) {
    const opening = size < 1200 && i < 8;
    if (!opening && !relevant(p)) {
      skipped = true;
      continue;
    }
    if (size + p.length > max) break;
    if (skipped && kept.length) kept.push("[…]");
    skipped = false;
    kept.push(p);
    size += p.length + 1;
  }
  return kept.join("\n");
}
