import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useEditorStore } from "./state/editorStore";
import MediaBin from "./components/MediaBin";
import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import AIPanel from "./components/AIPanel";
import Inspector from "./components/Inspector";
import ExportDialog from "./components/ExportDialog";
import styles from "./EditorPage.module.css";

export default function EditorPage() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const { setProject, setSources } = useEditorStore();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportJobId, setExportJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    api.getProject(projectId)
      .then((p) => {
        setProject(p.id, p.name);
        setSources(p.sources || []);
      })
      .catch((e) => {
        console.error(e);
        alert("Erro ao carregar projeto");
        nav("/projects");
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  const onExport = async () => {
    if (!projectId) return;
    setExporting(true);
    try {
      const { jobId } = await api.render(projectId, useEditorStore.getState().toEDL());
      setExportJobId(jobId);
    } catch (e) {
      alert("Erro: " + e);
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className={styles.loading}>carregando editor…</div>;
  if (!projectId) return <div className={styles.loading}>Selecione um projeto primeiro</div>;

  return (
    <div className={styles.editor}>
      <div className={styles.leftCol}>
        <MediaBin />
        <Inspector />
      </div>
      <div className={styles.center}>
        <div className={styles.previewWrap}>
          <Preview />
          <div className={styles.exportBar}>
            <button className="primary" onClick={onExport} disabled={exporting}>
              {exporting ? "⏳ Renderizando…" : "⏬ Exportar MP4"}
            </button>
          </div>
        </div>
        <Timeline />
      </div>
      <AIPanel />
      {exportJobId && (
        <ExportDialog
          jobId={exportJobId}
          onClose={() => setExportJobId(null)}
        />
      )}
    </div>
  );
}
