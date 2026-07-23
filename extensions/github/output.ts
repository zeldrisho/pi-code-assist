export const MAX_OUTPUT_BYTES = 50_000;
export const MAX_OUTPUT_LINES = 2_000;

export interface ExecResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly total_bytes: number;
  readonly total_lines: number;
  readonly returned_bytes: number;
  readonly returned_lines: number;
  readonly keep_tail?: boolean;
}

export function bounded(
  value: string,
  keepTail = false,
  maxBytes = MAX_OUTPUT_BYTES,
  maxLines = MAX_OUTPUT_LINES,
): ExecResult {
  const lines = value.split('\n');
  let selected = lines;
  let truncated = false;
  if (lines.length > maxLines) {
    selected = keepTail ? lines.slice(-maxLines) : lines.slice(0, maxLines);
    truncated = true;
  }
  let output = selected.join('\n');
  if (Buffer.byteLength(output) > maxBytes) {
    const buffer = Buffer.from(output);
    let slice = keepTail ? buffer.subarray(buffer.length - maxBytes) : buffer.subarray(0, maxBytes);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (slice.length) {
      try {
        output = decoder.decode(slice);
        break;
      } catch {
        slice = keepTail ? slice.subarray(1) : slice.subarray(0, -1);
      }
    }
    truncated = true;
  }
  return {
    text: output,
    truncated,
    total_bytes: Buffer.byteLength(value),
    total_lines: lines.length,
    returned_bytes: Buffer.byteLength(output),
    returned_lines: output.split('\n').length,
  };
}

export function decodeUtf8(value: Buffer, keepTail: boolean): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let selected = value;
  while (selected.length) {
    try {
      return decoder.decode(selected);
    } catch {
      selected = keepTail ? selected.subarray(1) : selected.subarray(0, -1);
    }
  }
  return '';
}

export function textResult(result: ExecResult, details: Record<string, unknown> = {}) {
  let text = result.text;
  let returnedBytes = result.returned_bytes;
  let returnedLines = result.returned_lines;
  let marker = '';
  if (result.truncated) {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      marker = `\n\n[Output truncated: ${returnedBytes}/${result.total_bytes} bytes, ${returnedLines}/${result.total_lines} lines]`;
      const display = bounded(
        result.text,
        result.keep_tail ?? false,
        MAX_OUTPUT_BYTES - Buffer.byteLength(marker),
        MAX_OUTPUT_LINES - 2,
      );
      text = display.text;
      returnedBytes = display.returned_bytes;
      returnedLines = display.returned_lines;
    }
    marker = `\n\n[Output truncated: ${returnedBytes}/${result.total_bytes} bytes, ${returnedLines}/${result.total_lines} lines]`;
  }
  const { text: _text, keep_tail: _keepTail, ...metadata } = result;
  return {
    content: [{ type: 'text' as const, text: text + marker }],
    details: {
      ...details,
      ...metadata,
      returned_bytes: returnedBytes,
      returned_lines: returnedLines,
    },
  };
}
