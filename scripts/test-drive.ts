/**
 * Smoke test: Google Drive archive.
 * Prereqs in .env.local: GOOGLE_DRIVE_SA_EMAIL, GOOGLE_DRIVE_SA_KEY (private key),
 * and the "Secom" folder shared with the service account email (Editor).
 * Run: npx tsx scripts/test-drive.ts
 */
import { archiveArtifact, loadDriveCredentials } from "../core/tools/drive-tools.ts";
import { generateImageAndArchive } from "../core/tools/image-tools.ts";

async function main() {
  if (!loadDriveCredentials()) {
    console.log("x Credenciais ausentes: defina GOOGLE_DRIVE_SA_EMAIL e GOOGLE_DRIVE_SA_KEY no .env.local");
    process.exit(1);
  }
  console.log("ok credenciais encontradas");

  console.log("TEST 1: arquivo txt de campanha");
  const txt = await archiveArtifact({
    category: "campanhas",
    thingName: "Teste Integracao",
    fileName: "brief.txt",
    content: `Brief gerado em ${new Date().toISOString()}`,
    mimeType: "text/plain",
  });
  console.log(`  ${txt.status === "ARCHIVED" ? "ok" : "x"} ${txt.status} path=${txt.path} link=${txt.webViewLink ?? txt.error}`);

  console.log("TEST 2: imagem gerada + arquivada");
  const img = await generateImageAndArchive("minimalist nutrition clinic logo, green leaf, white background");
  console.log(`  gen=${img.status} model=${img.model}`);
  console.log(`  drive=${img.archived?.status} path=${img.archived?.path} link=${img.archived?.webViewLink ?? img.archived?.error}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
