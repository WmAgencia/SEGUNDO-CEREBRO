/**
 * Nutriva authentication — scrypt password hashing + HMAC-signed tokens.
 * A ready-to-use master account is seeded automatically so login works out of the box.
 * Default: master@nutriva.com / nutriva123 (change via NUTRIVA_MASTER_PASSWORD).
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SECRET = process.env.NUTRIVA_APP_SECRET ?? "nutriva-dev-secret-change-me";
export const MASTER_EMAIL = "master@nutriva.com";
const MASTER_DEFAULT_PASSWORD = process.env.NUTRIVA_MASTER_PASSWORD ?? "nutriva123";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(password, salt, 64));
}

export interface SessionUser { id: number; tenantId: number; email: string; role: string; exp: number }

export function signToken(user: Omit<SessionUser, "exp">): string {  const payload: SessionUser = { ...user, exp: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): SessionUser | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionUser;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

/** Seed (or repair) the master account so there is ALWAYS a working login. */
export function ensureMasterUser(db: DatabaseSync): { email: string; password: string } {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL REFERENCES tenants(id),
       email TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'nutritionist',
       display_name TEXT,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     );`
  ).run();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(MASTER_EMAIL) as { id: number } | undefined;
  const hash = hashPassword(MASTER_DEFAULT_PASSWORD);
  if (!existing) {
    db.prepare("INSERT INTO users (tenant_id, email, password_hash, role, display_name) VALUES (1, ?, ?, 'master', 'Master Admin')").run(MASTER_EMAIL, hash);
  } else {
    // Garante que a senha padrão esteja sempre válida para o primeiro acesso
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, MASTER_EMAIL);
  }
  return { email: MASTER_EMAIL, password: MASTER_DEFAULT_PASSWORD };
}

export function authenticate(db: DatabaseSync, email: string, password: string): { token: string; user: SessionUser } | null {
  const row = db.prepare("SELECT id, tenant_id, email, role, password_hash FROM users WHERE email = ?").get(email.trim().toLowerCase()) as
    | { id: number; tenant_id: number; email: string; role: string; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const base: Omit<SessionUser, "exp"> = { id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role };
  const exp = Date.now() + TOKEN_TTL_MS;
  return { token: signToken(base), user: { ...base, exp } };
}
