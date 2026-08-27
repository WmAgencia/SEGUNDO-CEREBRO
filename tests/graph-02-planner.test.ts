import { describe, expect, it } from "vitest";
import { classifyIntent, planForRequest } from "../core/orchestration/planner.ts";

describe("core/orchestration/planner (ETAPA B)", () => {
  it("SIMPLE: saudações não criam graph", () => {
    for (const msg of ["Oi", "Olá", "Ei", "Bom dia", "tudo bem?", "Valeu"]) {
      expect(classifyIntent(msg), msg).toBe("SIMPLE");
      expect(planForRequest(msg), msg).toBeNull();
    }
  });

  it("TOOL: consultas simples de uma ferramenta", () => {
    expect(classifyIntent("qual o estado do Nutriva?")).toBe("TOOL");
    expect(classifyIntent("procure sobre Vyntra")).toBe("TOOL");
    expect(classifyIntent("qual o status do whatsapp?")).toBe("TOOL");
    expect(classifyIntent("objetivos ativos")).toBe("TOOL");
    for (const msg of ["qual o estado do Nutriva?", "objetivos ativos"]) {
      expect(planForRequest(msg), msg).toBeNull();
    }
  });

  it("GRAPH: multi-etapas (clipcom funcional) cria DAG audit→verify", () => {
    const plan = planForRequest("Quero colocar o ClipCom completamente funcional", { projectId: "project.clipcom" });
    expect(plan).not.toBeNull();
    expect(plan!.projectId).toBe("project.clipcom");
    const titles = plan!.nodes.map((n) => n.title);
    expect(titles[0]).toBe("Audit");
    expect(titles.at(-1)).toBe("Verify");
    // dependências encadeadas: Audit → Identify → Architecture → Implementation → QA → Verify
    expect(plan!.nodes.find((n) => n.title === "Implementation")?.dependencies).toContain("architecture");
    expect(plan!.nodes.find((n) => n.title === "QA")?.dependencies).toContain("implementation");
    expect(plan!.nodes.find((n) => n.title === "Verify")?.dependencies).toContain("qa");
  });

  it("GRAPH: sistema de prospecção permite paralelismo Research→(Architecture|Design)", () => {
    const plan = planForRequest("Quero criar um sistema de prospecção.");
    expect(plan).not.toBeNull();
    const architecture = plan!.nodes.find((n) => n.title === "Architecture")!;
    const design = plan!.nodes.find((n) => n.title === "Design")!;
    expect(architecture.dependencies).toEqual(["research"]);
    expect(design.dependencies).toEqual(["research"]);
    const implementation = plan!.nodes.find((n) => n.title === "Implementation")!;
    expect(implementation.dependencies).toContain("architecture");
    expect(implementation.dependencies).toContain("design");
  });

  it("GRAPH: geração de vídeo", () => {
    expect(classifyIntent("quero um sistema de geração de vídeo")).toBe("GRAPH");
    expect(planForRequest("sistema de geração de video")?.nodes.length).toBeGreaterThanOrEqual(4);
  });

  it("nenhum input de node é nulo (input tem request + task)", () => {
    const plan = planForRequest("colocar o clipcom funcionando");
    for (const n of plan!.nodes) {
      expect(n.input?.request).toBeTruthy();
      expect(n.input?.task).toBeTruthy();
    }
  });

  it("PLAN cai em conversa/ferramenta quando indefinido (sem graph)", () => {
    expect(classifyIntent("quero pensar sobre a estratégia")).not.toBe("GRAPH");
  });
});