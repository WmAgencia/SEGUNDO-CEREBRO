import { describe, expect, it } from "vitest";
import { chunkBody } from "../../core/indexing/chunker.ts";

describe("indexing/chunker", () => {
  it("splits by headings and tracks heading path", () => {
    const body = `Intro do documento.

## Alpha

conteúdo alpha linha 1
conteúdo alpha linha 2

### Alpha Filho

conteúdo filho

## Beta

conteúdo beta`;

    const chunks = chunkBody(body, "Doc");
    const headings = chunks.map((c) => c.heading);

    expect(headings[0]).toBe("Doc");
    expect(headings).toContain("Alpha");
    expect(headings).toContain("Alpha > Alpha Filho");
    expect(headings).toContain("Beta");

    const alphaChild = chunks.find((c) => c.heading === "Alpha > Alpha Filho");
    expect(alphaChild?.content).toContain("conteúdo filho");

    const beta = chunks.find((c) => c.heading === "Beta");
    expect(beta?.content).toContain("conteúdo beta");
  });

  it("keeps ordinals sequential", () => {
    const chunks = chunkBody("# T\n\na\n\n## B\n\nb", "T");
    chunks.forEach((chunk, index) => {
      expect(chunk.ordinal).toBe(index);
    });
  });

  it("splits very long sections at paragraph boundaries", () => {
    const paragraph = "paragrafo ".repeat(120);
    const body = Array.from({ length: 6 }, () => paragraph).join("\n\n");
    const chunks = chunkBody(body, "Longo");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThan(4000);
    }
  });

  it("ignores headings inside code fences", () => {
    const body = `antes

\`\`\`
## não é heading
\`\`\`

depois`;
    const chunks = chunkBody(body, "Doc");
    expect(chunks.every((c) => !c.content.includes("não é heading") || c.heading === "Doc")).toBe(true);
    expect(chunks.map((c) => c.heading)).toEqual(["Doc"]);
  });

  it("returns empty for empty body except title placeholder", () => {
    const chunks = chunkBody("", "Doc");
    expect(chunks).toHaveLength(0);
  });
});
