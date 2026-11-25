// Identifies how player workloads are allocated, so pre-lock predictions saved under
// an older method are regenerated.
export const PLAYER_PROJECTION_METHOD = 2;

// Player props stay out of Best Bets and the Weekly Multi until the projections show a
// real edge against bookmaker lines. Graded on saved Week 8-11 lines, method 2 won 44%
// of 135 qualifying props while claiming 67%; about 53% is needed to break even.
// Projections themselves are still produced and displayed.
export const PLAYER_PROPS_HELD = true;
