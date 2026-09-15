// subset-font は型を同梱せず、@types も無い。使っているのは1関数だけなので、
// ここで宣言する。DefinitelyTyped 待ちにすると呼び出しが any で通り、
// targetFormat の綴り違いのような間違いが実行時まで残る。
declare module 'subset-font' {
  export default function subsetFont(
    font: Uint8Array,
    text: string,
    options?: { targetFormat?: 'woff2' | 'woff' | 'truetype' | 'sfnt' },
  ): Promise<Buffer>;
}
