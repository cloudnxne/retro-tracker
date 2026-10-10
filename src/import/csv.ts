/**
 * RFC 4180-style CSV reader: quoted fields may contain the delimiter, doubled quotes and newlines
 * (Strong's Notes column does). Yields to the event loop every `chunk` rows so a 20k-row file
 * can drive a progress bar instead of freezing the screen.
 */
export async function parseCsv(
  text: string,
  { delimiter, chunk = 2_000, onProgress }: { delimiter?: string; chunk?: number; onProgress?: (fraction: number) => void } = {},
): Promise<string[][]> {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a UTF-8 BOM
  const d = delimiter ?? sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sinceYield = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === d) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (++sinceYield >= chunk) {
        sinceYield = 0;
        onProgress?.(i / src.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  onProgress?.(1);
  return rows;
}

/** Strong uses ';' in some locales and ',' in others: pick whichever splits the header more. */
export function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
  const count = (ch: string) => firstLine.split(ch).length;
  return count(';') > count(',') ? ';' : ',';
}
