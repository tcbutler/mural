// Which mark-making modes exist, on their own.
//
// Split out from index.ts so that naming a mode costs nothing: the estimators
// and the request types need the name and the guard, and pulling them from the
// entry point would drag both algorithms in behind them.
export type MarkMode = 'greedy' | 'tsp';

export const MARK_MODES: MarkMode[] = ['greedy', 'tsp'];

export function isMarkMode(value: unknown): value is MarkMode {
    return typeof value === 'string' && (MARK_MODES as string[]).includes(value);
}
