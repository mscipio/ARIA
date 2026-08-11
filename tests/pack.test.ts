import { describe, expect, it } from "vitest";

import { normalizePackEntry } from "../src/pack";

describe("normalizePackEntry", () => {
  it("returns the first element of an npm 11 array", () => {
    const input = [
      {
        name: "pkg",
        version: "1.0.0",
        filename: "pkg-1.0.0.tgz",
        files: [{ path: "package.json", size: 200, mode: 420 }],
      },
    ];
    const entry = normalizePackEntry(input);
    expect(entry?.filename).toBe("pkg-1.0.0.tgz");
    expect(entry?.files).toHaveLength(1);
  });

  it("returns the first value of an npm 12 object", () => {
    const input = {
      pkg: {
        name: "pkg",
        version: "1.0.0",
        filename: "pkg-1.0.0.tgz",
        files: [{ path: "package.json", size: 200, mode: 420 }],
      },
    };
    const entry = normalizePackEntry(input);
    expect(entry?.filename).toBe("pkg-1.0.0.tgz");
    expect(entry?.files).toHaveLength(1);
  });

  it("returns undefined for an empty array", () => {
    expect(normalizePackEntry([])).toBeUndefined();
  });

  it("returns undefined for an empty object", () => {
    expect(normalizePackEntry({})).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(normalizePackEntry(null)).toBeUndefined();
  });

  it("returns undefined for a non-object", () => {
    expect(normalizePackEntry("string")).toBeUndefined();
  });
});
