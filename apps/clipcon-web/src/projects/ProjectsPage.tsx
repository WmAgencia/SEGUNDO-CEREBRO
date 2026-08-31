import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Project } from "../api/types";
import styles from "./ProjectsPage.module.css";

export default function ProjectsPage() {
  const nav = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const { projects } = await api.listProjects();
      setProjects(projects);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const onCreate = async () => {
    if (!newName.trim()) return;
    const p = await api.createProject(newName.trim());
    setNewName("");
    setCreating(false);
    nav(`/projects/${p.id}`);
  };

  const onDelete = async (id: string) => {
    if (!confirm("Excluir projeto?")) return;
    await api.deleteProject(id);
    refresh();
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>/ projects</div>
          <h1 className={styles.title}>Projetos de Vídeo</h1>
          <p className={styles.sub}>Cada projeto é um workspace com sources, timeline e chat IA</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>+ Novo Projeto</button>
      </header>

      {creating && (
        <div className={styles.createBox}>
          <input
            autoFocus
            placeholder="Nome do projeto..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onCreate()}
          />
          <div className={styles.createActions}>
            <button onClick={onCreate} className="primary">Criar</button>
            <button onClick={() => { setCreating(false); setNewName(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      {loading && <div className={styles.empty}>carregando…</div>}
      {!loading && projects.length === 0 && (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>▣</div>
          <div className={styles.emptyTitle}>Nenhum projeto ainda</div>
          <div className={styles.emptySub}>Crie seu primeiro projeto para começar a editar</div>
        </div>
      )}

      <div className={styles.grid}>
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ project, onDelete }: { project: Project; onDelete: (id: string) => void }) {
  const nav = useNavigate();
  const [uploading, setUploading] = useState(false);

  const onUpload = async (file: File) => {
    setUploading(true);
    try {
      await api.uploadSource(project.id, file);
      nav(`/editor/${project.id}`);
    } catch (e) {
      alert(String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.cardTitle}>{project.name}</div>
        <button className={styles.iconBtn} onClick={() => onDelete(project.id)}>×</button>
      </div>
      <div className={styles.meta}>
        <span>{project.sources.length} source{project.sources.length !== 1 ? "s" : ""}</span>
        <span className={styles.dim}>·</span>
        <span className={styles.dim}>{new Date(project.updatedAt).toLocaleString("pt-BR")}</span>
      </div>
      <div className={styles.thumbs}>
        {project.sources.slice(0, 4).map((s) => (
          <div key={s.id} className={styles.thumb}>
            {s.thumb && <img src={api.fileUrl(project.id, s.thumb)} alt={s.name} />}
            {!s.thumb && <span>▶</span>}
          </div>
        ))}
        {project.sources.length === 0 && (
          <div className={styles.noThumbs}>sem mídia</div>
        )}
      </div>
      <div className={styles.actions}>
        <button onClick={() => nav(`/editor/${project.id}`)} disabled={!project.sources.length}>
          ▶ Abrir Editor
        </button>
        <button onClick={() => nav(`/clips/${project.id}`)} disabled={!project.sources.length}>
          ◢ Criar Clips
        </button>
        <label className={styles.uploadBtn}>
          {uploading ? "upando..." : "↑ Upload"}
          <input
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
          />
        </label>
      </div>
    </div>
  );
}
