import { classifyGdeltItem } from "../src/lib/classify";

// The bug case: title clearly names a category (us-iran), gdeltCategory
// was wrong (israel-palestine from an unrelated bundled sub-story) —
// title-derived category should win.
console.log(
  "bug case:",
  classifyGdeltItem({
    source: "gdelt",
    url: "https://example.com/a",
    title: "US strikes Iranian tankers after attempted missile attacks on its Navy warship : Report",
    snippet: "livemint.com (India)",
    publishedAt: new Date(),
    gdeltCategory: "israel-palestine",
  })?.category,
);

// A genuinely category-ambiguous headline (no country/topic-specific
// regex match in the title) — gdeltCategory should still be trusted here,
// since categorizeByKeywords alone would fall through to "other".
console.log(
  "ambiguous case (should fall back to gdeltCategory):",
  classifyGdeltItem({
    source: "gdelt",
    url: "https://example.com/b",
    title: "Regional tensions escalate after overnight strikes near the strait",
    snippet: "reuters.com (US)",
    publishedAt: new Date(),
    gdeltCategory: "china-taiwan",
  })?.category,
);
