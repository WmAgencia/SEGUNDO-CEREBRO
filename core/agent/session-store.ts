/**
 * Session store — real persistence of chats and messages.
 * Backed by manager_sessions + manager_messages tables (existing schema).
 */

import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";

export interface SessionInfo {
  sessionKey: string;
  mode: string;
  topic: string | null;
  updatedAt: string;
}

export interface SessionMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export function listSessions(config: BrainConfig, limit = 50): SessionInfo[] {
  const db = new DatabaseSync(config.dbPath);
  try {
    return (db.prepare("SELECT session_key AS sessionKey, mode, topic, updated_at AS updatedAt FROM manager_sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as SessionInfo[]);
  } finally {
    db.close();
  }
}

export function getSession(config: BrainConfig, sessionKey: string): SessionInfo | null {
  const db = new DatabaseSync(config.dbPath);
  try {
    const row = db.prepare("SELECT session_key AS sessionKey, mode, topic, updated_at AS updatedAt FROM manager_sessions WHERE session_key = ?").get(sessionKey) as SessionInfo | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

export function ensureSession(config: BrainConfig, sessionKey: string): SessionInfo {
  const db = new DatabaseSync(config.dbPath);
  try {
    db.prepare(
      "INSERT INTO manager_sessions (session_key, mode) VALUES (?, 'plane') ON CONFLICT(session_key) DO UPDATE SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    ).run(sessionKey);
    return { sessionKey, mode: "plane", topic: null, updatedAt: new Date().toISOString() };
  } finally {
    db.close();
  }
}

export function persistMessage(config: BrainConfig, sessionKey: string, role: string, content: string): void {
  const db = new DatabaseSync(config.dbPath);
  try {
    db.prepare("INSERT INTO manager_sessions (session_key, mode) VALUES (?, 'plane') ON CONFLICT(session_key) DO UPDATE SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')").run(sessionKey);
    db.prepare("INSERT INTO manager_messages (session_key, role, content) VALUES (?, ?, ?)").run(sessionKey, role, content.slice(0, 8000));
  } finally {
    db.close();
  }
}

export function getMessages(config: BrainConfig, sessionKey: string, limit = 50): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  const db = new DatabaseSync(config.dbPath);
  try {
    const rows = db.prepare(
      "SELECT role, content FROM manager_messages WHERE session_key = ? ORDER BY id DESC LIMIT ?",
    ).all(sessionKey, limit) as Array<{ role: string; content: string }>;
    return rows.reverse().map((r) => ({
      role: (r.role === "user" || r.role === "assistant" || r.role === "system" ? r.role : "assistant") as "user" | "assistant" | "system",
      content: r.content,
    }));
  } finally {
    db.close();
  }
}