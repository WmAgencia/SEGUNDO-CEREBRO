import { describe, expect, it } from "vitest";
import { NotConfiguredTranscriptionProvider, transcribeAudio } from "../core/audio/transcription.ts";
import { HqEventStream } from "../core/hq/event-stream.ts";

describe("HQ audio and event contracts", () => {
  it("reports missing transcription provider without inventing text", async () => {
    const result = await transcribeAudio({ audio: new Uint8Array(), mimeType: "audio/webm" }, new NotConfiguredTranscriptionProvider());
    expect(result.status).toBe("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED"); expect(result.text).toBeNull();
  });
  it("publishes and unsubscribes event stream listeners", () => {
    const stream = new HqEventStream(); const received: string[] = []; const unsubscribe = stream.subscribe((event) => received.push(event.type));
    stream.publish({ type: "TASK_STARTED", subject: "task.1", payload: {}, occurredAt: new Date().toISOString() }); unsubscribe();
    stream.publish({ type: "TASK_COMPLETED", subject: "task.1", payload: {}, occurredAt: new Date().toISOString() }); expect(received).toEqual(["TASK_STARTED"]);
  });
});
