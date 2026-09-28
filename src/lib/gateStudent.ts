import { and, gt, inArray, isNotNull, isNull, like, lt, notLike, or, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { splitAttribution } from "./displayText";
import { recordModelRun } from "./modelRegistry";

// The gate student (2026-09-28): a local model trained on the review
// gate's own past decisions, measuring how much of that judgment a model
// that costs no API calls could reproduce.
//
// Why this and not more embeddings: the embedding budget is spent in full
// every day (~888 of 900 calls, 2026-09-18..27) and the archive is ~26k
// rows behind, so anything that needs a Gemini vector per item inherits
// that bottleneck. Word and word-pair counts need nothing but the text.
//
// The loop it opens: every gate verdict is a training label, so each day of
// reviewing makes the next training run larger (~250 labels a day at the
// time of writing), and the registry keeps every run so the trend is
// visible on /models. It is scored on the newest fifth of decisions it
// never saw, beside two naive baselines, and reports how many decisions
// it could take on alone at a given agreement with the gate ("cascade"
// rows).
//
// It decides nothing while Gemini is working. The one exception, approved
// by the owner on 2026-09-28, is the outage fallback below: GDELT items
// are never auto-published unreviewed (2026-09-10 owner decision), so a
// Gemini outage used to leave GDELT off the feed for hours. When a GDELT
// item has waited FALLBACK_MIN_AGE_MINUTES (the gate has failed on it at
// least twice), the model is retrained on the spot and may publish it if
// it is at least FALLBACK_THRESHOLD sure the gate would, and only if, in
// that same run, at least FALLBACK_MIN_PRECISION of its held-out
// FALLBACK_THRESHOLD-confident "publish" calls (FALLBACK_MIN_PUBLISH_CALLS
// or more of them) were items the gate did publish. Such rows carry
// reviewModel GATE_STUDENT_MODEL_ID; the gate re-checks every one when
// Gemini is back and can withdraw it (classifierAudit.ts), and they are
// never used as training labels.
//
// Measured 2026-09-28: 9 such held-out calls at 0.95, all correct, so it
// stays off until the evidence grows. At 0.9, publish precision ranged
// 86-100% across three time windows: short of the bar GDELT is held to.
// Features are text, source and category only. The stored severity and
// country are NOT used: the gate rewrites them on approval (severity on
// 362 of 497 approvals), so as features they leak the label.
//
// Labels: approved/rejected rows from the classified sources whose status
// was set by a judgment with recorded reasoning, i.e. the Gemini gate, the
// Gemini post-hoc audit ("classifier audit: ...") or a human grade ("human
// grade: ..."). Excluded: auto-promotions after a gate outage (no
// reasoning) and items withheld after unusable verdicts ("Withheld: ...").
// Reasoning has been stored since 2026-09-18; earlier rows cannot be told
// apart from auto-promotions and are left out.

export const GATE_STUDENT_FAMILY = "gate-student";
export const GATE_STUDENT_VARIANT = "hashed-ngram-logreg";

const HASH_BITS = 18;
const DIM = 1 << HASH_BITS;
const MIN_EXAMPLES = 200;
const TEST_FRACTION = 0.2;
const EPOCHS = 10;
const LEARNING_RATE = 0.5;
const L2 = 1e-4;
const CASCADE_THRESHOLDS = [0.8, 0.9, 0.95] as const;
const TOP_FEATURES = 12;
const MIN_FEATURE_SUPPORT = 3;

// Function words carry no signal about relevance and only add hash noise.
const STOPWORDS = new Set(
  "the a an and or of to in on at for from by with as is are was were be been has have had it its this that these those after before over into than then but not no".split(
    " ",
  ),
);

export interface GateExample {
  text: string;
  source: string;
  category: string;
  label: 0 | 1; // 1 = published (approved)
  at: Date;
}

export function sourceFamily(source: string): string {
  return source.includes(":") ? source.slice(0, source.indexOf(":")) : source;
}

// Named features before hashing, so the most influential ones can be
// reported in words rather than bucket numbers.
export function gateFeatureNames(ex: Pick<GateExample, "text" | "source" | "category">): string[] {
  const tokens = (ex.text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length >= 2,
  );
  const words = tokens.filter((t) => !STOPWORDS.has(t));
  const names = new Set<string>();
  for (const w of words) names.add(`w:${w}`);
  for (let i = 0; i + 1 < tokens.length; i++) names.add(`b:${tokens[i]}_${tokens[i + 1]}`);
  names.add(`src:${sourceFamily(ex.source)}`);
  names.add(`srcx:${ex.source}`);
  names.add(`cat:${ex.category}`);
  return [...names];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface SparseVector {
  idx: number[];
  val: number; // every present feature has the same value after L2 normalisation
}

function vectorize(names: string[]): SparseVector {
  const idx = [...new Set(names.map((n) => fnv1a(n) & (DIM - 1)))];
  return { idx, val: idx.length > 0 ? 1 / Math.sqrt(idx.length) : 0 };
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

// Deterministic shuffling, so a rerun on the same rows gives the same model.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GateStudentModel {
  weights: Float64Array;
  bias: number;
}

// Logistic regression by AdaGrad SGD with L2 applied to the weights a step
// touches. Small, dependency-free, and exact enough at this data scale.
export function trainGateStudent(vectors: SparseVector[], labels: number[], seed = 1): GateStudentModel {
  const weights = new Float64Array(DIM);
  const grad2 = new Float64Array(DIM);
  let bias = 0;
  let biasGrad2 = 0;
  const order = vectors.map((_, i) => i);
  const rand = mulberry32(seed);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const i of order) {
      const v = vectors[i];
      let z = bias;
      for (const k of v.idx) z += weights[k] * v.val;
      const err = sigmoid(z) - labels[i];
      for (const k of v.idx) {
        const g = err * v.val + L2 * weights[k];
        grad2[k] += g * g;
        weights[k] -= (LEARNING_RATE * g) / Math.sqrt(grad2[k] + 1e-8);
      }
      biasGrad2 += err * err;
      bias -= (LEARNING_RATE * err) / Math.sqrt(biasGrad2 + 1e-8);
    }
  }
  return { weights, bias };
}

export function predictGateStudent(model: GateStudentModel, v: SparseVector): number {
  let z = model.bias;
  for (const k of v.idx) z += model.weights[k] * v.val;
  return sigmoid(z);
}

// Probability that a random positive outranks a random negative (ties
// count half) — the Mann-Whitney form of ROC AUC.
export function rocAuc(scores: number[], labels: number[]): number | null {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  const pos = pairs.filter((p) => p.y === 1).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return null;
  let rankSumPos = 0;
  for (let i = 0; i < pairs.length; ) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (pairs[k].y === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

function logLoss(p: number[], y: number[]): number {
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p[i]));
    sum += y[i] === 1 ? -Math.log(q) : -Math.log(1 - q);
  }
  return sum / Math.max(1, p.length);
}

function accuracy(p: number[], y: number[], threshold = 0.5): number {
  let right = 0;
  for (let i = 0; i < p.length; i++) if ((p[i] >= threshold ? 1 : 0) === y[i]) right++;
  return right / Math.max(1, p.length);
}

const round = (x: number | null, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export interface GateStudentEvaluation {
  trained: boolean;
  trainSize: number;
  testSize: number;
  metrics: Record<string, number | string | null>;
  baseline: Record<string, number | string | null> | null;
  notes: string;
}

// Pure: examples in, evaluation out. The newest TEST_FRACTION of decisions
// (by time) is held out, so the score says how well the past predicts the
// future, not how well the model memorised a shuffled sample.
export function evaluateGateStudent(examples: GateExample[]): GateStudentEvaluation {
  return fitGateStudent(examples).evaluation;
}

// The evaluation plus the exact model it describes, so the outage fallback
// scores items with the model whose held-out numbers it just checked.
export function fitGateStudent(examples: GateExample[]): {
  evaluation: GateStudentEvaluation;
  model: GateStudentModel | null;
} {
  const sorted = [...examples].sort((a, b) => a.at.getTime() - b.at.getTime());
  const cut = Math.floor(sorted.length * (1 - TEST_FRACTION));
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const classes = (xs: GateExample[]) => new Set(xs.map((x) => x.label)).size;
  if (sorted.length < MIN_EXAMPLES || classes(train) < 2 || classes(test) < 2) {
    return { model: null, evaluation: {
      trained: false,
      trainSize: train.length,
      testSize: test.length,
      metrics: { labeledExamples: sorted.length },
      baseline: null,
      notes: `insufficient data: ${sorted.length} labeled gate decisions (need ${MIN_EXAMPLES}+, both outcomes in the training and the held-out period).`,
    } };
  }

  const trainNames = train.map(gateFeatureNames);
  const trainVectors = trainNames.map(vectorize);
  const trainLabels: number[] = train.map((e) => e.label);
  const model = trainGateStudent(trainVectors, trainLabels);

  const testLabels: number[] = test.map((e) => e.label);
  const testScores = test.map((e) => predictGateStudent(model, vectorize(gateFeatureNames(e))));

  // Baselines on the same held-out rows: the training approval rate for
  // everything, and the training approval rate of the item's source family.
  const prior = trainLabels.reduce((a, b) => a + b, 0) / trainLabels.length;
  const familyStats = new Map<string, { pos: number; n: number }>();
  for (const e of train) {
    const f = sourceFamily(e.source);
    const s = familyStats.get(f) ?? { pos: 0, n: 0 };
    s.pos += e.label;
    s.n += 1;
    familyStats.set(f, s);
  }
  const familyScores = test.map((e) => {
    const s = familyStats.get(sourceFamily(e.source));
    return s && s.n > 0 ? s.pos / s.n : prior;
  });
  const priorScores = test.map(() => prior);
  const majority = prior >= 0.5 ? 1 : 0;

  const metrics: Record<string, number | string | null> = {
    auc: round(rocAuc(testScores, testLabels)),
    accuracy: round(accuracy(testScores, testLabels)),
    logLoss: round(logLoss(testScores, testLabels)),
    testApprovalRate: round(testLabels.reduce((a, b) => a + b, 0) / testLabels.length),
  };
  // Cascade rows: the share of held-out decisions the model is confident
  // enough to take alone at threshold t, and how often it then agrees with
  // the gate. The honest number to decide a cascade on, if ever.
  for (const t of CASCADE_THRESHOLDS) {
    const covered = testScores.map((s, i) => ({ s, y: testLabels[i] })).filter(({ s }) => s >= t || s <= 1 - t);
    metrics[`coverage@${t}`] = round(covered.length / testScores.length);
    metrics[`covered@${t}`] = covered.length;
    metrics[`agreement@${t}`] = covered.length
      ? round(covered.filter(({ s, y }) => (s >= t ? 1 : 0) === y).length / covered.length)
      : null;
    // The publish side alone: of the held-out items it is at least t sure
    // the gate would publish, the share the gate did publish. This, not
    // agreement (which confident rejections dominate), is what the outage
    // fallback is judged on.
    const publishCalls = testScores.map((s, i) => ({ s, y: testLabels[i] })).filter(({ s }) => s >= t);
    metrics[`publishN@${t}`] = publishCalls.length;
    metrics[`publishPrecision@${t}`] = publishCalls.length
      ? round(publishCalls.filter(({ y }) => y === 1).length / publishCalls.length)
      : null;
  }

  // Most influential features, in words, among those seen at least
  // MIN_FEATURE_SUPPORT times in training (rarer ones are mostly noise).
  const support = new Map<number, { name: string; count: number }>();
  for (const names of trainNames) {
    for (const name of names) {
      const k = fnv1a(name) & (DIM - 1);
      const cur = support.get(k);
      if (cur) cur.count++;
      else support.set(k, { name, count: 1 });
    }
  }
  const ranked = [...support.entries()]
    .filter(([, s]) => s.count >= MIN_FEATURE_SUPPORT)
    .map(([k, s]) => ({ name: s.name, w: model.weights[k] }))
    .sort((a, b) => b.w - a.w);
  const label = (n: string) => n.replace(/^[a-z]+:/, "").replace(/_/g, " ");
  metrics.publishLeaning = ranked.slice(0, TOP_FEATURES).map((r) => label(r.name)).join(", ");
  metrics.rejectLeaning = ranked
    .slice(-TOP_FEATURES)
    .reverse()
    .map((r) => label(r.name))
    .join(", ");

  const baseline: Record<string, number | string | null> = {
    name: "source-family approval rate",
    auc: round(rocAuc(familyScores, testLabels)),
    accuracy: round(accuracy(familyScores, testLabels)),
    logLoss: round(logLoss(familyScores, testLabels)),
    priorOnlyLogLoss: round(logLoss(priorScores, testLabels)),
    majorityAccuracy: round(testLabels.filter((y) => y === majority).length / testLabels.length),
  };

  return { model, evaluation: {
    trained: true,
    trainSize: train.length,
    testSize: test.length,
    metrics,
    baseline,
    notes:
      `Trained on ${train.length} gate decisions, scored on the newest ${test.length} it never saw. ` +
      "Decides nothing while Gemini is working; during a Gemini outage it may publish GDELT items it is at least 95% sure of, each re-checked by Gemini later. " +
      "Labels are the gate's own verdicts (plus audit and human corrections), so agreement measures how well it reproduces the gate, not ground truth.",
  } };
}

const GATE_LABELS_SINCE = new Date("2026-09-18T00:00:00Z");

// What the model reads for one event, the same at training and scoring.
function gateText(row: { title: string; summary: string; source: string }): string {
  const body = splitAttribution(row.summary, row.source).body;
  return row.title === row.summary ? body : `${row.title}\n${body}`;
}

// reviewModel stamped on rows the model published during an outage.
export const GATE_STUDENT_MODEL_ID = `${GATE_STUDENT_FAMILY}:${GATE_STUDENT_VARIANT}`;

export async function loadGateExamples(): Promise<GateExample[]> {
  const db = getDb();
  const rows = await db
    .select({
      title: events.title,
      summary: events.summary,
      source: events.source,
      category: events.category,
      reviewStatus: events.reviewStatus,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        or(like(events.source, "rss:%"), eq(events.source, "gdelt"), like(events.source, "telegram:%")),
        gt(events.createdAt, GATE_LABELS_SINCE),
        inArray(events.reviewStatus, ["approved", "rejected"]),
        isNotNull(events.reviewReasoning),
        notLike(events.reviewReasoning, "Withheld:%"),
        // Its own outage decisions are not labels: learning from them would
        // only teach it to agree with itself.
        or(isNull(events.reviewModel), notLike(events.reviewModel, `${GATE_STUDENT_FAMILY}%`)),
      ),
    );
  return rows.map((r) => {
    return {
      text: gateText(r),
      source: r.source,
      category: r.category,
      label: r.reviewStatus === "approved" ? 1 : 0,
      at: r.createdAt,
    };
  });
}

export async function trainAndRecordGateStudent(): Promise<GateStudentEvaluation> {
  const examples = await loadGateExamples();
  const evaluation = evaluateGateStudent(examples);
  await recordModelRun({
    family: GATE_STUDENT_FAMILY,
    variant: GATE_STUDENT_VARIANT,
    sampleSize: evaluation.trainSize,
    backtestSampleSize: evaluation.testSize,
    metrics: evaluation.metrics,
    baseline: evaluation.baseline ?? undefined,
    trained: evaluation.trained,
    promoted: false,
    notes: evaluation.notes,
  });
  return evaluation;
}

export const FALLBACK_MIN_AGE_MINUTES = 30;
export const FALLBACK_THRESHOLD = 0.95;
export const FALLBACK_MIN_PRECISION = 0.95;
export const FALLBACK_MIN_PUBLISH_CALLS = 15;
const FALLBACK_BATCH = 300;

export interface StudentFallbackResult {
  considered: number;
  published: number;
  // Why nothing was published although items were waiting, if so.
  skipped: string | null;
}

// See the header comment. Runs at the end of every review round; a no-op
// unless GDELT items have been waiting FALLBACK_MIN_AGE_MINUTES.
export async function publishConfidentPendingGdelt(
  now = Date.now(),
  loadExamples: () => Promise<GateExample[]> = loadGateExamples,
): Promise<StudentFallbackResult> {
  const db = getDb();
  const waiting = await db
    .select({ id: events.id, title: events.title, summary: events.summary, source: events.source, category: events.category })
    .from(events)
    .where(
      and(
        eq(events.source, "gdelt"),
        eq(events.reviewStatus, "pending"),
        lt(events.createdAt, new Date(now - FALLBACK_MIN_AGE_MINUTES * 60_000)),
      ),
    )
    .orderBy(events.id)
    .limit(FALLBACK_BATCH);
  if (waiting.length === 0) return { considered: 0, published: 0, skipped: null };

  const { evaluation, model } = fitGateStudent(await loadExamples());
  const key = `${FALLBACK_THRESHOLD}`;
  const precision = evaluation.metrics[`publishPrecision@${key}`];
  const calls = evaluation.metrics[`publishN@${key}`];
  if (!model || !evaluation.trained) {
    return { considered: waiting.length, published: 0, skipped: evaluation.notes };
  }
  if (typeof precision !== "number" || typeof calls !== "number" || calls < FALLBACK_MIN_PUBLISH_CALLS || precision < FALLBACK_MIN_PRECISION) {
    return {
      considered: waiting.length,
      published: 0,
      skipped: `not enough evidence yet: publish precision ${precision ?? "n/a"} on ${calls ?? 0} held-out calls at ${key} (needs ${FALLBACK_MIN_PRECISION} on ${FALLBACK_MIN_PUBLISH_CALLS}+)`,
    };
  }

  let published = 0;
  for (const row of waiting) {
    const p = predictGateStudent(model, vectorize(gateFeatureNames({ text: gateText(row), source: row.source, category: row.category })));
    if (p < FALLBACK_THRESHOLD) continue;
    const updated = await db
      .update(events)
      .set({
        reviewStatus: "approved",
        reviewModel: GATE_STUDENT_MODEL_ID,
        reviewReasoning:
          `Published by the local gate model while Gemini was unavailable: ${(p * 100).toFixed(1)}% sure the review gate would publish it ` +
          `(held-out: ${(precision * 100).toFixed(1)}% of its ${calls} calls this confident were published by the gate). Gemini re-checks it when available.`,
      })
      .where(and(eq(events.id, row.id), eq(events.reviewStatus, "pending")))
      .returning({ id: events.id });
    published += updated.length;
  }
  return { considered: waiting.length, published, skipped: null };
}
