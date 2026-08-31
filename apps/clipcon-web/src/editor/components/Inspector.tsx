import { useEditorStore } from "../state/editorStore";
import styles from "./Inspector.module.css";

export default function Inspector() {
  const { selectedRangeId, ranges, sources, updateRange } = useEditorStore();
  const range = ranges.find((r) => r.id === selectedRangeId);
  const source = range ? sources[range.source] : null;

  if (!range) {
    return (
      <div className={styles.inspector}>
        <div className={styles.head}>INSPECTOR</div>
        <div className={styles.empty}>Selecione um clip</div>
      </div>
    );
  }

  return (
    <div className={styles.inspector}>
      <div className={styles.head}>INSPECTOR</div>
      <div className={styles.section}>
        <div className={styles.label}>Source</div>
        <div className={styles.value}>{source?.name || range.source}</div>
      </div>
      <div className={styles.row}>
        <div className={styles.section}>
          <div className={styles.label}>In</div>
          <input
            type="number"
            step="0.1"
            value={(range.inPoint ?? 0).toFixed(2)}
            onChange={(e) => updateRange(range.id, { inPoint: Number(e.target.value) })}
          />
        </div>
        <div className={styles.section}>
          <div className={styles.label}>Out</div>
          <input
            type="number"
            step="0.1"
            value={(range.outPoint ?? range.duration).toFixed(2)}
            onChange={(e) => updateRange(range.id, { outPoint: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.section}>
          <div className={styles.label}>Start</div>
          <input
            type="number"
            step="0.1"
            value={range.start.toFixed(2)}
            onChange={(e) => updateRange(range.id, { start: Math.max(0, Number(e.target.value)) })}
          />
        </div>
        <div className={styles.section}>
          <div className={styles.label}>Duration</div>
          <input
            type="number"
            step="0.1"
            value={range.duration.toFixed(2)}
            onChange={(e) => updateRange(range.id, { duration: Math.max(0.1, Number(e.target.value)) })}
          />
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.section}>
          <div className={styles.label}>Track</div>
          <select
            value={range.track}
            onChange={(e) => updateRange(range.id, { track: Number(e.target.value) })}
          >
            <option value={1}>V1</option>
            <option value={2}>V2</option>
            <option value={3}>A1</option>
          </select>
        </div>
      </div>
      <div className={styles.section}>
        <div className={styles.label}>Color Grade</div>
        <select
          value={range.grade || ""}
          onChange={(e) => updateRange(range.id, { grade: e.target.value || undefined })}
        >
          <option value="">Nenhum</option>
          <option value="auto">Auto</option>
          <option value="cinematic">Cinematic</option>
          <option value="warm">Warm</option>
          <option value="punch">Punch</option>
          <option value="neutral">Neutral</option>
        </select>
      </div>
      <div className={styles.row}>
        <div className={styles.section}>
          <div className={styles.label}>Fade In (ms)</div>
          <input
            type="number"
            value={range.fadeIn ?? 0}
            onChange={(e) => updateRange(range.id, { fadeIn: Number(e.target.value) })}
          />
        </div>
        <div className={styles.section}>
          <div className={styles.label}>Fade Out (ms)</div>
          <input
            type="number"
            value={range.fadeOut ?? 0}
            onChange={(e) => updateRange(range.id, { fadeOut: Number(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}
