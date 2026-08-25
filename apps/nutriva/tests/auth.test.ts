import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initNutrivaSchema, ensureDefaultTenant } from "../src/db/nutriva-schema.ts";
import { authenticate, ensureMasterUser, hashPassword, signToken, verifyPassword, verifyToken } from "../src/services/auth.ts";

function setup(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initNutrivaSchema(db);
  ensureDefaultTenant(db);
  return db;
}

describe("nutriva — auth", () => {
  it("faz seed do master e autentica com a senha padrao", () => {
    const db = setup();
    const creds = ensureMasterUser(db);
    expect(creds.email).toBe("master@nutriva.com");
    expect(creds.password.length).toBeGreaterThan(5);
    const result = authenticate(db, creds.email, creds.password);
    expect(result).not.toBeNull();
    expect(result!.user.role).toBe("master");
    expect(result!.user.tenantId).toBe(1);
  });

  it("rejeita senha errada", () => {
    const db = setup();
    const creds = ensureMasterUser(db);
    expect(authenticate(db, creds.email, "senha-errada")).toBeNull();
    expect(authenticate(db, "inexistente@x.com", "qualquer")).toBeNull();
  });

  it("hash de senha e verificacao funcionam (scrypt+salt)", () => {
    const h = hashPassword("abc123");
    expect(h).toContain(":");
    expect(h).not.toContain("abc123");
    expect(verifyPassword("abc123", h)).toBe(true);
    expect(verifyPassword("abc124", h)).toBe(false);
  });

  it("token assinado valida e expira corretamente", () => {
    const base = { id: 1, tenantId: 1, email: "master@nutriva.com", role: "master" };
    const token = signToken(base);
    const payload = verifyToken(token)!;
    expect(payload.email).toBe(base.email);
    expect(payload.exp).toBeGreaterThan(Date.now());
    // token adulterado deve falhar
    expect(verifyToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(verifyToken("lixo")).toBeNull();
  });
});
