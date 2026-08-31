import { create } from "zustand";
import { nanoid } from "nanoid";
import type { TimelineEDL, TimelineRange, Source, EdlPatch } from "../../api/types";

export interface EditorState {
  projectId: string | null;
  projectName: string;
  sources: Record<string, Source>;
  ranges: TimelineRange[];
  fps: number;
  width: number;
  height: number;
  selectedRangeId: string | null;
  playhead: number;
  zoom: number;             // pixels por segundo
  scrolling: number;        // scroll horizontal da timeline (px)
  isPlaying: boolean;

  setProject: (id: string, name: string) => void;
  setSources: (sources: Source[]) => void;
  setRanges: (ranges: TimelineRange[]) => void;
  addSource: (source: Source) => void;
  setFps: (fps: number) => void;

  setPlayhead: (t: number) => void;
  setZoom: (z: number) => void;
  setScroll: (x: number) => void;
  setPlaying: (p: boolean) => void;
  select: (id: string | null) => void;

  addRange: (source: string, track: number, timelineStart: number, duration: number) => string;
  updateRange: (id: string, patch: Partial<TimelineRange>) => void;
  deleteRange: (id: string) => void;
  applyPatches: (patches: EdlPatch[]) => void;
  toEDL: () => TimelineEDL;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  projectId: null,
  projectName: "",
  sources: {},
  ranges: [],
  fps: 30,
  width: 1920,
  height: 1080,
  selectedRangeId: null,
  playhead: 0,
  zoom: 60, // px/segundo
  scrolling: 0,
  isPlaying: false,

  setProject: (id, name) => set({ projectId: id, projectName: name }),
  setSources: (sources) =>
    set({ sources: Object.fromEntries(sources.map((s) => [s.id, s])) }),
  setRanges: (ranges) => set({ ranges }),
  addSource: (source) =>
    set((s) => ({ sources: { ...s.sources, [source.id]: source } })),
  setFps: (fps) => set({ fps }),

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setZoom: (zoom) => set({ zoom: Math.max(10, Math.min(300, zoom)) }),
  setScroll: (scrolling) => set({ scrolling: Math.max(0, scrolling) }),
  setPlaying: (p) => set({ isPlaying: p }),
  select: (id) => set({ selectedRangeId: id }),

  addRange: (source, track, timelineStart, duration) => {
    const id = `clip_${nanoid(8)}`;
    set((s) => ({
      ranges: [
        ...s.ranges,
        { id, source, track, start: timelineStart, duration, inPoint: 0, outPoint: duration },
      ],
    }));
    return id;
  },
  updateRange: (id, patch) =>
    set((s) => ({
      ranges: s.ranges.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    })),
  deleteRange: (id) =>
    set((s) => ({
      ranges: s.ranges.filter((r) => r.id !== id),
      selectedRangeId: s.selectedRangeId === id ? null : s.selectedRangeId,
    })),

  applyPatches: (patches) => {
    set((s) => {
      let ranges = [...s.ranges];
      for (const p of patches) {
        switch (p.op) {
          case "trim":
            ranges = ranges.map((r) =>
              r.id === p.clipId
                ? {
                    ...r,
                    inPoint: p.start != null ? p.start : r.inPoint,
                    outPoint: p.end != null ? p.end : r.outPoint,
                  }
                : r
            );
            break;
          case "split": {
            // divide em duas: A (início..at) e B (at..fim)
            const idx = ranges.findIndex((r) => r.id === p.clipId);
            if (idx === -1) break;
            const r = ranges[idx];
            const localAt = p.at - r.start;
            if (localAt <= 0 || localAt >= r.duration) break;
            const a: TimelineRange = { ...r, duration: localAt, outPoint: (r.inPoint ?? 0) + localAt };
            const b: TimelineRange = {
              ...r,
              id: `clip_${nanoid(8)}`,
              start: r.start + localAt,
              duration: r.duration - localAt,
              inPoint: (r.inPoint ?? 0) + localAt,
              outPoint: r.outPoint ?? (r.inPoint ?? 0) + r.duration,
            };
            ranges.splice(idx, 1, a, b);
            break;
          }
          case "delete":
            ranges = ranges.filter((r) => r.id !== p.clipId);
            break;
          case "move":
            ranges = ranges.map((r) =>
              r.id === p.clipId
                ? {
                    ...r,
                    track: p.track ?? r.track,
                    start: p.start ?? r.start,
                  }
                : r
            );
            break;
          case "add": {
            const id = `clip_${nanoid(8)}`;
            ranges.push({
              id,
              source: p.source,
              track: p.track,
              start: p.start,
              duration: p.duration,
              inPoint: 0,
              outPoint: p.duration,
            });
            break;
          }
          case "color":
            ranges = ranges.map((r) => (r.id === p.clipId ? { ...r, grade: p.grade } : r));
            break;
          case "fade":
            ranges = ranges.map((r) =>
              r.id === p.clipId ? { ...r, fadeIn: p.fadeIn, fadeOut: p.fadeOut } : r
            );
            break;
          case "fadein":
            ranges = ranges.map((r) =>
              r.id === p.clipId ? { ...r, fadeIn: p.duration } : r
            );
            break;
          case "fadeout":
            ranges = ranges.map((r) =>
              r.id === p.clipId ? { ...r, fadeOut: p.duration } : r
            );
            break;
          case "render":
          case "ai_autonomous":
            // tratado fora do store (server-side)
            break;
        }
      }
      return { ranges };
    });
  },

  toEDL: () => {
    const { sources, ranges, fps, width, height } = get();
    return { sources, ranges, fps, width, height };
  },
}));
