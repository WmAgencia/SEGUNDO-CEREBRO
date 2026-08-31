import type { FastifyInstance } from "fastify";
import { chat } from "../lib/nexxus.ts";
import { getProject, updateProject } from "../lib/storage.ts";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  patches?: EdlPatch[];
}

export type EdlPatch =
  | { op: "trim"; clipId: string; start?: number; end?: number }
  | { op: "split"; clipId: string; at: number }
  | { op: "delete"; clipId: string }
  | { op: "move"; clipId: string; track?: number; start?: number }
  | { op: "add"; source: string; track: number; start: number; duration: number }
  | { op: "color"; clipId: string; grade: string }
  | { op: "fade"; clipId: string; fadeIn?: number; fadeOut?: number }
  | { op: "fadein"; clipId: string; duration: number }
  | { op: "fadeout"; clipId: string; duration: number }
  | { op: "render" }
  | { op: "ai_autonomous" };

export default async function chatRoutes(app: FastifyInstance) {
  app.get("/api/chat", { websocket: true }, (socket, req) => {
    console.log("[chat] client connected");

    socket.on("message", async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid json" }));
        return;
      }

      const { type, projectId, text, edl, autonomous } = msg;
      if (type !== "user_msg") return;

      const project = projectId ? getProject(projectId) : null;
      const history: ChatMessage[] = (project as any)?.chatHistory || [];
      history.push({ id: `m_${Date.now()}`, role: "user", content: text, ts: Date.now() });

      try {
        // Prompt em JSON para garantir resposta estruturada
        let systemPrompt: string;

        if (autonomous) {
          // Modo autônomo: o modelo decide sozinho o que fazer
          const edlInfo = buildEdlContext(edl);
          systemPrompt = `Você é a IA de edição de vídeo do ClipCon. Responda EXATAMENTE com JSON válido.

${edlInfo}

Instruções:
- Aplique patches que melhorem o vídeo automaticamente: cinematic grade, fades, cortes
- Ao final, inclua sempre {"op":"render"} para exportar
- IDs dos clips estão listados no EDL acima

Formato obrigatório (NADA além do JSON):
{"text":"sua resposta em PT-BR","patches":[{"op":"color","clipId":"...","grade":"cinematic"}]}`;
        } else if (edl) {
          // Modo normal com EDL
          const edlInfo = buildEdlContext(edl);
          systemPrompt = `Você é a IA de edição de vídeo do ClipCon. Responda EXATAMENTE com JSON válido.

${edlInfo}

Operações disponíveis: trim, split, delete, move, add, color, fade, render
Responda em PT-BR. IDs dos clips estão listados acima.

Formato obrigatório (NADA além do JSON):
{"text":"sua resposta em PT-BR","patches":[{"op":"color","clipId":"...","grade":"cinematic"}]}`;
        } else {
          // Sem EDL — conversa livre
          systemPrompt = "Você é a IA assistente do ClipCon. Responda em PT-BR de forma concisa.";
        }

        const messages = [
          { role: "system" as const, content: systemPrompt },
          ...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
        ];

        socket.send(JSON.stringify({ type: "thinking" }));

        const useJson = !!(edl || autonomous);
        const reply = await chat(messages, {
          temperature: 0.4,
          max_tokens: 1500,
          json: useJson,
        });
        console.log("[nexxus raw]", reply.slice(0, 400));

        let cleanText = reply;
        let patches: EdlPatch[] = [];

        if (useJson) {
          try {
            const parsed = JSON.parse(reply) as { text?: string; patches?: unknown[] };
            cleanText = (parsed.text || "").trim();
            patches = (parsed.patches || []).filter(
              (p): p is EdlPatch => p !== null && typeof p === "object" && "op" in p
            );
          } catch (e) {
            console.warn("[extract] JSON parse failed, falling back to text extraction", e);
            patches = extractPatches(reply);
            cleanText = reply.replace(/```[\s\S]*?```/g, "").replace(/\{[\s\S]*?\}/g, "").trim();
          }
        } else {
          patches = extractPatches(reply);
          cleanText = reply.replace(/```[\s\S]*?```/g, "").trim();
        }

        // Se autonomous==false mas o patch é ai_autonomous, sinaliza ao cliente
        if (patches.some((p) => p.op === "ai_autonomous") && !autonomous) {
          socket.send(JSON.stringify({ type: "autonomous_requested" }));
        }

        // Responde ao cliente com o que conseguimos extrair
        socket.send(JSON.stringify({
          type: "assistant_msg",
          content: cleanText || reply,
          patches,
          ts: Date.now(),
        }));

        // Persiste histórico
        history.push({ id: `m_${Date.now()}`, role: "assistant", content: cleanText, ts: Date.now(), patches });
        if (project) {
          updateProject(projectId, { chatHistory: history.slice(-100) } as any);
        }
      } catch (err) {
        console.error("[chat] error", err);
        socket.send(JSON.stringify({ type: "error", error: String(err) }));
      }
    });

    socket.on("close", () => console.log("[chat] client disconnected"));
  });

  app.get("/api/projects/:id/chat", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: "not found" });
    return { history: (project as any).chatHistory || [] };
  });
}

function buildEdlContext(edl: any): string {
  if (!edl) return "";
  const sources = edl.sources
    ? Object.entries(edl.sources).map(([id, s]: [string, any]) =>
        `- ${id}: "${s.name}" (${s.duration?.toFixed(1)}s @ ${s.fps?.toFixed(0)}fps)`
      ).join("\n")
    : "(nenhuma)";
  const ranges = (edl.ranges || []).map((r: any) =>
    `  ${r.id} | src:${r.source} | track:${r.track} | tl:${r.start?.toFixed(1)}s | dur:${r.duration?.toFixed(1)}s`
  ).join("\n") || "(vazio)";
  return `**EDL ATUAL:**
Sources:\n${sources}
Ranges:\n${ranges}`;
}

function extractPatches(text: string): EdlPatch[] {
  // ```json ...```
  const m1 = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (m1) {
    try {
      const p = JSON.parse(m1[1].trim());
      return extractFromParsed(p);
    } catch {}
  }
  // ```patches ...```
  const m2 = text.match(/```patches\s*([\s\S]*?)\s*```/);
  if (m2) {
    try {
      const p = JSON.parse(m2[1].trim());
      return extractFromParsed(p);
    } catch {}
  }
  // objeto ou array solto
  const m3 = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m3) {
    try {
      const p = JSON.parse(m3[1]);
      return extractFromParsed(p);
    } catch {}
  }
  return [];
}

function extractFromParsed(parsed: unknown): EdlPatch[] {
  if (Array.isArray(parsed)) return parsed.filter((p) => p && typeof p === "object" && "op" in p) as EdlPatch[];
  if (parsed && typeof parsed === "object" && "patches" in parsed) {
    const p = parsed as { patches: unknown[] };
    return (p.patches || []).filter((x) => x && typeof x === "object" && "op" in x) as EdlPatch[];
  }
  return [];
}
