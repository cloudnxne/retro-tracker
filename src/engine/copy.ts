import type { Suggestion, Units } from './types';

export interface SuggestionLine {
  glyph: '▲' | '=' | '↺' | '?';
  text: string;
}

export const formatWeight = (n: number) => String(Math.round(n * 100) / 100);

/** One coach-voice line per outcome. Never red, never "fail". */
export function suggestionLine(
  s: Suggestion,
  units: Units,
  last?: { kg: number | null; reps: number | null } | null,
): SuggestionLine {
  const w = s.weight != null ? `${formatWeight(s.weight)} ${units}` : 'Same weight';
  const top = Math.max(...s.repTargets);
  switch (s.outcome) {
    case 'first-time':
      return { glyph: '?', text: `First time: pick a weight for ${top} reps` };
    case 'increase':
      if (s.weight == null || s.weight === s.basedOnWeight) {
        return { glyph: '▲', text: `${top} reps · you owned it last time` };
      }
      return {
        glyph: '▲',
        text:
          last?.kg != null && last.reps != null
            ? `${w} · you owned ${formatWeight(last.kg)} × ${last.reps} last time`
            : `${w} · you owned it last time`,
      };
    case 'hold': {
      const set = s.focusSet ?? 1;
      return { glyph: '=', text: `${w} · go for ${s.repTargets[set - 1]} on set ${set}` };
    }
    case 'miss':
      return { glyph: '=', text: `${w} · same again, last time got tough` };
    case 'reset':
      return { glyph: '↺', text: `${w} · reload and build back up` };
  }
}
