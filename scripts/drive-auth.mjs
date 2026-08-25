/**
 * One-time Google Drive OAuth setup (self-contained, no deps).
 * Run: node scripts/drive-auth.mjs
 * Reads GOOGLE_DRIVE_CLIENT_ID/SECRET from .env.local, opens localhost:53682,
 * exchanges the code and appends GOOGLE_DRIVE_REFRESH_TOKEN to .env.local.
 */
import http from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const envPath = new URL("../.env.local", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("x Defina GOOGLE_DRIVE_CLIENT_ID e GOOGLE_DRIVE_CLIENT_SECRET no .env.local");
  process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://localhost:${PORT}`;
const scope = "https://www.googleapis.com/auth/drive";
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

console.log("AUTH_URL:" + authUrl);
console.log(`Aguardando autorizacao na porta ${PORT}...`);

const server = http.createServer(async (req, res) => {
  if (!req.url) return;
  const u = new URL(req.url, redirectUri);
  const code = u.searchParams.get("code");
  const error = u.searchParams.get("error");
  if (error) { console.error("x Autorizacao negada: " + error); res.end("Erro: " + error); server.close(); process.exit(1); }
  if (!code) return;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h1>Autorizado! Pode fechar esta aba.</h1>");
  server.close();
  try {
    const body = new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }).toString();
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const tokens = await r.json();
    console.log("REFRESH_TOKEN:" + tokens.refresh_token);
    appendFileSync(envPath, `\nGOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log("OK: token salvo no .env.local");
    process.exit(0);
  } catch (e) {
    console.error("x Falha ao trocar codigo: " + (e?.message ?? e));
    process.exit(1);
  }
});
server.listen(PORT);
