/**
 * Normalize `npm pack --json` output for npm 11 (array) and npm 12 (object).
 *
 * @param packed - raw JSON.parse result from `npm pack --json`
 * @returns The pack entry, or undefined if the input is not a recognized shape.
 */
export function normalizePackEntry(packed) {
    if (Array.isArray(packed))
        return packed[0] ?? undefined;
    if (packed && typeof packed === "object" && !Array.isArray(packed)) {
        const values = Object.values(packed);
        return values.length > 0 && typeof values[0] === "object"
            ? values[0]
            : undefined;
    }
    return undefined;
}
//# sourceMappingURL=pack.js.map