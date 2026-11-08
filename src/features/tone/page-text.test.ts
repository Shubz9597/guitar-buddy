import { describe, expect, it } from "vitest";
import { htmlToText, pageExcerpt } from "./page-text";

describe("htmlToText", () => {
  it("keeps the article and drops scripts, menus and footers", () => {
    const body = "<p>Wendy Melvoin played the intro on a Rickenbacker &amp; a Boss CE-1 &ndash; through a Mesa.</p>".repeat(30);
    const html = `<html><head><title>Purple Rain &#8211; rig</title><script>var x = "<p>no</p>";</script></head>
      <body><header>Site menu</header><nav><a>Home</a></nav>
      <aside><article><p>Related: other song</p></article></aside>
      <article><h1>Purple Rain</h1>${body}</article>
      <footer>Cookie policy</footer></body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("Purple Rain – rig");
    expect(text.startsWith("Purple Rain\nWendy Melvoin played the intro on a Rickenbacker & a Boss CE-1 – through a Mesa.")).toBe(true);
    for (const junk of ["Site menu", "Home", "Related", "Cookie", "var x"]) expect(text).not.toContain(junk);
  });

  it("falls back to the body when there is no article", () => {
    expect(htmlToText("<body><div>One</div><div>Two&nbsp;three</div></body>").text).toBe("One\nTwo three");
  });
});

describe("pageExcerpt", () => {
  it("keeps the opening and the paragraphs about gear when a page is long", () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Tour diary entry ${i} about hotels and food and the weather that week.`);
    const text = ["Intro paragraph.", ...filler.slice(0, 30), "He used a Boss CE-1 chorus on the intro.", ...filler.slice(30), "Purple Rain was cut live at First Avenue."].join("\n");
    const out = pageExcerpt(text, ["Purple", "Rain", "Prince"], 1500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("Intro paragraph.");
    expect(out).toContain("Boss CE-1 chorus");
    expect(out).toContain("Purple Rain was cut live");
    expect(out).toContain("[…]");
    expect(out).not.toContain("Tour diary entry 40");
  });

  it("returns short pages whole", () => {
    expect(pageExcerpt("short", [], 100)).toBe("short");
  });
});
