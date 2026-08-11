/**
 * Normalize `npm pack --json` output for npm 11 (array) and npm 12 (object).
 *
 * @param packed - raw JSON.parse result from `npm pack --json`
 * @returns The pack entry, or undefined if the input is not a recognized shape.
 */
export declare function normalizePackEntry(packed: unknown): {
    filename: string;
    files: Array<{
        path: string;
    }>;
    version?: string;
} | undefined;
//# sourceMappingURL=pack.d.ts.map