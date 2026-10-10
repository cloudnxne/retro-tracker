/** "1 workout", "1,059 workouts", "1 cardio entry". */
export const fmtCount = (n = 0) => n.toLocaleString();
export const count = (n: number | undefined, one: string, many = `${one}s`) => `${fmtCount(n)} ${(n ?? 0) === 1 ? one : many}`;
