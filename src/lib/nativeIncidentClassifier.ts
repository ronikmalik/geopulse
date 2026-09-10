// Shadow-mode native-language incident classifier (2026-09-10). User's
// framing of the actual problem: translation is currently used to DECIDE
// whether a Telegram post is worth keeping, when it should mainly be used
// to DISPLAY a post we've already decided to keep. Real numbers back this
// up — of 574 posts that got fully translated, only ~142 (25%) were kept;
// the other 75% burned real translation bytes just to find out they'd be
// dropped anyway.
//
// This module is a DELIBERATELY NARROWER, native-language approximation of
// telegram.ts's own isKeptConflictPost (CONFLICT_ACTION_PATTERN /
// DIRECT_THREAT_PATTERN) and classify.ts's assessIncidentSeverity — not a
// full port of every exclusion classify.ts has accumulated (BENIGN_PATTERNS'
// 20+ alternations, RHETORICAL_ARGUMENT_PATTERNS, idiom lookbehinds like
// "struck a deal"). Those were tuned over many rounds of the user reading
// real ENGLISH output and correcting specific false positives — that
// verification loop doesn't exist here, since there's no fluent native
// speaker in this loop to catch a wrong native-language call the way
// English mistakes get caught. Ukrainian/Russian vocabulary below reuses
// terms already verified against the live kpszsu channel earlier this
// session (see foreignIncidentKeywords.ts); Farsi/Arabic are built from
// working (not native-fluent) vocabulary knowledge and should be trusted
// less until shadow data says otherwise.
//
// THIS RUNS SHADOW-ONLY: see telegram.ts's own call sites. Nothing here
// gates what actually gets translated or kept today — it only logs what
// it WOULD have decided, next to the real (translated, English-classified)
// decision, so real agreement/disagreement data can accumulate before any
// cutover is even considered.
export interface NativeClassification {
  kept: boolean;
  severity: number;
}

interface LanguagePatterns {
  // Mirrors CONFLICT_ACTION_PATTERN — a kinetic action already happened
  // (strike, kill, destroy, shoot down, capture, retake).
  action: RegExp;
  // Mirrors DIRECT_THREAT_PATTERN — an explicit vow/threat of imminent
  // military action, not just generic "warns"/"tension" rhetoric.
  threat: RegExp;
  // Deliberately MINIMAL and conservative — only the most common,
  // high-confidence non-incident markers (anniversaries, routine
  // visits/exercises), not an attempt at classify.ts's full BENIGN/
  // ONGOING/RHETORICAL suppression logic. Erring toward NOT suppressing
  // (false positives over false negatives) matches this app's own
  // established bias everywhere else this same call has been made.
  suppress: RegExp;
}

const PATTERNS: Record<string, LanguagePatterns> = {
  // Ukrainian — vocabulary cross-checked against the live kpszsu channel
  // (t.me/s/kpszsu) earlier this session; highest-confidence of the four.
  uk: {
    action:
      /удар(и|ом|ний|у)?|уражен|влучив|влучан|зб(или|ито|иття)|перехопил|перехоплен|знищ(ено|или|ує)|ліквідов|захопил|захоплен|звільнил|звільнен|відбил|відбит|поранен|загинул|загибл|\bвбит/i,
    threat: /погрожу(є|ють)|обіця(є|ють) завдати удар|попереджа(є|ють) про (удар|напад)/i,
    suppress: /річниц|роковин|(робочий|офіційний) візит|спільні навчання|щорічні навчання/i,
  },
  // Russian — same cross-check basis as Ukrainian above.
  ru: {
    action:
      /удар(ом|ы|ный|е)?|поражен|сби(ли|л|то)|перехват(или|чен)|уничтож(ены|ена|ил|ает)|ликвидирован|захватил|освобожден|отраз(или|ил)|ранен|\bпогиб|\bубит/i,
    threat: /угрожа(ет|ют)|предупрежда(ет|ют) о (ударе|ответе|атаке)/i,
    suppress: /годовщина|рабочий визит|официальный визит|совместные учения/i,
  },
  // Farsi — working vocabulary, not native-fluent; lower confidence than
  // uk/ru above until shadow data confirms it.
  fa: {
    action:
      /حمله(‌?ی)?( کرد| شد)?|کشته|زخمی|سرنگون|منهدم|نابود|آزادساز|بازپس[‌ ]?گیری|اصابت|ضربه (زد|خورد)/i,
    threat: /تهدید به (حمله|ضربه)|هشدار (نظامی|جدی)/i,
    suppress: /سالگرد|بازدید رسمی|رزمایش مشترک/i,
  },
  // Arabic — same confidence caveat as Farsi.
  ar: {
    action: /هجوم|هاجم|قتل(ى)?|جرحى|إصاب|أسقط(ت)?|دمّر(ت)?|قضت على|تحرير|استعاد(ت)?|انفجار|قصف/i,
    threat: /يهدد ب(هجوم|ضربة|رد)|تحذير (عسكري|جدي)/i,
    suppress: /ذكرى|زيارة رسمية|تدريبات مشتركة/i,
  },
};

// Mirrors TELEGRAM_MIN_SEVERITY (telegram.ts) — kept only when severity
// reaches this floor AND real action/threat language is present, same two-
// part bar as isKeptConflictPost.
const MIN_SEVERITY = 3;

// Returns null for a language this module has no pattern set for — callers
// should treat null as "no shadow opinion," never as "drop."
export function classifyNative(text: string, language: string): NativeClassification | null {
  const p = PATTERNS[language];
  if (!p) return null;

  if (p.suppress.test(text)) return { kept: false, severity: 1 };

  const hasAction = p.action.test(text);
  const hasThreat = p.threat.test(text);
  if (!hasAction && !hasThreat) return { kept: false, severity: 1 };

  const severity = hasAction ? 3 : 2;
  return { kept: severity >= MIN_SEVERITY, severity };
}
