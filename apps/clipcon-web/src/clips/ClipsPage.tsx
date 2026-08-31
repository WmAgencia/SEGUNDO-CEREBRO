import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Project, Job } from "../api/types";
import styles from "./ClipsPage.module.css";

interface Short {
  name: string;
  url: string;
  size: number;
  mtime: number;
}

export default function ClipsPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [shorts, setShorts] = useState<Short[]>([]);
  const [generating, setGenerating] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [platforms, setPlatforms] = useState<string[]>(["tiktok", "reels", "shorts"]);

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setProject).catch(() => nav("/projects"));
    api.listShorts(projectId).then((r) => setShorts(r.shorts)).catch(() => {});
  }, [projectId]);

  // Poll job
  useEffect(() => {
    if (!jobId) return;
    let mounted = true;
    const poll = async () => {
      try {
        const j = await api.getJob(jobId);
        if (!mounted) return;
        setJob(j);
        if (j.status === "running" || j.status === "queued") {
          setTimeout(poll, 2000);
        } else {
          setGenerating(false);
          if (j.status === "done") {
            const r = await api.listShorts(projectId!);
            setShorts(r.shorts);
          }
        }
      } catch {}
    };
    poll();
    return () => { mounted = false; };
  }, [jobId]);

  const onGenerate = async () => {
    if (!projectId) return;
    setGenerating(true);
    setJob(null);
    try {
      const { jobId } = await api.generateShorts(projectId, { platforms });
      setJobId(jobId);
    } catch (e) {
      alert("Erro: " + e);
      setGenerating(false);
    }
  };

  const togglePlatform = (p: string) => {
    setPlatforms((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);
  };

  if (!project) return <div className={styles.loading}>carregando…</div>;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>/ clips · separado do editor</div>
          <h1 className={styles.title}>{project.name}</h1>
          <p className={styles.sub}>Pipeline automático: análise viral → cortes curtos → múltiplos formatos</p>
        </div>
      </header>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>CONFIGURAR</div>
        <div className={styles.configRow}>
          <div>
            <div className={styles.label}>Plataformas</div>
            <div className={styles.platformChips}>
              {["tiktok", "reels", "shorts", "youtube", "twitter"].map((p) => (
                <button
                  key={p}
                  className={`${styles.chip} ${platforms.includes(p) ? styles.chipActive : ""}`}
                  onClick={() => togglePlatform(p)}
                >
                  {platforms.includes(p) && "✓ "}{p}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          className="primary"
          disabled={generating || !platforms.length || !project.sources.length}
          onClick={onGenerate}
        >
          {generating ? "⏳ Gerando…" : "🎬 Gerar Clips Virais"}
        </button>
        {job && (
          <div className={styles.jobStatus}>
            <span className={`${styles.dot} ${styles[job.status]}`} />
            <span>{job.status.toUpperCase()}</span>
            {job.status === "error" && <span className={styles.err}> · {job.error?.slice(-200)}</span>}
          </div>
        )}
      </section>

      {shorts.length > 0 && (
        <section className={styles.shortsSection}>
          <div className={styles.panelTitle}>SHORTS GERADOS · {shorts.length}</div>
          <div className={styles.shortsGrid}>
            {shorts.map((s) => (
              <div key={s.url} className={styles.shortCard}>
                <video src={s.url} controls className={styles.shortVideo} />
                <div className={styles.shortMeta}>
                  <div className={styles.shortName}>{s.name}</div>
                  <a href={s.url} download={s.name}>
                    <button>⏬ Baixar</button>
                  </a>
                </div>
                <div className={styles.shortSize}>
                  {(s.size / (1024*1024)).toFixed(1)} MB
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {shorts.length === 0 && !generating && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◢</div>
          <div className={styles.emptyTitle}>Nenhum clip gerado ainda</div>
          <div className={styles.emptySub}>Clique em "Gerar Clips Virais" para começar</div>
        </div>
      )}

      {project.sources.length === 0 && (
        <div className={styles.warn}>
          ⚠ Este projeto não tem fontes de vídeo. Vá em Projetos para fazer upload.
        </div>
      )}
    </div>
  );
}
