import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../state/editorStore";
import { api } from "../../api/client";
import styles from "./Preview.module.css";

export default function Preview() {
  const ref = useRef<HTMLVideoElement>(null);
  const { ranges, sources, playhead, setPlayhead, isPlaying, setPlaying } = useEditorStore();
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Acha o range que cobre o playhead
  const currentRange = ranges.find((r) => playhead >= r.start && playhead < r.start + r.duration);
  const currentSource = currentRange ? sources[currentRange.source] : null;
  const projectId = useEditorStore((s) => s.projectId);

  useEffect(() => {
    if (!currentRange || !currentSource || !projectId) {
      setVideoSrc(null);
      return;
    }
    const url = api.fileUrl(projectId, currentSource.relPath);
    setVideoSrc(url);
    setError(null);
  }, [currentRange?.id, currentSource?.id, projectId]);

  // Sincroniza o tempo do vídeo com o playhead
  useEffect(() => {
    const v = ref.current;
    if (!v || !currentRange) return;
    const localTime = (currentRange.inPoint ?? 0) + (playhead - currentRange.start);
    if (Math.abs(v.currentTime - localTime) > 0.1) {
      try { v.currentTime = localTime; } catch {}
    }
  }, [playhead, currentRange?.id]);

  // Play/pause
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (isPlaying && videoSrc) {
      v.play().catch(() => setPlaying(false));
    } else {
      v.pause();
    }
  }, [isPlaying, videoSrc]);

  // Avança playhead quando o vídeo toca
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onTimeUpdate = () => {
      if (!isPlaying || !currentRange) return;
      const localTime = v.currentTime - (currentRange.inPoint ?? 0);
      const newPlayhead = currentRange.start + localTime;
      if (newPlayhead > currentRange.start + currentRange.duration) {
        // Range acabou
        const nextRange = ranges
          .filter((r) => r.start >= currentRange.start + currentRange.duration)
          .sort((a, b) => a.start - b.start)[0];
        if (nextRange) setPlayhead(nextRange.start);
        else setPlaying(false);
      } else {
        setPlayhead(newPlayhead);
      }
    };
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("ended", () => setPlaying(false));
    return () => {
      v.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [isPlaying, currentRange?.id, ranges]);

  // Acha o último frame do range para mostrar quando pausado
  useEffect(() => {
    const v = ref.current;
    if (!v || !videoSrc || !currentRange) return;
    const seekTo = (currentRange.inPoint ?? 0) + (playhead - currentRange.start);
    if (v.readyState >= 2) {
      try { v.currentTime = seekTo; } catch (e) { setError(String(e)); }
    }
  }, [videoSrc, currentRange?.id]);

  return (
    <div className={styles.preview}>
      <div className={styles.canvas}>
        {!videoSrc && (
          <div className={styles.placeholder}>
            <div className={styles.placeholderIcon}>▶</div>
            <div className={styles.placeholderText}>
              {ranges.length === 0
                ? "Arraste uma mídia para a timeline"
                : "Mova o playhead para um clip"}
            </div>
          </div>
        )}
        {videoSrc && (
          <video
            ref={ref}
            src={videoSrc}
            muted
            playsInline
            className={styles.video}
          />
        )}
        {error && <div className={styles.error}>{error}</div>}
      </div>
      <div className={styles.transport}>
        <button onClick={() => setPlayhead(0)}>⏮</button>
        <button onClick={() => setPlayhead(Math.max(0, playhead - 0.1))}>⏪</button>
        <button onClick={() => setPlaying(!isPlaying)} className={isPlaying ? "" : "primary"}>
          {isPlaying ? "⏸ PAUSAR" : "▶ PLAY"}
        </button>
        <button onClick={() => setPlayhead(playhead + 0.1)}>⏩</button>
        <button onClick={() => setPlayhead(getTotalDuration())}>⏭</button>
        <div className={styles.tc}>
          {formatTC(playhead)} <span className={styles.dim}>/ {formatTC(getTotalDuration())}</span>
        </div>
      </div>
    </div>
  );
}

function getTotalDuration(): number {
  // Pega do store sem hook
  const ranges = useEditorStore.getState().ranges;
  if (!ranges.length) return 0;
  return Math.max(...ranges.map((r) => r.start + r.duration));
}

function formatTC(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ff = Math.floor((s % 1) * 30);
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ff)}`;
}
function pad(n: number) { return n.toString().padStart(2, "0"); }
