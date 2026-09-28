import { classifyByKeywords } from "../src/lib/classify";

const c = {
  source: "rss:the-hindu",
  title: "Clashes erupt in India as protesters clash with police",
  snippet: "Police used tear gas as protesters clashed near the capital.",
};

const result = classifyByKeywords({
  source: c.source,
  url: `https://example.com/${Math.random()}`,
  title: c.title,
  snippet: c.snippet,
  publishedAt: new Date(),
});
console.log(result ? `KEPT (country=${result.country}, category=${result.category})` : "DROPPED");
