import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import {
  assignAgentToInstance, instanceForAgent, planInstanceForAgent, setConnected, listInstances,
} from "../core/comms/instance-state.ts";

let dir: string;
let db: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wa-multi-"));
  db = openDatabase(path.join(dir, "b.db"));
  applySchema(db);
});

afterAll(() => {
  try { db.close(); rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("WhatsApp multi-instância por agente", () => {
  it("cada atendente obtém uma instância DEDICADA (planInstanceForAgent)", () => {
    // sem instâncias existentes → primeira livre é whatsapp-1
    const a1 = planInstanceForAgent(db, "sales-agent-01", []);
    expect(a1).toBe("whatsapp-1");
    // com whatsapp-1 já ocupada → próxima é whatsapp-2
    const a2 = planInstanceForAgent(db, "sales-agent-02", ["whatsapp-1"]);
    expect(a2).toBe("whatsapp-2");
    // reusa a instância já vinculada ao agente (não troca)
    const a1b = planInstanceForAgent(db, "sales-agent-01", []);
    expect(a1b).toBe("whatsapp-1");
  });

  it("instância vinculada fica associada a UM agente (não é compartilhada)", () => {
    db.prepare("DELETE FROM whatsapp_instances").run();
    assignAgentToInstance(db, "wa-01", "sales-agent-01");
    // tentar atribuir outro agente à MESMA não deve acontecer; e o agente 2 não rouba
    expect(instanceForAgent(db, "sales-agent-01")?.name).toBe("wa-01");
    expect(instanceForAgent(db, "sales-agent-02")).toBeNull();
  });

  it("conectar/desconectar reflete no estado e no agente", () => {
    db.prepare("DELETE FROM whatsapp_instances").run();
    assignAgentToInstance(db, "wa-02", "sales-agent-03");
    setConnected(db, "wa-02", true, "+5515900000000");
    const inst = instanceForAgent(db, "sales-agent-03");
    expect(inst?.connected).toBe(true);
    expect(inst?.assignedAgent).toBe("sales-agent-03");
    setConnected(db, "wa-02", false);
    expect(instanceForAgent(db, "sales-agent-03")?.connected).toBe(false);
  });

  it("listInstances expõe assignedAgent para o painel", () => {
    db.prepare("DELETE FROM whatsapp_instances").run();
    assignAgentToInstance(db, "wa-04", "sales-agent-04");
    const names = listInstances(db).map((i) => `${i.name}=${i.assignedAgent}`);
    expect(names).toContain("wa-04=sales-agent-04");
  });
});
