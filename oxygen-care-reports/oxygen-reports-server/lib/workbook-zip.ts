/** Read only a named workbook member; never execute content or extract paths to disk. */
export async function unzipEntry(buffer: ArrayBuffer, name: string): Promise<string | null> {
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer),
    decoder = new TextDecoder();
  const maximum = 20 * 1024 * 1024;
  if (bytes.length > 5 * 1024 * 1024 || bytes.length < 22)
    throw Error('Workbook must be smaller than 5 MB and a valid XLSX file.');
  const inside = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length)
      throw Error('Invalid workbook archive.');
  };
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50)
    end--;
  if (end < Math.max(0, bytes.length - 65557)) throw Error('Invalid workbook archive.');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw Error('Multi-volume workbooks are not supported.');
  const entries = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  if (entries > 2000) throw Error('Workbook contains too many archive entries.');
  for (let index = 0; index < entries; index++) {
    inside(pointer, 46);
    if (view.getUint32(pointer, true) !== 0x02014b50) throw Error('Invalid workbook archive.');
    const flags = view.getUint16(pointer + 8, true),
      compression = view.getUint16(pointer + 10, true),
      compressed = view.getUint32(pointer + 20, true),
      expanded = view.getUint32(pointer + 24, true);
    const names = view.getUint16(pointer + 28, true),
      extra = view.getUint16(pointer + 30, true),
      comments = view.getUint16(pointer + 32, true),
      local = view.getUint32(pointer + 42, true);
    inside(pointer + 46, names + extra + comments);
    if (decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + names)) === name) {
      if (flags & 1 || expanded > maximum)
        throw Error('Encrypted or oversized workbook content is not supported.');
      inside(local, 30);
      if (view.getUint32(local, true) !== 0x04034b50) throw Error('Invalid workbook archive.');
      const start =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      inside(start, compressed);
      const data = bytes.slice(start, start + compressed);
      if (compression === 0) {
        if (data.length > maximum || data.length !== expanded)
          throw Error('Invalid workbook entry size.');
        return decoder.decode(data);
      }
      if (compression !== 8 || typeof DecompressionStream === 'undefined')
        throw Error('Unsupported workbook compression.');
      const reader = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
        .getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > maximum) {
            await reader.cancel();
            throw Error('Workbook content exceeds the safe size limit.');
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (size !== expanded) throw Error('Invalid workbook entry size.');
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return decoder.decode(output);
    }
    pointer += 46 + names + extra + comments;
  }
  return null;
}
