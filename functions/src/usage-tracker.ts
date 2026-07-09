import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";

// users/{uid}/usage/{yyyyMM} に検索回数を集計する（#238）。加算は必ずこの
// トランザクション（Admin SDK・Cloud Functions側）のみで行い、クライアントは
// 直接書き込まない。firestore.rules 側は users/{uid}/usage/** への write を
// 全面拒否しており、Admin SDK はルールをバイパスするため矛盾しない。
const USERS_COLLECTION = "users";
const USAGE_SUBCOLLECTION = "usage";

// 本アプリは日本向けのため月境界は JST で判定する。Cloud Functions のランタイム
// タイムゾーンは asia-northeast1 でも UTC のため、Date のローカルメソッドに頼らず
// +9時間シフトしてから UTC の年月を読む。
export function yyyyMmJst(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  return `${jst.getUTCFullYear()}${month}`;
}

/**
 * [uid] の当月（JST）検索回数を1加算する。ドキュメント未作成なら
 * searchCount=1, accountType='free' で作成する。accountType は現状サブスク未実装
 * のため固定値（将来の課金実装時に更新）。
 */
export async function incrementSearchUsage(
  uid: string,
  now: Date = new Date()
): Promise<void> {
  const db = getFirestore();
  const month = yyyyMmJst(now);
  const ref = db
    .collection(USERS_COLLECTION)
    .doc(uid)
    .collection(USAGE_SUBCOLLECTION)
    .doc(month);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        searchCount: 1,
        lastSearchAt: Timestamp.fromDate(now),
        accountType: "free",
      });
      return;
    }
    tx.update(ref, {
      searchCount: FieldValue.increment(1),
      lastSearchAt: Timestamp.fromDate(now),
    });
  });
}
