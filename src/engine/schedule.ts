/**
 * Programme position and deload scheduling.
 * Weeks are session-based, not calendar-based: a week advances only when every
 * day of that week has a completed session.
 */

export interface Block {
  id: string;
  name: string;
  /** How many weeks this block's days repeat for. */
  weeks: number;
  dayIds: string[];
}

export interface Position {
  /** 1-based global week across all blocks. */
  week: number;
  /** Index into the current block's dayIds. */
  dayIdx: number;
}

/** plan: deload when (week − anchor) % every === 0 and week !== anchor. every = 0 disables. */
export function isDeloadWeek(week: number, anchorWeek: number, every = 4): boolean {
  if (every <= 0 || week === anchorWeek) return false;
  return (week - anchorWeek) % every === 0 && week > anchorWeek;
}

export function totalWeeks(blocks: Block[]): number {
  return blocks.reduce((n, b) => n + b.weeks, 0);
}

/** Which block a global week falls in; null when the programme is finished. */
export function blockForWeek(blocks: Block[], week: number): { block: Block; weekInBlock: number } | null {
  let start = 1;
  for (const block of blocks) {
    if (week < start + block.weeks) return { block, weekInBlock: week - start + 1 };
    start += block.weeks;
  }
  return null;
}

/**
 * Advance after completing a session on `completedDayId`.
 * The week only moves on once every day in the current block has been done this week.
 */
export function advance(
  blocks: Block[],
  pos: Position,
  completedDayIdsThisWeek: string[],
): { position: Position; weekCompleted: boolean; finished: boolean } {
  const current = blockForWeek(blocks, pos.week);
  if (!current) return { position: pos, weekCompleted: false, finished: true };
  const days = current.block.dayIds;
  const done = new Set(completedDayIdsThisWeek);
  const nextUndone = days.findIndex((id) => !done.has(id));
  if (nextUndone !== -1) {
    return { position: { week: pos.week, dayIdx: nextUndone }, weekCompleted: false, finished: false };
  }
  const nextWeek = pos.week + 1;
  const finished = blockForWeek(blocks, nextWeek) == null;
  return { position: { week: nextWeek, dayIdx: 0 }, weekCompleted: true, finished };
}

export interface DerivedPosition extends Position {
  doneDayIds: string[];
  finished: boolean;
}

/**
 * Where the athlete is in the programme is DERIVED from completed sessions,
 * never stored as counters, so two devices (or an offline phone) can't clobber each other.
 *
 *   week 1: [mon ✓][wed ✓][fri ✓] → complete, look at week 2
 *   week 2: [mon ✓][wed  ][fri  ] → position = week 2, day wed
 *
 * Duplicates (the same day done twice in a week, e.g. from two devices) collapse in the Set.
 * @param completed completed, NON-deleted sessions of this athlete programme.
 */
export function derivePosition(blocks: Block[], completed: { week: number; dayId: string }[]): DerivedPosition {
  const byWeek = new Map<number, Set<string>>();
  for (const s of completed) {
    if (!byWeek.has(s.week)) byWeek.set(s.week, new Set());
    byWeek.get(s.week)!.add(s.dayId);
  }
  const total = totalWeeks(blocks);
  for (let week = 1; week <= total; week++) {
    const days = blockForWeek(blocks, week)!.block.dayIds;
    const done = byWeek.get(week) ?? new Set<string>();
    const nextIdx = days.findIndex((id) => !done.has(id));
    if (nextIdx !== -1) {
      return { week, dayIdx: nextIdx, doneDayIds: days.filter((id) => done.has(id)), finished: false };
    }
  }
  return { week: total + 1, dayIdx: 0, doneDayIds: [], finished: true };
}

/**
 * plan: offer (never force) an early deload when 2+ different exercises hit Reset within 7 days.
 * @param resets exercise id + timestamp (ms) of each Reset suggestion that was served.
 */
export function shouldOfferEarlyDeload(
  resets: { exerciseId: string; at: number }[],
  now: number,
  windowDays = 7,
): boolean {
  const since = now - windowDays * 86_400_000;
  return new Set(resets.filter((r) => r.at >= since).map((r) => r.exerciseId)).size >= 2;
}
