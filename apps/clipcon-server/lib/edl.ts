import { z } from "zod";

// Schema mais permissivo — aceita EDL vindo do frontend (que já tem id nas ranges)
const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  relPath: z.string(),
  size: z.number().optional(),
  duration: z.number().optional(),
  fps: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumb: z.string().optional(),
  waveform: z.string().optional(),
}).passthrough();

export const RangeSchema = z.object({
  id: z.string(),
  source: z.string(),              // source id
  start: z.number(),               // segundos no source
  duration: z.number(),            // segundos na timeline (= duration se 1:1)
  track: z.number(),               // 1..N
  inPoint: z.number().optional(),  // trim in
  outPoint: z.number().optional(), // trim out
  grade: z.string().optional(),
  fadeIn: z.number().optional(),
  fadeOut: z.number().optional(),
  label: z.string().optional(),
});
export type RangeT = z.infer<typeof RangeSchema>;

export const EDLSchema = z.object({
  sources: z.record(z.string(), SourceSchema),
  ranges: z.array(RangeSchema),
  fps: z.number().default(30),
  width: z.number().default(1920),
  height: z.number().default(1080),
  subtitles: z.string().optional(),
  overlays: z.array(z.any()).optional(),
});
export type EDL = z.infer<typeof EDLSchema>;

/** Converte EDL do frontend (estado do editor) para o formato que render.py aceita */
export function toRenderEDL(edl: EDL): unknown {
  return {
    sources: Object.fromEntries(
      Object.entries(edl.sources).map(([k, s]) => [k, { path: s.path, duration: s.duration, fps: s.fps }])
    ),
    ranges: edl.ranges.map((r) => ({
      source: r.source,
      start: r.inPoint ?? r.start,
      end: (r.outPoint != null ? r.outPoint : (r.inPoint ?? r.start) + r.duration),
      duration: r.outPoint != null && r.inPoint != null ? r.outPoint - r.inPoint : r.duration,
      grade: r.grade,
      fadein: r.fadeIn != null ? r.fadeIn * 1000 : undefined,
      fadeout: r.fadeOut != null ? r.fadeOut * 1000 : undefined,
    })),
    subtitles: edl.subtitles,
    overlays: edl.overlays,
    fps: edl.fps,
  };
}
