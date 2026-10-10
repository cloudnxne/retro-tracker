<?php $slug = 'test-lifter'; ?>
<script>
// Fixture modelled on the real trackers: helper builders + a data constant, plus UI code that must NOT run.
const W = (kg, reps) => ({ kg, reps });
const S = (name, sets, reps, rpe, rest = 120, extra = {}) => ({
  name, sets, reps, rpe, rest, ...extra,
});
const P = (pct) => Math.round(100 * pct / 2.5) * 2.5;
const NOTE = "a string with ; semicolons, [brackets] and // not a comment";
const DEFAULTS = {
  phases: [
    { name: 'Base', weeks: 3, days: [
      { name: 'Upper', exercises: [
        S('Bench Press', 3, '6-8', '7-8', 180, { kg: P(0.8), warmups: [W(60, 5)] }),
        S('Pull-ups', 3, 'AMRAP', null),
      ] },
    ] },
  ],
};
document.getElementById('app').innerHTML = 'UI code';
const lower = 'not uppercase, ignored';
</script>
