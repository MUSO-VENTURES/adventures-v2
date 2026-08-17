// Trivia Break — pure question-generation logic for the trivia edge
// function. Kept framework-free (no Deno/Supabase imports, no fetch), same
// "unit test with a plain Node/Deno test runner as well as inside the edge
// function" shape as nextStopNotification.ts.
//
// Templates are built entirely from data already in the schema
// (route_stops/venues/venue_reviews, fed in via RouteContent) — no per-
// adventure hardcoding, so any new curated route or real-venue adventure
// works automatically the moment it exists, purely because it's queryable.
//
// Swap point for a future LLM-backed generator: implement the same
// TriviaGenerator interface (e.g. llmGenerator.generate(input, count)) and
// change ONE call site in trivia/index.ts's startRound action. Nothing else
// in the schema, the edge function's action dispatch, or the frontend needs
// to know which generator produced a question — that's already opaque
// behind trivia_rounds.source ('template' | 'fallback' | future 'llm').

export interface StopContent {
  id: string;
  stopOrder: number;
  name: string;
  description: string | null;
  emoji: string | null;
  isMystery: boolean;
  venue: null | {
    name: string;
    category: string | null;
    address: string | null;
    musoRating: number | null;
    musoRatingCount: number;
  };
  reviews: Array<{ rating: number; reviewText: string | null }>;
}

export interface RouteContent {
  routeId: string;
  routeTitle: string;
  stops: StopContent[]; // revealed stops only (is_mystery=false), sorted by stopOrder
  distractorStopNames: string[]; // padding pool pulled from OTHER routes, for thin routes
  distractorRouteTitles: string[];
  distractorEmojis: string[];
}

export interface TriviaQuestionChoice {
  key: string;
  text: string;
}

export interface TriviaQuestion {
  questionType: string;
  questionText: string;
  choices: TriviaQuestionChoice[];
  correctChoiceKey: string;
  explanation: string | null;
  source?: "template" | "fallback";
}

export interface TriviaGenerator {
  generate(input: RouteContent, count: number): TriviaQuestion[];
}

const CHOICE_KEYS = ["A", "B", "C", "D"];

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickOne<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// Builds a shuffled, deduped, at-most-4-choice set with the correct answer
// placed at a random position. Returns null if there isn't enough distinct
// material for at least 2 total choices (a question with only 1 possible
// answer isn't trivia, it's a statement).
function buildChoices(
  correctText: string,
  wrongCandidates: string[],
  desiredCount = 4,
): { choices: TriviaQuestionChoice[]; correctChoiceKey: string } | null {
  const seen = new Set([correctText]);
  const wrong: string[] = [];
  for (const c of shuffle(wrongCandidates)) {
    if (seen.has(c)) continue;
    seen.add(c);
    wrong.push(c);
    if (wrong.length >= desiredCount - 1) break;
  }
  if (wrong.length < 1) return null;

  const texts = shuffle([correctText, ...wrong]);
  const choices = texts.map((text, i) => ({ key: CHOICE_KEYS[i], text }));
  const correctChoiceKey = choices.find((c) => c.text === correctText)!.key;
  return { choices, correctChoiceKey };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

// ---------------------------------------------------------------
// Templates — each pushes 0 or 1 question, skipping silently when the
// route doesn't have enough of the source material it needs.
// ---------------------------------------------------------------

function pushVenueCategoryMatch(pool: TriviaQuestion[], input: RouteContent) {
  const candidates = input.stops.filter((s) => s.venue?.category);
  const target = pickOne(candidates);
  if (!target || !target.venue?.category) return;

  const wrongNames = [
    ...input.stops.filter((s) => s.id !== target.id).map((s) => s.name),
    ...input.distractorStopNames,
  ];
  const built = buildChoices(target.name, wrongNames);
  if (!built) return;

  pool.push({
    questionType: "venue_category_match",
    questionText: `Which stop on this adventure is a ${target.venue.category}?`,
    choices: built.choices,
    correctChoiceKey: built.correctChoiceKey,
    explanation: `${target.name} is the ${target.venue.category} stop.`,
  });
}

function pushVenueNameAtOrder(pool: TriviaQuestion[], input: RouteContent) {
  const candidates = input.stops.filter((s) => s.venue?.name);
  const target = pickOne(candidates);
  if (!target || !target.venue?.name) return;

  const wrongNames = [
    ...input.stops.filter((s) => s.id !== target.id && s.venue?.name).map((s) => s.venue!.name),
    ...input.distractorStopNames,
  ];
  const built = buildChoices(target.venue.name, wrongNames);
  if (!built) return;

  pool.push({
    questionType: "venue_name_at_order",
    questionText: `What's the name of the venue at stop ${target.stopOrder} on this adventure?`,
    choices: built.choices,
    correctChoiceKey: built.correctChoiceKey,
    explanation: `Stop ${target.stopOrder} is ${target.venue.name}.`,
  });
}

function pushRatingTrueFalse(pool: TriviaQuestion[], input: RouteContent) {
  const candidates = input.stops.filter(
    (s) => s.venue?.musoRating != null && (s.venue?.musoRatingCount ?? 0) > 0,
  );
  const target = pickOne(candidates);
  if (!target || target.venue?.musoRating == null) return;

  const actual = target.venue.musoRating;
  const rounded = Math.round(actual);
  const offset = Math.random() < 0.5 ? -1 : 1;
  const threshold = Math.min(9, Math.max(1, rounded + offset));
  const isAboveTrue = actual > threshold;

  pool.push({
    questionType: "rating_true_false",
    questionText: `True or False: ${target.venue.name} has a MUSO rating above ${threshold}/10.`,
    choices: [
      { key: "A", text: "True" },
      { key: "B", text: "False" },
    ],
    correctChoiceKey: isAboveTrue ? "A" : "B",
    explanation: `${target.venue.name} has a MUSO rating of ${actual}/10.`,
  });
}

function pushStopOrderPosition(pool: TriviaQuestion[], input: RouteContent) {
  if (input.stops.length < 2) return;
  const i = Math.floor(Math.random() * (input.stops.length - 1));
  const ref = input.stops[i];
  const next = input.stops[i + 1];

  const wrongNames = [
    ...input.stops.filter((s) => s.id !== ref.id && s.id !== next.id).map((s) => s.name),
    ...input.distractorStopNames,
  ];
  const built = buildChoices(next.name, wrongNames);
  if (!built) return;

  pool.push({
    questionType: "stop_order_position",
    questionText: `Which stop comes right after ${ref.name} on this adventure?`,
    choices: built.choices,
    correctChoiceKey: built.correctChoiceKey,
    explanation: `${next.name} follows ${ref.name}.`,
  });
}

function pushReviewIdentifiesStop(pool: TriviaQuestion[], input: RouteContent) {
  const candidates = input.stops.filter((s) => s.reviews.some((r) => r.reviewText));
  const target = pickOne(candidates);
  if (!target) return;
  const review = pickOne(target.reviews.filter((r) => r.reviewText));
  if (!review?.reviewText) return;

  const wrongNames = [
    ...input.stops.filter((s) => s.id !== target.id).map((s) => s.name),
    ...input.distractorStopNames,
  ];
  const built = buildChoices(target.name, wrongNames);
  if (!built) return;

  pool.push({
    questionType: "review_identifies_stop",
    questionText: `A player left this review: "${truncate(review.reviewText, 80)}" Which stop is that about?`,
    choices: built.choices,
    correctChoiceKey: built.correctChoiceKey,
    explanation: `That review was left for ${target.name}.`,
  });
}

function pushRouteTitleMatch(pool: TriviaQuestion[], input: RouteContent) {
  const built = buildChoices(input.routeTitle, input.distractorRouteTitles);
  if (!built) return;

  pool.push({
    questionType: "route_title_match",
    questionText: "What's the name of this adventure?",
    choices: built.choices,
    correctChoiceKey: built.correctChoiceKey,
    explanation: null,
  });
}

function pushEmojiMatch(pool: TriviaQuestion[], input: RouteContent) {
  const candidates = input.stops.filter((s) => s.emoji);
  const target = pickOne(candidates);
  if (!target?.emoji) return;

  const wrongEmojis = [
    ...input.stops.filter((s) => s.id !== target.id && s.emoji).map((s) => s.emoji!),
    ...input.distractorEmojis,
  ];
  const built = buildChoices(target.emoji, wrongEmojis);
  if (!built) return;

  pool.push({
    questionType: "emoji_match",
    questionText: `Which emoji represents "${target.name}" on this adventure?`,
    choices: built.choices,
    correctChoiceKey: built.correctChoiceKey,
    explanation: null,
  });
}

// ---------------------------------------------------------------
// Fallback bank — fresh, original general adventure/venue-going-out
// trivia, used only when even distractor-padded templates can't produce
// enough questions (e.g. a brand-new real-venue route with exactly one
// revealed stop, no category, no rating, no reviews).
// ---------------------------------------------------------------

export const FALLBACK_QUESTION_BANK: TriviaQuestion[] = [
  { questionType: "fallback_general", questionText: "In a classic wine flight, how many pours do you typically get?",
    choices: [{ key: "A", text: "2" }, { key: "B", text: "4" }, { key: "C", text: "8" }, { key: "D", text: "12" }],
    correctChoiceKey: "B", explanation: "Most tasting flights pour 4 small samples.", source: "fallback" },
  { questionType: "fallback_general", questionText: "What spirit is the base of a classic Old Fashioned?",
    choices: [{ key: "A", text: "Vodka" }, { key: "B", text: "Gin" }, { key: "C", text: "Whiskey" }, { key: "D", text: "Rum" }],
    correctChoiceKey: "C", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "In cornhole, how many points does landing a bag ON the board score?",
    choices: [{ key: "A", text: "1" }, { key: "B", text: "2" }, { key: "C", text: "3" }, { key: "D", text: "5" }],
    correctChoiceKey: "A", explanation: "A bag through the hole scores 3; on the board scores 1.", source: "fallback" },
  { questionType: "fallback_general", questionText: "What does a sommelier primarily specialize in?",
    choices: [{ key: "A", text: "Cheese" }, { key: "B", text: "Wine" }, { key: "C", text: "Coffee" }, { key: "D", text: "Chocolate" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "In karaoke, what does the on-screen bar usually track?",
    choices: [{ key: "A", text: "Tempo" }, { key: "B", text: "Lyrics timing" }, { key: "C", text: "Volume" }, { key: "D", text: "Key change" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "What's the standard par for one hole on a mini golf course?",
    choices: [{ key: "A", text: "1" }, { key: "B", text: "2" }, { key: "C", text: "3" }, { key: "D", text: "5" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "In an escape room, what's the most common time limit?",
    choices: [{ key: "A", text: "15 minutes" }, { key: "B", text: "30 minutes" }, { key: "C", text: "60 minutes" }, { key: "D", text: "3 hours" }],
    correctChoiceKey: "C", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: 'True or False: a "flight" at a brewery means a sampler of several small beers.',
    choices: [{ key: "A", text: "True" }, { key: "B", text: "False" }],
    correctChoiceKey: "A", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "What is the traditional garnish on a classic martini?",
    choices: [{ key: "A", text: "Lime wheel" }, { key: "B", text: "Olive" }, { key: "C", text: "Cherry" }, { key: "D", text: "Mint sprig" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "In axe throwing, what's the center ring usually called?",
    choices: [{ key: "A", text: "Bullseye" }, { key: "B", text: "The kill zone" }, { key: "C", text: "Clutch" }, { key: "D", text: "Blue horse" }],
    correctChoiceKey: "A", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "In ten-pin bowling, what's it called when you knock down all ten pins on your first roll?",
    choices: [{ key: "A", text: "Spare" }, { key: "B", text: "Strike" }, { key: "C", text: "Turkey" }, { key: "D", text: "Split" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "Three strikes in a row in bowling is called a...?",
    choices: [{ key: "A", text: "Hat trick" }, { key: "B", text: "Turkey" }, { key: "C", text: "Triple play" }, { key: "D", text: "Trifecta" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "What's the typical steeping time for a standard black tea?",
    choices: [{ key: "A", text: "30 seconds" }, { key: "B", text: "1 minute" }, { key: "C", text: "3-5 minutes" }, { key: "D", text: "15 minutes" }],
    correctChoiceKey: "C", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "In a classic board game cafe, what's usually charged for a table?",
    choices: [{ key: "A", text: "Per game rented" }, { key: "B", text: "Cover charge or hourly fee" }, { key: "C", text: "Nothing, it's free" }, { key: "D", text: "Per player, per win" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "At a comedy club, what's the term for a comedian's opening set before the headliner?",
    choices: [{ key: "A", text: "Warm-up" }, { key: "B", text: "Feature" }, { key: "C", text: "Opener" }, { key: "D", text: "Closer" }],
    correctChoiceKey: "C", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "True or False: most food trucks accept only cash.",
    choices: [{ key: "A", text: "True" }, { key: "B", text: "False" }],
    correctChoiceKey: "B", explanation: "Most modern food trucks take cards or mobile pay too.", source: "fallback" },
  { questionType: "fallback_general", questionText: "What's a common rule at dog-friendly patios?",
    choices: [{ key: "A", text: "Dogs must stay on a leash" }, { key: "B", text: "Dogs eat free" }, { key: "C", text: "Dogs must wear shoes" }, { key: "D", text: "Only puppies allowed" }],
    correctChoiceKey: "A", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "In an arcade, what do you typically trade tickets for?",
    choices: [{ key: "A", text: "More tokens" }, { key: "B", text: "Prizes" }, { key: "C", text: "Free games" }, { key: "D", text: "Nothing, they're just for scorekeeping" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: 'A "flight" of cocktails typically means...?',
    choices: [{ key: "A", text: "One large cocktail" }, { key: "B", text: "A set of small tastes of several cocktails" }, { key: "C", text: "A cocktail served in a plane cup" }, { key: "D", text: "A round for the whole table" }],
    correctChoiceKey: "B", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "What's the usual minimum age for most late-night/after-hours bar venues?",
    choices: [{ key: "A", text: "16" }, { key: "B", text: "18" }, { key: "C", text: "21" }, { key: "D", text: "25" }],
    correctChoiceKey: "C", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "On a scavenger hunt, what's another common name for a hidden checkpoint?",
    choices: [{ key: "A", text: "A clue stop" }, { key: "B", text: "A finish line" }, { key: "C", text: "A base camp" }, { key: "D", text: "A rest stop" }],
    correctChoiceKey: "A", explanation: null, source: "fallback" },
  { questionType: "fallback_general", questionText: "What's the classic first step before starting most outdoor group hikes?",
    choices: [{ key: "A", text: "A trail briefing / warm-up" }, { key: "B", text: "A cooldown stretch" }, { key: "C", text: "A group photo at the finish" }, { key: "D", text: "Nothing, you just start walking" }],
    correctChoiceKey: "A", explanation: null, source: "fallback" },
];

function pickFallback(count: number): TriviaQuestion[] {
  return shuffle(FALLBACK_QUESTION_BANK).slice(0, Math.max(0, count));
}

function generate(input: RouteContent, count: number): TriviaQuestion[] {
  const pool: TriviaQuestion[] = [];
  pushVenueCategoryMatch(pool, input);
  pushVenueNameAtOrder(pool, input);
  pushRatingTrueFalse(pool, input);
  pushStopOrderPosition(pool, input);
  pushReviewIdentifiesStop(pool, input);
  pushRouteTitleMatch(pool, input);
  pushEmojiMatch(pool, input);

  const shuffled = shuffle(pool);
  if (shuffled.length >= count) return shuffled.slice(0, count);
  return [...shuffled, ...pickFallback(count - shuffled.length)];
}

export const templateGenerator: TriviaGenerator = { generate };
