import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../state/editorStore";
import type { TimelineRange } from "../../api/types";
import styles from "./Timeline.module.css";

const TRACK_HEIGHT = 48;
const RULER_HEIGHT = 28;
const TRACK_GAP = 4;
const TRACKS = [1, 2, 3]; // V1, V2, A1 (3 tracks)
const TRACK_LABELS = ["V1", "V2", "A1"];

export default function Timeline() {
  const {
    ranges, zoom, scrolling, playhead,
    setZoom, setScroll, setPlayhead, select, selectedRangeId,
    sources, addRange, updateRange, deleteRange,
    projectId,
  } = useEditorStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{
    type: "move" | "trim-left" | "trim-right" | "scrub";
    rangeId?: string;
    startX: number;
    startVal: number;
  } | null>(null);

  // Total duration: usa o fim do último range ou 60s mínimo
  const totalDur = Math.max(60, ...ranges.map((r) => r.start + r.duration), 0);
  const totalWidth = totalDur * zoom;

  // Sync scroll do container
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Math.abs(el.scrollLeft - scrolling) > 1) {
      el.scrollLeft = scrolling;
    }
  }, [scrolling]);

  // Wheel zoom (Ctrl+wheel)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.05;
        const oldZoom = zoom;
        const newZoom = Math.max(10, Math.min(400, oldZoom + delta));
        // Mantém o ponto sob o cursor fixo
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left + el.scrollLeft;
        const timeAt = mouseX / oldZoom;
        setZoom(newZoom);
        const newScroll = timeAt * newZoom - (e.clientX - rect.left);
        setScroll(Math.max(0, newScroll));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel as any);
  }, [zoom]);

  // Drag global
  useEffect(() => {
    if (!dragState) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragState.startX;
      const dt = dx / zoom;
      if (dragState.type === "scrub") {
        const newT = Math.max(0, dragState.startVal + dt);
        setPlayhead(newT);
      } else if (dragState.rangeId) {
        const r = ranges.find((rr) => rr.id === dragState.rangeId);
        if (!r) return;
        if (dragState.type === "move") {
          const newStart = Math.max(0, dragState.startVal + dt);
          updateRange(r.id, { start: newStart });
        } else if (dragState.type === "trim-left") {
          const newIn = Math.max(0, Math.min(r.duration - 0.1, dragState.startVal + dt));
          updateRange(r.id, {
            inPoint: newIn,
            start: r.start + (newIn - (r.inPoint ?? 0)),
            duration: r.duration - (newIn - (r.inPoint ?? 0)),
          });
        } else if (dragState.type === "trim-right") {
          const newDur = Math.max(0.1, dragState.startVal + dt);
          updateRange(r.id, { duration: newDur, outPoint: (r.inPoint ?? 0) + newDur });
        }
      }
    };
    const onUp = () => setDragState(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragState, zoom, ranges]);

  // Drop de mídia na timeline
  const onTrackDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-clipcon-source")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onTrackDrop = (e: React.DragEvent, track: number) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-clipcon-source");
    if (!raw) return;
    const data = JSON.parse(raw);
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0)) / zoom;
    addRange(data.id, track, Math.max(0, t), data.duration);
  };

  return (
    <div className={styles.timeline}>
      <div className={styles.controls}>
        <span className={styles.label}>TIMELINE</span>
        <span className={styles.dim}>{ranges.length} clip{ranges.length !== 1 ? "s" : ""}</span>
        <div className={styles.zoom}>
          <span className={styles.dim}>zoom</span>
          <button onClick={() => setZoom(zoom * 0.8)}>−</button>
          <span className={styles.zoomVal}>{zoom.toFixed(0)}px/s</span>
          <button onClick={() => setZoom(zoom * 1.25)}>+</button>
        </div>
        {selectedRangeId && (
          <button onClick={() => deleteRange(selectedRangeId)}>🗑 Deletar</button>
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.trackLabels}>
          <div style={{ height: RULER_HEIGHT }} />
          {TRACKS.map((t, i) => (
            <div key={t} className={styles.trackLabel} style={{ height: TRACK_HEIGHT }}>
              {TRACK_LABELS[i]}
            </div>
          ))}
        </div>

        <div
          className={styles.scroll}
          ref={scrollRef}
          onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollLeft)}
        >
          <div className={styles.canvas} style={{ width: totalWidth }}>
            {/* Ruler */}
            <div
              className={styles.ruler}
              style={{ height: RULER_HEIGHT }}
              onMouseDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const t = (e.clientX - rect.left) / zoom;
                setPlayhead(t);
                setDragState({ type: "scrub", startX: e.clientX, startVal: t });
              }}
            >
              {renderTicks(totalDur, zoom)}
            </div>

            {/* Tracks */}
            {TRACKS.map((t, i) => (
              <div
                key={t}
                className={`${styles.track} ${t === 3 ? styles.audioTrack : ""}`}
                style={{ height: TRACK_HEIGHT, top: RULER_HEIGHT + i * (TRACK_HEIGHT + TRACK_GAP) }}
                onDragOver={onTrackDragOver}
                onDrop={(e) => onTrackDrop(e, t)}
              >
                <div className={styles.trackGrid} style={{ width: totalWidth }} />
              </div>
            ))}

            {/* Ranges (clips) */}
            {ranges.map((r) => (
              <TimelineClip
                key={r.id}
                range={r}
                zoom={zoom}
                rulerHeight={RULER_HEIGHT}
                trackHeight={TRACK_HEIGHT}
                trackGap={TRACK_GAP}
                selected={r.id === selectedRangeId}
                source={sources[r.source]}
                onMouseDown={(e, type) => {
                  e.stopPropagation();
                  select(r.id);
                  const startVal = type === "move" ? r.start : type === "trim-left" ? (r.inPoint ?? 0) : r.duration;
                  setDragState({ type, rangeId: r.id, startX: e.clientX, startVal });
                }}
              />
            ))}

            {/* Playhead */}
            <div
              className={styles.playhead}
              style={{
                left: playhead * zoom,
                height: RULER_HEIGHT + TRACKS.length * (TRACK_HEIGHT + TRACK_GAP),
              }}
            >
              <div className={styles.playheadHead} />
              <div className={styles.playheadLine} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineClip({
  range, zoom, rulerHeight, trackHeight, trackGap, selected, source, onMouseDown,
}: {
  range: TimelineRange;
  zoom: number;
  rulerHeight: number;
  trackHeight: number;
  trackGap: number;
  selected: boolean;
  source?: { name: string; thumb?: string };
  onMouseDown: (e: React.MouseEvent, type: "move" | "trim-left" | "trim-right") => void;
}) {
  const isAudio = range.track === 3;
  const left = range.start * zoom;
  const width = Math.max(8, range.duration * zoom);
  const top = rulerHeight + (range.track - 1) * (trackHeight + trackGap);
  const label = source?.name || range.label || range.source.slice(0, 8);

  return (
    <div
      className={`${styles.clip} ${selected ? styles.clipSelected : ""} ${isAudio ? styles.audio : ""}`}
      style={{ left, top: top + 4, width, height: trackHeight - 8 }}
      onMouseDown={(e) => onMouseDown(e, "move")}
    >
      <div className={styles.clipTrimLeft} onMouseDown={(e) => onMouseDown(e, "trim-left")} />
      <div className={styles.clipLabel}>
        <span className={styles.clipName}>{label}</span>
        {range.grade && <span className={styles.clipGrade}>{range.grade}</span>}
      </div>
      <div className={styles.clipTrimRight} onMouseDown={(e) => onMouseDown(e, "trim-right")} />
    </div>
  );
}

function renderTicks(totalDur: number, zoom: number) {
  // tick a cada N segundos, dependendo do zoom
  const step = zoom > 100 ? 1 : zoom > 50 ? 2 : zoom > 25 ? 5 : 10;
  const ticks = [];
  for (let t = 0; t <= totalDur; t += step) {
    const major = t % (step * 5) === 0;
    ticks.push(
      <div
        key={t}
        className={`${styles.tick} ${major ? styles.tickMajor : ""}`}
        style={{ left: t * zoom }}
      >
        {major && <span className={styles.tickLabel}>{formatTime(t)}</span>}
      </div>
    );
  }
  return ticks;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
