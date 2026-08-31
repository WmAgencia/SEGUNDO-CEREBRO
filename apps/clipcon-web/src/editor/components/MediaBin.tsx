import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Source } from "../../api/types";
import { useEditorStore } from "../state/editorStore";
import styles from "./MediaBin.module.css";

export default function MediaBin() {
  const { sources, projectId, ranges } = useEditorStore();
  const [thumbLoading, setThumbLoading] = useState<Record<string, boolean>>({});
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});

  const onDragStart = (e: React.DragEvent, source: Source) => {
    e.dataTransfer.setData("application/x-clipcon-source", JSON.stringify({
      id: source.id,
      duration: source.duration,
    }));
    e.dataTransfer.effectAllowed = "copy";
  };

  const loadWaveform = async (s: Source) => {
    if (waveforms[s.id] || !s.path) return;
    try {
      const r = await api.waveform(s.path, 256);
      setWaveforms((m) => ({ ...m, [s.id]: r.peaks }));
    } catch {}
  };

  const sourceList = Object.values(sources);

  return (
    <div className={styles.bin}>
      <div className={styles.head}>
        <span className={styles.title}>MÍDIA</span>
        <span className={styles.count}>{sourceList.length}</span>
      </div>
      <div className={styles.list}>
        {sourceList.length === 0 && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>↑</div>
            <div className={styles.emptyText}>
              Vá em <b>Projetos</b> e faça upload de um vídeo
            </div>
          </div>
        )}
        {sourceList.map((s) => {
          const inUse = ranges.some((r) => r.source === s.id);
          return (
            <div
              key={s.id}
              className={`${styles.item} ${inUse ? styles.inUse : ""}`}
              draggable
              onDragStart={(e) => onDragStart(e, s)}
              onMouseEnter={() => loadWaveform(s)}
              title="Arraste para a timeline"
            >
              <div className={styles.thumb}>
                {s.thumb && projectId ? (
                  <img src={api.fileUrl(projectId, s.thumb)} alt={s.name} />
                ) : (
                  <span>▶</span>
                )}
              </div>
              <div className={styles.info}>
                <div className={styles.name}>{s.name}</div>
                <div className={styles.meta}>
                  <span>{formatDuration(s.duration)}</span>
                  {s.width && s.height && (
                    <span className={styles.dim}>· {s.width}×{s.height}</span>
                  )}
                  {s.fps && <span className={styles.dim}>· {s.fps.toFixed(0)}fps</span>}
                </div>
                {waveforms[s.id] && (
                  <div className={styles.waveform}>
                    {waveforms[s.id].map((v, i) => (
                      <span key={i} style={{ height: `${Math.max(4, v * 100)}%` }} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDuration(s?: number): string {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
