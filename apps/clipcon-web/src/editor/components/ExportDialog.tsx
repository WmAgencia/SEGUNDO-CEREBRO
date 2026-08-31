import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Job } from "../../api/types";
import { useEditorStore } from "../state/editorStore";
import styles from "./ExportDialog.module.css";

export default function ExportDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const projectId = useEditorStore((s) => s.projectId);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const j = await api.getJob(jobId);
        if (!mounted) return;
        setJob(j);
        if (j.status === "running" || j.status === "queued") {
          setTimeout(poll, 1500);
        }
      } catch (e) {
        console.error(e);
      }
    };
    poll();
    return () => { mounted = false; };
  }, [jobId]);

  const fileUrl = job?.status === "done" && projectId
    ? api.fileUrl(projectId, "edit/final.mp4")
    : null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <span className={styles.title}>EXPORTAR VÍDEO</span>
          <button className={styles.close} onClick={onClose}>×</button>
        </div>

        <div className={styles.body}>
          {!job && <div>iniciando…</div>}
          {job && (
            <>
              <div className={styles.statusRow}>
                <span className={`${styles.dot} ${styles[job.status]}`} />
                <span>{job.status.toUpperCase()}</span>
                {job.type && <span className={styles.dim}>· {job.type}</span>}
              </div>

              {job.status === "running" && (
                <div className={styles.progress}>
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{ width: `${job.progress || 30}%` }} />
                  </div>
                  <div className={styles.dim}>renderizando via ffmpeg + helpers Python…</div>
                </div>
              )}

              {job.status === "done" && fileUrl && (
                <div className={styles.success}>
                  <div className={styles.successIcon}>✓</div>
                  <div className={styles.successText}>Renderização completa</div>
                  <video src={fileUrl} controls className={styles.preview} />
                  <div className={styles.actions}>
                    <a href={fileUrl} download="final.mp4">
                      <button className="primary">⏬ Baixar MP4</button>
                    </a>
                    <button onClick={onClose}>Fechar</button>
                  </div>
                </div>
              )}

              {job.status === "error" && (
                <div className={styles.error}>
                  <div className={styles.errorTitle}>Erro no render</div>
                  <pre className={styles.errorText}>{job.error}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
