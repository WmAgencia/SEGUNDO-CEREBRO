import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listProjects,
  getProject,
  createProject,
  deleteProject,
  updateProject,
} from "../lib/storage.ts";

const CreateBody = z.object({ name: z.string().min(1).max(120) });

export default async function projectsRoutes(app: FastifyInstance) {
  app.get("/api/projects", async () => ({ projects: listProjects() }));

  app.get("/api/projects/:id", async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return reply.code(404).send({ error: "not found" });
    return project;
  });

  app.post("/api/projects", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const project = createProject(parsed.data.name);
    return reply.code(201).send(project);
  });

  app.patch("/api/projects/:id", async (req, reply) => {
    const id = (req.params as any).id;
    const project = updateProject(id, req.body as any);
    if (!project) return reply.code(404).send({ error: "not found" });
    return project;
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const id = (req.params as any).id;
    const ok = deleteProject(id);
    return { ok };
  });
}
