/**
 * Make `JSON.stringify` accept `BigInt` by serialising it as a
 * decimal string. Money values are stored as `bigint` in this
 * codebase (CLAUDE.md invariant 1) and the wire format must be
 * a string to preserve precision across language boundaries —
 * JavaScript clients lose precision past 2^53 with `number`.
 *
 * Importing this module installs the patch as a side effect.
 * Imported once from `src/server.ts`.
 */

declare global {
  interface BigInt {
    toJSON(): string
  }
}

if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function (this: bigint) {
      return this.toString()
    },
    writable: true,
    configurable: true,
  })
}

export {}
