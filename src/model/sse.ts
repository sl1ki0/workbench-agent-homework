const maxEventLength = 1024 * 1024;

/** Decode consecutive SSE records even when UTF-8, CRLF or event boundaries straddle chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let sections: string[] = [];
  let size = 0;

  function acceptLine(line: string): string | undefined {
    if (line === '') {
      if (!sections.length) return undefined;
      const event = sections.join('\n');
      sections = [];
      size = 0;
      return event;
    }
    if (line !== 'data' && !line.startsWith('data:')) return undefined;
    const section = line.slice(5).replace(/^ /u, '');
    size += section.length + 1;
    if (size > maxEventLength) throw new Error('Событие SSE превысило допустимый размер');
    sections.push(section);
    return undefined;
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let cursor = 0;
      for (const newline of pending.matchAll(/\r\n|[\r\n]/gu)) {
        const offset = newline.index;
        if (!done && newline[0] === '\r' && offset === pending.length - 1) break;
        const event = acceptLine(pending.slice(cursor, offset));
        cursor = offset + newline[0].length;
        if (event !== undefined) yield event;
      }
      pending = pending.slice(cursor);
      if (pending.length > maxEventLength)
        throw new Error('Строка SSE превысила допустимый размер');
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
