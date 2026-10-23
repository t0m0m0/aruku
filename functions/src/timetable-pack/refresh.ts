import { gzipSync } from "node:zlib";

import { ODPT_FEEDS, PACK_GROUPS, packObjectPath, type OdptFeed, type OdptKeyName, type PackGroup } from "./feeds";
import { buildTimetablePack, type FeedInput } from "./pack";
import { readGtfsZip } from "./zip";

export interface RefreshDeps {
  fetch: (url: string) => Promise<Response>;
  keys: Partial<Record<OdptKeyName, string>>;
  now: () => Date;
  upload: (path: string, gzipped: Uint8Array) => Promise<void>;
  /** 構造化ログ。キーの値と URL は渡さない。 */
  log: (event: Record<string, unknown>) => void;
}

export type GroupResult =
  | { group: PackGroup; status: "uploaded"; bytes: number; trips: number }
  | { group: PackGroup; status: "skipped"; failedFeeds: string[] };

/** フィードの失敗。キーが URL に入るので、メッセージに URL も応答本文も含めない。 */
class FeedFetchError extends Error {
  constructor(
    readonly feed: string,
    readonly reason: "missing_key" | "http" | "network" | "not_gtfs_zip",
    readonly httpStatus?: number,
  ) {
    super(`${feed}: ${reason}${httpStatus === undefined ? "" : ` ${httpStatus}`}`);
  }
}

/**
 * ODPT から GTFS を取り直し、ライセンスのグループごとにパックを作って置く。
 * グループの中で1つでも取れなかったら、そのグループは置き換えずに前回のパックを残す
 * （一部の路線が消えたパックで検索させない）。
 */
export async function refreshTimetablePacks(
  deps: RefreshDeps,
  feeds: readonly OdptFeed[] = ODPT_FEEDS,
): Promise<GroupResult[]> {
  const results: GroupResult[] = [];
  for (const group of PACK_GROUPS) {
    const members = feeds.filter((f) => f.group === group);
    if (members.length === 0) continue;
    // 1グループずつ取るのは、全フィードの zip と展開後の文字列を同時にメモリへ持たないため。
    const settled = await Promise.allSettled(members.map((f) => fetchFeed(f, deps)));
    const failedFeeds = members.filter((_, i) => settled[i].status === "rejected").map((f) => f.id);
    if (failedFeeds.length > 0) {
      deps.log({ event: "timetable_pack_refresh", group, status: "skipped", failedFeeds });
      results.push({ group, status: "skipped", failedFeeds });
      continue;
    }
    const inputs = settled.map((s) => (s as PromiseFulfilledResult<FeedInput>).value);
    const pack = buildTimetablePack(inputs);
    const gzipped = gzipSync(JSON.stringify(pack));
    await deps.upload(packObjectPath(group), gzipped);
    const result: GroupResult = {
      group,
      status: "uploaded",
      bytes: gzipped.byteLength,
      trips: pack.trips.length,
    };
    deps.log({ event: "timetable_pack_refresh", ...result });
    results.push(result);
  }
  return results;
}

async function fetchFeed(feed: OdptFeed, deps: RefreshDeps): Promise<FeedInput> {
  try {
    const fetchedAt = deps.now().toISOString();
    const bytes = await download(feed, deps);
    let files;
    try {
      files = readGtfsZip(bytes);
    } catch {
      throw new FeedFetchError(feed.id, "not_gtfs_zip");
    }
    deps.log({ event: "timetable_feed_fetch", feed: feed.id, status: "success", bytes: bytes.byteLength });
    return { id: feed.id, fetchedAt, files };
  } catch (e) {
    // fetch の例外は URL（＝キー）を含みうるので、原因ごと捨てる。
    const err = e instanceof FeedFetchError ? e : new FeedFetchError(feed.id, "network");
    deps.log({
      event: "timetable_feed_fetch",
      feed: feed.id,
      status: "failure",
      reason: err.reason,
      ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
    });
    throw err;
  }
}

async function download(feed: OdptFeed, deps: RefreshDeps): Promise<Uint8Array> {
  let url = feed.url;
  if (feed.key !== null) {
    const key = deps.keys[feed.key];
    if (!key) throw new FeedFetchError(feed.id, "missing_key");
    // URLSearchParams を使わないのは、パラメータ名のコロンが %3A になるため。
    url += `?acl:consumerKey=${encodeURIComponent(key)}`;
  }
  const res = await deps.fetch(url);
  if (!res.ok) throw new FeedFetchError(feed.id, "http", res.status);
  return new Uint8Array(await res.arrayBuffer());
}
