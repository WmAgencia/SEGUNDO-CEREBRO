export interface NoteChunk {
  ordinal: number;
  heading: string;
  content: string;
}

const MAX_CHUNK_CHARS = 1100;

function headingPath(stack: Array<{ level: number; text: string }>): string {
  return stack.map((h) => h.text).join(" > ");
}

export function chunkBody(body: string, title: string): NoteChunk[] {
  const chunks: NoteChunk[] = [];
  const stack: Array<{ level: number; text: string }> = [];

  let currentHeading = "";
  let buffer: string[] = [];
  let bufferSize = 0;

  const flush = (): void => {
    const content = buffer.join("\n").trim();
    if (content !== "") {
      chunks.push({
        ordinal: chunks.length,
        heading: currentHeading || title,
        content,
      });
    }
    buffer = [];
    bufferSize = 0;
  };

  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      buffer.push(line);
      bufferSize += line.length + 1;
      continue;
    }
    if (!inFence) {
      const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
      if (headingMatch && headingMatch[1] && headingMatch[2]) {
        flush();
        const level = headingMatch[1].length;
        while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
        stack.push({ level, text: headingMatch[2] });
        currentHeading = headingPath(stack);
        continue;
      }
    }
    buffer.push(line);
    bufferSize += line.length + 1;
    if (bufferSize >= MAX_CHUNK_CHARS && trimmed === "") {
      flush();
    }
  }
  flush();

  return chunks;
}
