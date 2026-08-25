/**
 * Google Drive tools — archive agent artifacts (images, campaigns, prospecting docs).
 * Auth: Google Cloud Service Account (JWT signed RS256 via node:crypto — no SDK).
 * The user shares the target folder (e.g. "Secom") with the service account email.
 *
 * Env vars:
 *   GOOGLE_DRIVE_SA_EMAIL  — service account email
 *   GOOGLE_DRIVE_SA_KEY    — private key (\n escaped) OR
 *   GOOGLE_DRIVE_SA_FILE   — path to service account JSON key file
 *   GOOGLE_DRIVE_ROOT_FOLDER — root folder name inside user's Drive (default "Secom")
 *
 * Structure created in Drive:
 *   <root>/imagens/<dd-MM-yy>/arquivo.png          (images go straight to date folder)
 *   <root>/<categoria>/<nome-da-coisa>/<data>/arquivo.ext
 */
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveCreds { client_email: string; private_key: string }
export interface DriveUploadResult {
  status: "ARCHIVED" | "NOT_CONFIGURED" | "FAILED";
  /** Logical path relative to root folder, e.g. `imagens/24-08-26/logo.png`. */
  path: string;
  fileId?: string;
  webViewLink?: string;
  error?: string;
}

interface TokenCache { token: string; expiresAt: number }
let cachedToken: TokenCache | null = null;
const folderCache = new Map<string, string>();

export function loadDriveCredentials(): DriveCreds | null {
  const file = process.env.GOOGLE_DRIVE_SA_FILE;
  if (file && existsSync(file)) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as { client_email?: string; private_key?: string };
      if (json.client_email && json.private_key) return { client_email: json.client_email, private_key: json.private_key };
    } catch { /* fall through */ }
  }
  const email = process.env.GOOGLE_DRIVE_SA_EMAIL;
  const key = process.env.GOOGLE_DRIVE_SA_KEY?.replace(/\\n/g, "\n");
  if (email && key) return { client_email: email, private_key: key };
  return null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Exchange a signed JWT for an OAuth2 access token (cached until near expiry). */
export async function getAccessToken(creds: DriveCreds): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(creds.private_key));
  const assertion = `${header}.${claims}.${signature}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google token exchange returned no access_token");
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

async function driveFetch(path: string, init?: RequestInit): Promise<Response> {
  const creds = loadDriveCredentials();
  if (!creds) throw new Error("NOT_CONFIGURED");
  const token = await getAccessToken(creds);
  return fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

/** Find a folder by name under parentId (or anywhere when omitted); create it if missing. */
export async function findOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const cacheKey = `${parentId ?? "root"}:${name}`;
  const hit = folderCache.get(cacheKey);
  if (hit) return hit;
  const clauses = [`name = '${name.replace(/'/g, "\\'")}'`, `mimeType = '${FOLDER_MIME}'`, "trashed = false"];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const q = encodeURIComponent(clauses.join(" and "));
  const searchRes = await driveFetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  if (!searchRes.ok) throw new Error(`Drive folder search failed: HTTP ${searchRes.status}`);
  const found = await searchRes.json() as { files?: Array<{ id?: string }> };
  const existing = found.files?.[0]?.id;
  if (existing) { folderCache.set(cacheKey, existing); return existing; }
  const createRes = await driveFetch(`${DRIVE_API}/files?fields=id&supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  if (!createRes.ok) throw new Error(`Drive folder create failed: HTTP ${createRes.status}`);
  const created = await createRes.json() as { id?: string };
  if (!created.id) throw new Error("Drive folder create returned no id");
  folderCache.set(cacheKey, created.id);
  return created.id;
}

/** Upload file content into a folder via multipart request. */
export async function uploadFile(fileName: string, content: string | Buffer, mimeType: string, folderId: string): Promise<{ id: string; webViewLink?: string }> {
  const boundary = `sbos-${Date.now().toString(36)}`;
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    typeof content === "string" ? Buffer.from(content, "utf8") : content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload failed: HTTP ${res.status}`);
  const data = await res.json() as { id?: string; webViewLink?: string };
  if (!data.id) throw new Error("Drive upload returned no fileId");
  return { id: data.id, webViewLink: data.webViewLink };
}

/** Normalize text into a Drive-safe slug (no accents/spaces). */
export function slugify(text: string): string {
  const slug = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "sem-nome";
}

/** Date folder label like `24-08-26` (dd-MM-yy). Hyphens instead of slashes so Windows sync works. */
export function dateFolderName(d = new Date()): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

/** Build the logical archive path for an artifact. Images skip the name level (go straight to date). */
export function buildArchivePath(category: string, fileName: string, thingName?: string): string {
  const parts = [slugify(category)];
  if (category.toLowerCase() !== "imagens" && thingName) parts.push(slugify(thingName));
  parts.push(dateFolderName());
  parts.push(fileName);
  return parts.join("/");
}

/**
 * Archive an artifact to Drive following the Secom structure.
 * - category "imagens": <root>/imagens/<date>/<file>
 * - other categories:   <root>/<category>/<thing-name>/<date>/<file>
 */
export async function archiveArtifact(opts: {
  category: string;
  fileName: string;
  content: string | Buffer;
  mimeType: string;
  thingName?: string;
}): Promise<DriveUploadResult> {
  const path = buildArchivePath(opts.category, opts.fileName, opts.thingName);
  const creds = loadDriveCredentials();
  if (!creds) return { status: "NOT_CONFIGURED", path, error: "GOOGLE_DRIVE_SA_* env vars not configured" };
  try {
    const rootName = process.env.GOOGLE_DRIVE_ROOT_FOLDER ?? "Secom";
    const rootId = await findOrCreateFolder(rootName);
    const categoryId = await findOrCreateFolder(slugify(opts.category), rootId);
    let parentId = categoryId;
    if (opts.thingName && opts.category.toLowerCase() !== "imagens") {
      parentId = await findOrCreateFolder(slugify(opts.thingName), categoryId);
    }
    const dateId = await findOrCreateFolder(dateFolderName(), parentId);
    const uploaded = await uploadFile(opts.fileName, opts.content, opts.mimeType, dateId);
    return { status: "ARCHIVED", path, fileId: uploaded.id, webViewLink: uploaded.webViewLink };
  } catch (error) {
    return { status: "FAILED", path, error: error instanceof Error ? error.message : String(error) };
  }
}
