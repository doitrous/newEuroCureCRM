import { timingSafeEqual } from "node:crypto";

/** Compare secrets without leaking a useful timing signal. */
export function secretsEqual(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
