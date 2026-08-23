import { describe, expect, it } from "vitest";
import {
  isIgnoredPath,
  parseIgnoreLines,
} from "../../core/permissions/ignore.ts";

function rulesFrom(lines: string[]) {
  return parseIgnoreLines(lines);
}

describe("permissions/ignore", () => {
  it("ignores comments and blank lines", () => {
    const rules = parseIgnoreLines(["# comment", "", "   ", ".env"]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe(".env");
  });

  describe("built-in defaults", () => {
    const rules = rulesFrom([
      ".env",
      ".env.*",
      "**/*.pem",
      "**/*.key",
      "**/secrets/**",
      "**/credentials/**",
      ".obsidian/",
      ".trash/",
      "_system/indexes/**",
    ]);

    const fileCases: Array<[string, boolean]> = [
      [".env", true],
      ["sub/.env", true],
      [".env.local", true],
      ["a/b/.env.production", true],
      ["server.pem", true],
      ["deep/nested/server.key", true],
      ["secrets/token.txt", true],
      ["a/secrets/b.txt", true],
      ["credentials/creds.json", true],
      [".obsidian/app.json", true],
      [".trash/old.md", true],
      ["_system/indexes/out.md", true],
      ["_system/templates/entity-template.md", false],
      ["notes.md", false],
      ["03 - Knowledge/vyntra.md", false],
      ["environment.md", false],
    ];

    for (const [p, expected] of fileCases) {
      it(`${expected ? "ignores" : "allows"} ${p}`, () => {
        expect(isIgnoredPath(p, false, rules)).toBe(expected);
      });
    }

    const dirCases: Array<[string, boolean]> = [
      [".obsidian", true],
      [".trash", true],
      ["secrets", true],
      ["a/credentials", true],
      ["_system/indexes", true],
      ["_system", false],
      ["01 - Projects", false],
    ];

    for (const [d, expected] of dirCases) {
      it(`${expected ? "prunes" : "keeps"} dir ${d}`, () => {
        expect(isIgnoredPath(d, true, rules)).toBe(expected);
      });
    }
  });

  it("supports anchored patterns", () => {
    const rules = rulesFrom(["/top-secret.md"]);
    expect(isIgnoredPath("top-secret.md", false, rules)).toBe(true);
    expect(isIgnoredPath("sub/top-secret.md", false, rules)).toBe(false);
  });

  it("supports nested path patterns", () => {
    const rules = rulesFrom(["logs/temp"]);
    expect(isIgnoredPath("logs/temp", false, rules)).toBe(true);
    expect(isIgnoredPath("logs/temp/inner.md", false, rules)).toBe(false);
    expect(isIgnoredPath("other/logs/temp", false, rules)).toBe(false);
  });

  it("dir-only pattern matches directory contents but not same-named files", () => {
    const rules = rulesFrom(["build/"]);
    expect(isIgnoredPath("build", true, rules)).toBe(true);
    expect(isIgnoredPath("build/out.md", false, rules)).toBe(true);
    expect(isIgnoredPath("nested/build/out.md", false, rules)).toBe(true);
    expect(isIgnoredPath("build", false, rules)).toBe(false);
    expect(isIgnoredPath("rebuild/x.md", false, rules)).toBe(false);
  });

  it("handles double-star in middle", () => {
    const rules = rulesFrom(["data/**/*.tmp"]);
    expect(isIgnoredPath("data/x/y/cache.tmp", false, rules)).toBe(true);
    expect(isIgnoredPath("data/root.tmp", false, rules)).toBe(false);
  });
});
