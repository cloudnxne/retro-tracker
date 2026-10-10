# Design system

The exact values live in `src/styles/tokens.css`. This file explains the rules behind them. If you change a token, keep both in step.

## Look and feel

The app is sleek and modern with a few 80s touches. An early version went fully retro (neon glow, scanlines, grid floors) and it got in the way, so it was pared back.

- **Dark theme, "Sunset Chrome":** warm graphite background, Space Grotesk throughout and a sunset-gradient DONE button.
- **Light theme, "Daylight":** white cards, Archivo italic headings and a teal DONE button.
- **Shared layout:** one big centred card for the current set, plus progress dots that open the full set list.
- **The 80s touches:** the three-stripe sunset in the header, the striped half-sun on the session complete screen, synth sounds and italic display type.

The theme follows the phone's setting and can be overridden in Me → Theme. It is resolved before the first paint, so there is no flash of the wrong theme.

## Two zones

- **Logging zone** (everything between the header and the DONE button, including the rest bar and sheets). Readability mid-set comes first:
  - flat surfaces and solid colours only
  - no glows, gradient text, scanlines or animated backgrounds
  - tabular numerals so weights and reps don't jump around
- **Frame zone** (the header strip and the welcome, session complete, PR, block complete and empty screens). This is where the personality goes: display type, the sunset stripes and one animated moment per screen.

## Colour

Every colour has exactly one meaning, so users can learn what it signals.

| Token | Means |
| --- | --- |
| `--active` | The active set |
| `--accent` | The DONE / primary button only |
| `--done` | A confirmed set and a successful sync |
| `--rest` | The rest timer |
| `--rpe` | RPE and DELOAD |
| `--warn` | A failed sync or a destructive action |

## Type, spacing and touch

- Fonts are self-hosted with `@fontsource`, so they work offline.
- Type scale: 14 labels, 16 body, 20 meta, 26 exercise name, 64 for the main weight and reps.
- Spacing is on a 4/8px grid with 16px screen gutters.
- Touch targets are at least 48px, and 64px for DONE and the −/+ buttons.
- Motion uses one ease-out curve: 150ms confirm pulse, 200ms slide, 220ms sheet.

## Accessibility

- **Contrast:** numerals and DONE text at least 7:1. Other text at least 4.5:1, and borders and chips at least 3:1. Checked automatically with axe in the Playwright tests.
- **Size:** 14px minimum for any label and 16px for anything read mid-set.
- **Never colour alone:**
  - the active set has a label, a border and larger numerals
  - done sets show a ✓ and the RPE
  - DELOAD always carries the word
  - the sync badge has an icon and text
- **Screen readers:**
  - proper landmarks
  - a labelled set card ("Set 2 of 4, 82.5 kilograms, 8 reps")
  - DONE reads "Log set 2: 82.5 kilograms for 8 reps"
  - a polite live region announces logged sets and the end of rest
  - sheets are dialogs with focus trapped and restored
- **Keyboard:** logical tab order, Enter or Space on DONE logs the set, and Esc closes sheets. Desktop gets extra shortcuts (press `?` in a session).
- **Text zoom:** the layout holds at 200% text size.
- **Motion and sound:** `prefers-reduced-motion` is honoured and there is nothing that flashes. Every sound has a visual and haptic equivalent and can be turned off.
