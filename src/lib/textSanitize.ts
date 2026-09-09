// Strips emoji/pictographic symbols from ingested feed text. PressTV,
// several Telegram channels, and a handful of other wires routinely open
// headlines with a 🔴/🚨/⚡ marker — informative in their own apps, but it
// reads as noisy clutter in a feed card here. \p{Extended_Pictographic}
// covers the bulk of emoji, but flag emoji (regional-indicator letter
// pairs) and the variation-selector/ZWJ characters that glue multi-
// codepoint emoji together aren't pictographic themselves, so they're
// stripped separately; collapsing the resulting double-spaces avoids
// leaving an awkward gap where a leading emoji used to sit.
export function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/[\u{FE0F}\u{200D}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
