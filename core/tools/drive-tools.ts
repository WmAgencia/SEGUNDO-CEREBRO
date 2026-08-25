/**
 * Google Drive tools — archive agent artifacts (images, campaigns, prospecting docs).
 * Auth: Google Cloud Service Account (JWT signed RS256 via node:crypto — no SDK).
 * The user shares the target folder (e.g. "Secom") with the service account email.
 *
 * Env vars (OAuth user delegation — preferred, uploads count against user's quota):
 *   GOOGLE_DRIVE_CLIENT_ID     — OAuth client ID (Desktop app type)
 *   GOOGLE_DRIVE_CLIENT_SECRET — OAuth client secret
 *   GOOGLE_DRIVE_REFRESH_TOKEN — obtained via scripts/drive-auth.ts (one-time)
 *
 * Env vars (Service Account fallback — cannot create FILES due to Google's
 * zero-quota policy for SAs; folders still work):
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
export interface OAuthCreds { client_id: string; client_secret: string; refresh_token: string }
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

/** OAuth user credentials (preferred — uploads count against the real user's quota). */
export function loadOAuthCredentials(): OAuthCreds | null {
  const client_id = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refresh_token = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (client_id && client_secret && refresh_token) return { client_id, client_secret, refresh_token };
  return null;
}

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

/** Exchange an authorization code (one-time setup) for refresh + access tokens. */
export async function exchangeAuthCode(code: string, clientId: string, clientSecret: string, redirectUri = "urn:ietf:wg:oauth:2.0:oob"): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Code exchange failed: HTTP ${res.status} — ${await res.text()}`);
  return await res.json() as { access_token: string; refresh_token: string; expires_in: number };
}

/** Refresh an OAuth access token using the stored refresh token. */
async function refreshAccessToken(oauth: OAuthCreds): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: oauth.client_id, client_secret: oauth.client_secret, refresh_token: oauth.refresh_token, grant_type: "refresh_token" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`);
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Token refresh returned no access_token");
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

/** Get an OAuth2 access token. Prefers user OAuth (real quota), falls back to service account JWT. */
export async function getAccessToken(saCreds?: DriveCreds): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const oauth = loadOAuthCredentials();
  if (oauth) return refreshAccessToken(oauth);
  const creds = saCreds ?? loadDriveCredentials();
  if (!creds) throw new Error("NOT_CONFIGURED");
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
  const token = await getAccessToken();
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
  const configured = Boolean(loadOAuthCredentials() ?? loadDriveCredentials());
  if (!configured) return { status: "NOT_CONFIGURED", path, error: "GOOGLE_DRIVE_* env vars not configured" };
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

export interface ProjectRecordResult extends DriveUploadResult { folderPath?: string }

/**
 * Register a software project in Drive: <root>/projetos/<project-name>/registro.txt.
 * The txt records project link, credentials (master account by convention), and status.
 * No date level — one stable folder per project, updated over its lifetime.
 */
export async function archiveProjectRecord(opts: {
  projectName: string;
  link?: string;
  login?: string;
  senha?: string;
  status?: string;
  notes?: string;
}): Promise<ProjectRecordResult> {
  const slug = slugify(opts.projectName);
  const path = `projetos/${slug}/registro.txt`;
  const configured = Boolean(loadOAuthCredentials() ?? loadDriveCredentials());
  if (!configured) return { status: "NOT_CONFIGURED", path, error: "GOOGLE_DRIVE_* env vars not configured" };
  try {
    const rootName = process.env.GOOGLE_DRIVE_ROOT_FOLDER ?? "Secom";
    const rootId = await findOrCreateFolder(rootName);
    const projetosId = await findOrCreateFolder("projetos", rootId);
    const projectId = await findOrCreateFolder(slug, projetosId);

    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const lines = [
      "=== REGISTRO DO PROJETO ===",
      `Nome: ${opts.projectName}`,
      `Criado em: ${stamp}`,
      "",
      `Link: ${opts.link ?? "(a definir)"}`,
      "",
      "-- Acesso --",
      `Login: ${opts.login ?? "master"}`,
      `Senha: ${opts.senha ?? "(a definir)"}`,
      "",
      `Status: ${opts.status ?? "Iniciado"}`,
      ...(opts.notes ? ["", `Observacoes: ${opts.notes}`] : []),
      "",
    ];
    // Overwrite semantics: always named registro.txt inside the project folder.
    const uploaded = await uploadFile("registro.txt", lines.join("\r\n"), "text/plain", projectId);
    return { status: "ARCHIVED", path, fileId: uploaded.id, webViewLink: uploaded.webViewLink, folderPath: `projetos/${slug}` };
  } catch (error) {
    return { status: "FAILED", path, error: error instanceof Error ? error.message : String(error) };
  }
}
