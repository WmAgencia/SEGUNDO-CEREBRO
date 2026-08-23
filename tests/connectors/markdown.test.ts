import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../connectors/obsidian/markdown.ts";

describe("connectors/markdown parser", () => {
  const sample = `---
id: project.vyntra
type: project
title: Vyntra
status: active
created_at: 2026-01-15
updated_at: 2026-08-20
tags:
  - vendas
  - ia
aliases:
  - VYNTRA Oficial
relations:
  - type: USES
    target: system.whatsapp-automation
---

# Vyntra

Plataforma de [[Sales Operating System|SOS]] para times comerciais.

Usa também [[system.whatsapp-automation]] e vê [[Prospector#Integrações]].

\`\`\`md
[[link-falso-em-codigo]]
\`\`\`

Tag inline #urgente no meio do texto.

## Contexto

Conteúdo da seção.
`;

  it("parses frontmatter fields", () => {
    const note = parseMarkdown(sample, "01 - Projects/Vyntra.md");
    expect(note.id).toBe("project.vyntra");
    expect(note.type).toBe("project");
    expect(note.status).toBe("active");
    expect(note.title).toBe("Vyntra");
    expect(note.createdAt).toBe("2026-01-15");
    expect(note.updatedAt).toBe("2026-08-20");
  });

  it("extracts tags from frontmatter and body", () => {
    const note = parseMarkdown(sample, "x.md");
    expect(note.tags).toContain("vendas");
    expect(note.tags).toContain("ia");
    expect(note.tags).toContain("urgente");
  });

  it("extracts aliases", () => {
    const note = parseMarkdown(sample, "x.md");
    expect(note.aliases).toEqual(["VYNTRA Oficial"]);
  });

  it("extracts explicit relations normalized to uppercase", () => {
    const note = parseMarkdown(sample, "x.md");
    expect(note.explicitRelations).toEqual([
      { type: "USES", target: "system.whatsapp-automation" },
    ]);
  });

  it("extracts wiki links excluding code blocks and headings refs", () => {
    const note = parseMarkdown(sample, "x.md");
    const targets = note.wikiLinks.map((l) => l.target);
    expect(targets).toContain("Sales Operating System");
    expect(targets).toContain("system.whatsapp-automation");
    expect(targets).toContain("Prospector");
    expect(targets).not.toContain("link-falso-em-codigo");

    const prospector = note.wikiLinks.find((l) => l.target === "Prospector");
    expect(prospector?.heading).toBe("Integrações");

    const sos = note.wikiLinks.find((l) => l.target === "Sales Operating System");
    expect(sos?.display).toBe("SOS");
  });

  it("extracts headings with levels", () => {
    const note = parseMarkdown(sample, "x.md");
    expect(note.headings).toEqual([
      { level: 1, text: "Vyntra" },
      { level: 2, text: "Contexto" },
    ]);
  });

  it("falls back to filename as title when absent", () => {
    const note = parseMarkdown("sem título nenhum", "03 - Knowledge/nota-solta.md");
    expect(note.title).toBe("nota-solta");
    expect(note.id).toBeUndefined();
  });

  it("supports string tags and title from first H1", () => {
    const raw = `---
tags: a, b
---
# Meu Título
texto`;
    const note = parseMarkdown(raw, "x.md");
    expect(note.tags).toEqual(["a", "b"]);
    expect(note.title).toBe("Meu Título");
  });

  it("tolerates broken frontmatter", () => {
    const raw = `---
id: [unclosed
---
corpo`;
    const note = parseMarkdown(raw, "x.md");
    expect(note.frontmatter).toEqual({});
    expect(note.body).toBe(raw);
    expect(note.id).toBeUndefined();
  });

  it("parses frontmatter in UTF-8 BOM files (PowerShell)", () => {
    const raw = "\uFEFF---\r\nid: project.bom\r\ntitle: BOM Note\r\n---\r\n\r\ncorpo limpo";
    const note = parseMarkdown(raw, "x.md");
    expect(note.id).toBe("project.bom");
    expect(note.title).toBe("BOM Note");
    expect(note.body).not.toContain("id:");
  });
});
