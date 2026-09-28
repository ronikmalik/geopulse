import { classifyByKeywords } from "../src/lib/classify";

const cases: { source: string; title: string; snippet: string }[] = [
  {
    source: "rss:premium-times-nigeria",
    title: "US imposes new sanctions on Russian oil exporters, White House says",
    snippet: "The Trump administration announced fresh sanctions targeting Russian oil exports amid escalating tensions.",
  },
  {
    source: "rss:premium-times-nigeria",
    title: "Boko Haram militants killed in clashes with Nigerian troops",
    snippet: "Nigerian security forces reported clashes with Boko Haram militants in Borno state, killing several fighters.",
  },
  {
    source: "rss:the-hindu",
    title: "Clashes erupt as protesters clash with police in Delhi",
    snippet: "Police used tear gas as protesters clashed near the capital.",
  },
  {
    source: "rss:the-hindu",
    title: "US strike kills militants in Yemen, Pentagon confirms",
    snippet: "A US airstrike targeted Houthi positions in Yemen.",
  },
  {
    source: "rss:bbc-world",
    title: "US strike kills militants in Yemen, Pentagon confirms",
    snippet: "A US airstrike targeted Houthi positions in Yemen.",
  },
];

for (const c of cases) {
  const result = classifyByKeywords({
    source: c.source,
    url: `https://example.com/${Math.random()}`,
    title: c.title,
    snippet: c.snippet,
    publishedAt: new Date(),
  });
  console.log(
    `[${c.source}] "${c.title}" ->`,
    result ? `KEPT (country=${result.country}, category=${result.category})` : "DROPPED",
  );
}
