/**
 * Narrow chat()'s turn-gate union. These suites drive
 * sequential turns, so a busy refusal is always a test bug — throw loudly
 * rather than letting an assertion read fields off the refusal shape.
 */
export function asTurn<T extends object>(result: T | { busy: true }): T {
  if ("busy" in result) {
    throw new Error("unexpected turn-gate busy refusal in a sequential test");
  }
  return result;
}
