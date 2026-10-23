// GTFS の CSV（RFC 4180）を1行ずつ読む。
//
// 行ごとにオブジェクトを作らないのは、JR の stop_times.txt が数十万行あり、
// 行オブジェクトを全部持つと試作でヒープが約440MBまで膨らんだため（#457）。

export type CsvField = (column: string) => string;

/** 見出し行の後の各行について、列名で値を引く関数を渡して fn を呼ぶ。 */
export function readCsv(
  text: string,
  fn: (get: CsvField, columns: readonly string[]) => void,
): void {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let columns: string[] | null = null;
  let index = new Map<string, number>();
  let row: string[] = [];
  const get: CsvField = (column) => {
    const i = index.get(column);
    return i === undefined ? "" : (row[i] ?? "");
  };

  const emit = (fields: string[]) => {
    if (fields.length === 1 && fields[0] === "") return;
    if (columns === null) {
      columns = fields;
      index = new Map(fields.map((c, i) => [c, i]));
      return;
    }
    row = fields;
    fn(get, columns);
  };

  let fields: string[] = [];
  let i = 0;
  const n = src.length;
  while (i <= n) {
    if (i === n) {
      if (fields.length > 0) emit(fields);
      break;
    }
    let value: string;
    if (src[i] === '"') {
      let j = i + 1;
      let buf = "";
      for (;;) {
        const q = src.indexOf('"', j);
        if (q < 0) {
          buf += src.slice(j);
          j = n;
          break;
        }
        buf += src.slice(j, q);
        if (src[q + 1] === '"') {
          buf += '"';
          j = q + 2;
        } else {
          j = q + 1;
          break;
        }
      }
      value = buf;
      i = j;
    } else {
      let j = i;
      while (j < n && src[j] !== "," && src[j] !== "\n" && src[j] !== "\r") j++;
      value = src.slice(i, j);
      i = j;
    }
    fields.push(value);

    if (i >= n) {
      emit(fields);
      fields = [];
      break;
    }
    if (src[i] === ",") {
      i++;
      if (i === n) fields.push("");
      continue;
    }
    if (src[i] === "\r") i++;
    if (src[i] === "\n") i++;
    emit(fields);
    fields = [];
  }
}
