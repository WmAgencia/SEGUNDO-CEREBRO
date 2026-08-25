import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  archiveArtifact,
  buildArchivePath,
  dateFolderName,
  slugify,
  loadDriveCredentials,
  getAccessToken,
  findOrCreateFolder,
} from "../core/tools/drive-tools.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetchMock(handler: (call: FetchCall, index: number) => Response) {
  const calls: FetchCall[] = [];
  const mock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

const SA_ENV = {
  GOOGLE_DRIVE_SA_EMAIL: "sa@test.iam.gserviceaccount.com",
  GOOGLE_DRIVE_SA_KEY: TEST_PEM,
};

describe("drive tools - pure helpers", () => {
  it("slugifies accents and spaces", () => {
    expect(slugify("Prospecção Clínicas de Nutrição")).toBe("prospeccao-clinicas-de-nutricao");
    expect(slugify("!!!")).toBe("sem-nome");
  });
  it("formats date folder as dd-MM-yy", () => {
    expect(dateFolderName(new Date(2026, 7, 24))).toBe("24-08-26");
    expect(dateFolderName(new Date(2026, 0, 3))).toBe("03-01-26");
  });
  it("builds archive paths per category rules", () => {
    const imgPath = buildArchivePath("imagens", "foto.png");
    expect(imgPath).toMatch(/^imagens\/\d{2}-\d{2}-\d{2}\/foto\.png$/);
    const campaign = buildArchivePath("campanhas", "brief.txt", "Black Friday 2026");
    expect(campaign).toMatch(/^campanhas\/black-friday-2026\/\d{2}-\d{2}-\d{2}\/brief\.txt$/);
  });
});

describe("drive tools - auth", () => {
  beforeEach(() => { vi.stubEnv("GOOGLE_DRIVE_SA_EMAIL", SA_ENV.GOOGLE_DRIVE_SA_EMAIL); vi.stubEnv("GOOGLE_DRIVE_SA_KEY", SA_ENV.GOOGLE_DRIVE_SA_KEY); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("returns null credentials when env missing", () => {
    vi.stubEnv("GOOGLE_DRIVE_SA_EMAIL", ""); vi.stubEnv("GOOGLE_DRIVE_SA_KEY", "");
    expect(loadDriveCredentials()).toBeNull();
  });

  it("archiveArtifact reports NOT_CONFIGURED without env and never fetches", async () => {
    vi.stubEnv("GOOGLE_DRIVE_SA_EMAIL", ""); vi.stubEnv("GOOGLE_DRIVE_SA_KEY", "");
    const calls = installFetchMock(() => jsonResponse({}));
    const result = await archiveArtifact({ category: "imagens", fileName: "a.png", content: "x", mimeType: "image/png" });
    expect(result.status).toBe("NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });

  it("exchanges JWT for access token via form-encoded grant", async () => {
    const calls = installFetchMock(() => jsonResponse({ access_token: "tkn", expires_in: 3600 }));
    const token = await getAccessToken(loadDriveCredentials()!);
    expect(token).toBe("tkn");
    const [call] = calls;
    expect(call?.url).toContain("oauth2.googleapis.com/token");
    const body = String(call?.init?.body);
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(body).toContain("assertion=");
    const assertion = decodeURIComponent(body.split("assertion=")[1] ?? "");
    expect(assertion.split(".")).toHaveLength(3);
  });
});

describe("drive tools - archive flow", () => {
  beforeEach(() => { vi.stubEnv("GOOGLE_DRIVE_SA_EMAIL", SA_ENV.GOOGLE_DRIVE_SA_EMAIL); vi.stubEnv("GOOGLE_DRIVE_SA_KEY", SA_ENV.GOOGLE_DRIVE_SA_KEY); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("creates missing folders and uploads the file", async () => {
    vi.stubEnv("GOOGLE_DRIVE_ROOT_FOLDER", "SecomRoot");
    const calls = installFetchMock((call, index) => {
      const url = call.url;
      if (url.includes("/token")) return jsonResponse({ access_token: "tkn-flow", expires_in: 3600 });
      if (url.includes("uploadType=multipart")) return jsonResponse({ id: "file-1", webViewLink: "https://drive.google.com/file/d/file-1/view" });
      if (call.init?.method === "POST") return jsonResponse({ id: `created-${index}` });
      if (url.includes("SecomRoot")) return jsonResponse({ files: [{ id: "root-1", name: "SecomRoot" }] });
      return jsonResponse({ files: [] });
    });
    const result = await archiveArtifact({ category: "campanhas", thingName: "Natal 2026", fileName: "brief.txt", content: "texto", mimeType: "text/plain" });
    expect(result.status).toBe("ARCHIVED");
    expect(result.fileId).toBe("file-1");
    expect(result.webViewLink).toContain("file-1");
    expect(result.path).toMatch(/^campanhas\/natal-2026\/\d{2}-\d{2}-\d{2}\/brief\.txt$/);
    const createCalls = calls.filter((c) => c.init?.method === "POST" && c.url.includes("drive/v3/files?fields=id"));
    expect(createCalls.length).toBeGreaterThanOrEqual(3);
    const uploadCall = calls.find((c) => c.url.includes("uploadType=multipart"));
    const uploadBody = Buffer.from(uploadCall?.init?.body as Uint8Array).toString("utf8");
    expect(uploadBody).toContain('"name":"brief.txt"');
    expect(uploadBody).toContain("texto");
  });

  it("reuses cached folders without re-creating", async () => {
    vi.stubEnv("GOOGLE_DRIVE_ROOT_FOLDER", "SecomRoot");
    let created = 0;
    installFetchMock((call) => {
      if (call.url.includes("/token")) return jsonResponse({ access_token: "tkn-cache", expires_in: 3600 });
      if (call.url.includes("uploadType=multipart")) return jsonResponse({ id: `f-${Date.now()}` });
      if (call.init?.method === "POST") { created += 1; return jsonResponse({ id: `c-${created}` }); }
      return jsonResponse({ files: [{ id: "existing", name: "x" }] });
    });
    await archiveArtifact({ category: "relatorios", thingName: "Unico Cache", fileName: "a.txt", content: "1", mimeType: "text/plain" });
    const afterFirst = created;
    await archiveArtifact({ category: "relatorios", thingName: "Unico Cache", fileName: "b.txt", content: "2", mimeType: "text/plain" });
    expect(created).toBe(afterFirst);
  });

  it("reports FAILED when Drive API errors", async () => {
    vi.stubEnv("GOOGLE_DRIVE_ROOT_FOLDER", "SecomFalha");
    installFetchMock((call) => call.url.includes("/token")
      ? jsonResponse({ access_token: "tkn-fail", expires_in: 3600 })
      : jsonResponse({ error: "backendError" }, 500));
    const result = await archiveArtifact({ category: "imagens", fileName: "a.png", content: "x", mimeType: "image/png" });
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("500");
  });
});


