/// Phase 1（#384）で置いた本体未実装のマーカー。テストは全てこれで赤くなる。
///
/// `throw new Error('TODO')` にしないのは、テストの赤が「移植したテストが仕様どおり
/// 落ちている」のか「移植ミスで別の例外になっている」のかを、Phase 2（#385）の実装中に
/// 区別できるようにするため。型・シグネチャの誤りは `tsc --noEmit` が先に落とす。
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what} — ported in #385`);
    this.name = 'NotImplementedError';
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
