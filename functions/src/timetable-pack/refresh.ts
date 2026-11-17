import { gzipSync } from "node:zlib";

import {
  MINI_TOKYO_3D,
  ODPT_FEEDS,
  PACK_GROUPS,
  miniTokyo3dDataUrl,
  packObjectPath,
  type MiniTokyo3dSource,
  type OdptFeed,
  type OdptKeyName,
  type PackGroup,
} from "./feeds";
import {
  miniTokyo3dFeed,
  railwaysOf,
  timetableFileOf,
  type M3dRailway,
  type M3dStation,
  type M3dTrain,
} from "./mini-tokyo-3d";
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
    readonly reason: "missing_key" | "http" | "network" | "not_gtfs_zip" | "not_json",
    readonly httpStatus?: number,
  ) {
    super(`${feed}: ${reason}${httpStatus === undefined ? "" : ` ${httpStatus}`}`);
  }
}

const MINI_TOKYO_3D_FEED = "mini-tokyo-3d";

// exactWalkMax が受ける departAt は今から1日前〜92日先で、到着指定だとその翌日まで押し出される。
const MINI_TOKYO_3D_DAYS_BEFORE = 1;
const MINI_TOKYO_3D_DAYS_AFTER = 93;

/**
 * ODPT と mini-tokyo-3d から時刻表を取り直し、グループごとにパックを作って置く。
 * グループの中で1つでも取れなかったら（必須ファイルの欠けた zip・便が1本も無いフィードを含む）、
 * そのグループは置き換えずに前回のパックを残す
 * （一部の路線が消えたパックで検索させない）。
 */
export async function refreshTimetablePacks(
  deps: RefreshDeps,
  feeds: readonly OdptFeed[] = ODPT_FEEDS,
  miniTokyo3d: MiniTokyo3dSource | null = MINI_TOKYO_3D,
): Promise<GroupResult[]> {
  const results: GroupResult[] = [];
  for (const group of PACK_GROUPS) {
    const members = feeds.filter((f) => f.group === group);
    if (members.length === 0) continue;
    // 1グループずつ取るのは、全フィードの zip と展開後の文字列を同時にメモリへ持たないため。
    const settled = await Promise.allSettled(members.map((f) => fetchFeed(f, deps)));
    const failedFeeds = members.filter((_, i) => settled[i].status === "rejected").map((f) => f.id);
    if (failedFeeds.length > 0) {
      results.push(skip(group, failedFeeds, deps));
      continue;
    }
    const inputs = settled.map((s) => (s as PromiseFulfilledResult<FeedInput>).value);
    results.push(await publish(group, inputs, deps));
  }
  if (miniTokyo3d !== null) {
    let inputs: FeedInput[];
    try {
      inputs = await fetchMiniTokyo3d(miniTokyo3d, deps);
    } catch {
      results.push(skip("minitokyo3d", [MINI_TOKYO_3D_FEED], deps));
      return results;
    }
    results.push(await publish("minitokyo3d", inputs, deps));
  }
  return results;
}

function skip(group: PackGroup, failedFeeds: string[], deps: RefreshDeps): GroupResult {
  deps.log({ event: "timetable_pack_refresh", group, status: "skipped", failedFeeds });
  return { group, status: "skipped", failedFeeds };
}

async function publish(
  group: PackGroup,
  inputs: readonly FeedInput[],
  deps: RefreshDeps,
): Promise<GroupResult> {
  const pack = buildTimetablePack(inputs);
  const tripsPerFeed = inputs.map(() => 0);
  for (const trip of pack.trips) tripsPerFeed[trip.feed]++;
  const emptyFeeds = inputs.filter((_, i) => tripsPerFeed[i] === 0).map((f) => f.id);
  if (emptyFeeds.length > 0) {
    for (const feed of emptyFeeds) {
      deps.log({ event: "timetable_feed_fetch", feed, status: "failure", reason: "no_trips" });
    }
    return skip(group, emptyFeeds, deps);
  }
  const gzipped = gzipSync(JSON.stringify(pack));
  await deps.upload(packObjectPath(group), gzipped);
  const result: GroupResult = {
    group,
    status: "uploaded",
    bytes: gzipped.byteLength,
    trips: pack.trips.length,
  };
  deps.log({ event: "timetable_pack_refresh", ...result });
  return result;
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
    return { id: feed.id, fetchedAt, files, routeName: feed.routeName };
  } catch (e) {
    throw logFailure(e, feed.id, deps);
  }
}

async function fetchMiniTokyo3d(source: MiniTokyo3dSource, deps: RefreshDeps): Promise<FeedInput[]> {
  try {
    const fetchedAt = deps.now().toISOString();
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetchOrThrow(MINI_TOKYO_3D_FEED, miniTokyo3dDataUrl(source.commit, path), deps);
      try {
        return (await res.json()) as T;
      } catch {
        throw new FeedFetchError(MINI_TOKYO_3D_FEED, "not_json");
      }
    };
    const [stations, railways] = await Promise.all([
      get<M3dStation[]>("stations.json"),
      get<M3dRailway[]>("railways.json"),
    ]);
    const targets = railwaysOf(railways, source.operators);
    const timetables = await Promise.all(
      targets.map((r) => get<M3dTrain[]>(`train-timetables/${timetableFileOf(r.id)}`)),
    );
    deps.log({
      event: "timetable_feed_fetch",
      feed: MINI_TOKYO_3D_FEED,
      status: "success",
      files: 2 + timetables.length,
    });
    const dates = serviceDates(deps.now());
    return source.operators.map((operator) =>
      miniTokyo3dFeed({
        operator,
        stations,
        railways,
        trains: timetables.filter((_, i) => operatorOf(targets[i].id) === operator).flat(),
        dates,
        commit: source.commit,
        fetchedAt,
      }),
    );
  } catch (e) {
    throw logFailure(e, MINI_TOKYO_3D_FEED, deps);
  }
}

const operatorOf = (railwayId: string): string => railwayId.slice(0, railwayId.indexOf("."));

/** 取得した日（JST）の前後の運行日（YYYYMMDD）。 */
function serviceDates(now: Date): number[] {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const today = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  const dates: number[] = [];
  for (let offset = -MINI_TOKYO_3D_DAYS_BEFORE; offset <= MINI_TOKYO_3D_DAYS_AFTER; offset++) {
    const d = new Date(today + offset * 86400 * 1000);
    dates.push(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
  }
  return dates;
}

function logFailure(e: unknown, feed: string, deps: RefreshDeps): FeedFetchError {
  // fetch の例外は URL（＝キー）を含みうるので、原因ごと捨てる。
  const err = e instanceof FeedFetchError ? e : new FeedFetchError(feed, "network");
  deps.log({
    event: "timetable_feed_fetch",
    feed,
    status: "failure",
    reason: err.reason,
    ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
  });
  return err;
}

async function download(feed: OdptFeed, deps: RefreshDeps): Promise<Uint8Array> {
  let url = feed.url;
  if (feed.key !== null) {
    const key = deps.keys[feed.key];
    if (!key) throw new FeedFetchError(feed.id, "missing_key");
    // URLSearchParams を使わないのは、パラメータ名のコロンが %3A になるため。
    url += `${url.includes("?") ? "&" : "?"}acl:consumerKey=${encodeURIComponent(key)}`;
  }
  const res = await fetchOrThrow(feed.id, url, deps);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchOrThrow(feed: string, url: string, deps: RefreshDeps): Promise<Response> {
  const res = await deps.fetch(url);
  if (!res.ok) throw new FeedFetchError(feed, "http", res.status);
  return res;
}
