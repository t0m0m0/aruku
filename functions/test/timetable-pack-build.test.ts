import { describe, expect, it } from "vitest";

import { bestRides, compileTimetable } from "../src/exact-scan";
import {
  buildTimetablePack,
  timetableForDate,
  type FeedInput,
  type GtfsFiles,
} from "../src/timetable-pack/pack";

// 1行を「列名=値」の組で書く小さな GTFS。書かなかった列は空欄になる。
type Row = Record<string, string | number>;
const table = (rows: Row[], columns: string[]): string =>
  [columns.join(","), ...rows.map((r) => columns.map((c) => String(r[c] ?? "")).join(","))].join(
    "\n",
  ) + "\n";

const STOP_COLUMNS = ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type"];
const ROUTE_COLUMNS = ["route_id", "route_short_name", "route_long_name", "route_type"];
const TRIP_COLUMNS = ["route_id", "service_id", "trip_id", "trip_headsign", "block_id"];
const STOP_TIME_COLUMNS = [
  "trip_id",
  "arrival_time",
  "departure_time",
  "stop_id",
  "stop_sequence",
  "pickup_type",
  "drop_off_type",
];
const CALENDAR_COLUMNS = [
  "service_id",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "start_date",
  "end_date",
];
const CALENDAR_DATE_COLUMNS = ["service_id", "date", "exception_type"];

// 2026-10-19 は月曜。
const EVERY_DAY: Row = {
  service_id: "ALL",
  monday: 1,
  tuesday: 1,
  wednesday: 1,
  thursday: 1,
  friday: 1,
  saturday: 1,
  sunday: 1,
  start_date: 20261001,
  end_date: 20261031,
};

// 同じ経線上に 1km 間隔で並ぶ駅 A, B, C, D。
const STOPS: Row[] = ["A", "B", "C", "D"].map((id, i) => ({
  stop_id: id,
  stop_name: `駅${id}`,
  stop_lat: (35 + i * 0.009).toFixed(6),
  stop_lon: "139.700000",
}));

interface FeedSpec {
  id?: string;
  stops?: Row[];
  routes?: Row[];
  trips?: Row[];
  stopTimes: Row[];
  calendar?: Row[] | null;
  calendarDates?: Row[] | null;
  feedInfo?: string;
}

const feed = (spec: FeedSpec): FeedInput => {
  const files: GtfsFiles = {
    "stops.txt": table(spec.stops ?? STOPS, STOP_COLUMNS),
    "routes.txt": table(
      spec.routes ?? [{ route_id: "R", route_long_name: "テスト線", route_type: 2 }],
      ROUTE_COLUMNS,
    ),
    "trips.txt": table(
      spec.trips ?? [{ route_id: "R", service_id: "ALL", trip_id: "T", trip_headsign: "駅D行" }],
      TRIP_COLUMNS,
    ),
    "stop_times.txt": table(spec.stopTimes, STOP_TIME_COLUMNS),
  };
  if (spec.calendar !== null) {
    files["calendar.txt"] = table(spec.calendar ?? [EVERY_DAY], CALENDAR_COLUMNS);
  }
  if (spec.calendarDates) {
    files["calendar_dates.txt"] = table(spec.calendarDates, CALENDAR_DATE_COLUMNS);
  }
  if (spec.feedInfo !== undefined) files["feed_info.txt"] = spec.feedInfo;
  return { id: spec.id ?? "F", fetchedAt: "2026-10-20T19:00:00.000Z", files };
};

const st = (
  stopId: string,
  seq: number,
  arr: string,
  dep = arr,
  extra: Row = {},
  tripId = "T",
): Row => ({
  trip_id: tripId,
  arrival_time: arr,
  departure_time: dep,
  stop_id: stopId,
  stop_sequence: seq,
  pickup_type: 0,
  drop_off_type: 0,
  ...extra,
});

const hms = (h: number, m: number): number => h * 3600 + m * 60;

/** 2026-10-20（火）の時刻表で、便ごとに「駅名@着/発」を並べる。 */
const callsOn = (input: FeedInput | FeedInput[], date = "20261020") => {
  const pack = buildTimetablePack(Array.isArray(input) ? input : [input]);
  const day = timetableForDate(pack, date);
  return day.trips.map((trip) =>
    trip.calls.map((c) => ({
      stop: day.stops[c.stop].name,
      arr: c.arr,
      dep: c.dep,
      canBoard: c.canBoard,
      canAlight: c.canAlight,
    })),
  );
};

describe("通過駅", () => {
  it("着発が空欄で乗降とも不可の行を停車列から外す（0:00 着の降車駅に化けさせない）", () => {
    const calls = callsOn(
      feed({
        stopTimes: [
          st("A", 1, "10:00:00"),
          st("B", 2, "", "", { pickup_type: 1, drop_off_type: 1 }),
          st("C", 3, "10:10:00"),
        ],
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].map((c) => c.stop)).toEqual(["駅A", "駅C"]);
    expect(calls[0].every((c) => c.arr >= hms(10, 0))).toBe(true);
  });

  it("乗降できる扱いでも着発が両方空欄の行は、時刻が分からないので外す", () => {
    const calls = callsOn(
      feed({
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "", ""), st("C", 3, "10:10:00")],
      }),
    );
    expect(calls[0].map((c) => c.stop)).toEqual(["駅A", "駅C"]);
  });

  it("時刻があっても乗降とも不可の行は外す", () => {
    const calls = callsOn(
      feed({
        stopTimes: [
          st("A", 1, "10:00:00"),
          st("B", 2, "10:05:00", "10:05:00", { pickup_type: 1, drop_off_type: 1 }),
          st("C", 3, "10:10:00"),
        ],
      }),
    );
    expect(calls[0].map((c) => c.stop)).toEqual(["駅A", "駅C"]);
  });

  it("時刻の書式が壊れた行は、空欄と同じく外す", () => {
    const calls = callsOn(
      feed({
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "10:5"), st("C", 3, "10:10:00")],
      }),
    );
    expect(calls[0].map((c) => c.stop)).toEqual(["駅A", "駅C"]);
  });

  it("片方だけ読めない時刻の行は、もう片方で埋めずに外す", () => {
    const calls = callsOn(
      feed({
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "1O:05:00", "10:05:00"), st("C", 3, "10:10:00")],
      }),
    );
    expect(calls[0].map((c) => c.stop)).toEqual(["駅A", "駅C"]);
  });

  it("外した結果、停車が1駅以下になった便は時刻表に入れない", () => {
    const calls = callsOn(
      feed({
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "", "", { pickup_type: 1, drop_off_type: 1 })],
      }),
    );
    expect(calls).toEqual([]);
  });
});

describe("乗車可否・降車可否", () => {
  it("pickup_type と drop_off_type を別々に読む", () => {
    const calls = callsOn(
      feed({
        stopTimes: [
          st("A", 1, "10:00:00", "10:00:00", { drop_off_type: 1 }),
          st("B", 2, "10:05:00", "10:05:00", { pickup_type: 1 }),
          st("C", 3, "10:10:00"),
        ],
      }),
    );
    expect(calls[0].map(({ stop, canBoard, canAlight }) => ({ stop, canBoard, canAlight }))).toEqual([
      { stop: "駅A", canBoard: true, canAlight: false },
      { stop: "駅B", canBoard: false, canAlight: true },
      { stop: "駅C", canBoard: true, canAlight: true },
    ]);
  });

  it("空欄は乗降できる（GTFS の既定値 0）", () => {
    const calls = callsOn(
      feed({
        stopTimes: [
          st("A", 1, "10:00:00", "10:00:00", { pickup_type: "", drop_off_type: "" }),
          st("B", 2, "10:05:00"),
        ],
      }),
    );
    expect(calls[0][0]).toMatchObject({ canBoard: true, canAlight: true });
  });

  it("要予約（2・3）は乗れない・降りられない扱いにする", () => {
    const calls = callsOn(
      feed({
        stopTimes: [
          st("A", 1, "10:00:00", "10:00:00", { pickup_type: 2 }),
          st("B", 2, "10:05:00"),
          st("C", 3, "10:10:00", "10:10:00", { drop_off_type: 3 }),
        ],
      }),
    );
    expect(calls[0][0]).toMatchObject({ stop: "駅A", canBoard: false });
    expect(calls[0][2]).toMatchObject({ stop: "駅C", canAlight: false });
  });
});

describe("着発の時刻", () => {
  it("片方だけ空欄なら、もう片方の時刻を使う", () => {
    const calls = callsOn(
      feed({
        stopTimes: [st("A", 1, "", "10:00:00"), st("B", 2, "10:05:00", "")],
      }),
    );
    expect(calls[0].map(({ arr, dep }) => ({ arr, dep }))).toEqual([
      { arr: hms(10, 0), dep: hms(10, 0) },
      { arr: hms(10, 5), dep: hms(10, 5) },
    ]);
  });

  it("時が1桁の時刻も読む", () => {
    const calls = callsOn(feed({ stopTimes: [st("A", 1, "5:00:00"), st("B", 2, "5:04:30")] }));
    expect(calls[0].map((c) => c.dep)).toEqual([hms(5, 0), hms(5, 4) + 30]);
  });

  it("stop_sequence の数値順に並べる（ファイルの並びや文字列順に頼らない）", () => {
    const calls = callsOn(
      feed({
        stopTimes: [st("C", 10, "10:10:00"), st("A", 2, "10:00:00"), st("B", 9, "10:05:00")],
      }),
    );
    expect(calls[0].map((c) => c.stop)).toEqual(["駅A", "駅B", "駅C"]);
  });
});

describe("運行日", () => {
  const twoTrips = (calendar: Row[] | null, calendarDates: Row[] | null = null) =>
    feed({
      trips: [
        { route_id: "R", service_id: "WD", trip_id: "T" },
      ],
      stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "10:05:00")],
      calendar,
      calendarDates,
    });
  const weekday: Row = { ...EVERY_DAY, service_id: "WD", saturday: 0, sunday: 0 };

  it("calendar の曜日と期間で走る日を決める", () => {
    expect(callsOn(twoTrips([weekday]), "20261020")).toHaveLength(1); // 火
    expect(callsOn(twoTrips([weekday]), "20261024")).toHaveLength(0); // 土
    expect(callsOn(twoTrips([weekday]), "20261102")).toHaveLength(0); // 期間外の月曜
    expect(callsOn(twoTrips([weekday]), "20261031")).toHaveLength(0); // 期間末日の土曜
    expect(callsOn(twoTrips([{ ...weekday, end_date: 20261030 }]), "20261030")).toHaveLength(1);
  });

  it("calendar_dates の 2 で、曜日で走る日を運休にする（祝日）", () => {
    const f = twoTrips([weekday], [{ service_id: "WD", date: 20261020, exception_type: 2 }]);
    expect(callsOn(f, "20261020")).toHaveLength(0);
    expect(callsOn(f, "20261021")).toHaveLength(1);
  });

  it("calendar_dates の 1 で、曜日では走らない日に走らせる", () => {
    const f = twoTrips([weekday], [{ service_id: "WD", date: 20261024, exception_type: 1 }]);
    expect(callsOn(f, "20261024")).toHaveLength(1);
  });

  it("calendar が全部0で calendar_dates だけで走る運行日を拾う", () => {
    const allZero: Row = {
      ...weekday,
      monday: 0,
      tuesday: 0,
      wednesday: 0,
      thursday: 0,
      friday: 0,
    };
    const f = twoTrips([allZero], [{ service_id: "WD", date: 20261103, exception_type: 1 }]);
    expect(callsOn(f, "20261103")).toHaveLength(1);
    expect(callsOn(f, "20261020")).toHaveLength(0);
  });

  it("calendar.txt が無いフィードでも calendar_dates で走る", () => {
    const f = twoTrips(null, [{ service_id: "WD", date: 20261020, exception_type: 1 }]);
    expect(callsOn(f, "20261020")).toHaveLength(1);
  });
});

describe("24時越え", () => {
  const lateTrip = feed({
    trips: [{ route_id: "R", service_id: "WD", trip_id: "LATE" }],
    stopTimes: [
      st("A", 1, "23:50:00", "23:50:00", {}, "LATE"),
      st("B", 2, "24:05:00", "24:05:00", {}, "LATE"),
      st("C", 3, "25:14:00", "25:14:00", {}, "LATE"),
    ],
    // 火曜だけ走る。
    calendar: [
      {
        ...EVERY_DAY,
        service_id: "WD",
        monday: 0,
        wednesday: 0,
        thursday: 0,
        friday: 0,
        saturday: 0,
        sunday: 0,
      },
    ],
  });

  it("運行日の当日は 24:00 以降を 86400 秒以上のまま持つ", () => {
    const calls = callsOn(lateTrip, "20261020");
    expect(calls[0].map((c) => c.arr)).toEqual([hms(23, 50), hms(24, 5), hms(25, 14)]);
  });

  it("前日の運行日の便のうち 24:00 を越えた部分を、翌日の 0 時起点の時刻で混ぜる", () => {
    const calls = callsOn(lateTrip, "20261021");
    expect(calls).toHaveLength(1);
    expect(calls[0].map((c) => [c.stop, c.arr])).toEqual([
      ["駅B", hms(0, 5)],
      ["駅C", hms(1, 14)],
    ]);
  });

  it("前日の便で 24:00 を越えた停車が1駅だけなら混ぜない", () => {
    const f = feed({
      trips: [{ route_id: "R", service_id: "ALL", trip_id: "T" }],
      stopTimes: [st("A", 1, "23:40:00"), st("B", 2, "23:55:00"), st("C", 3, "24:10:00")],
      calendar: [{ ...EVERY_DAY, start_date: 20261020, end_date: 20261020 }],
    });
    expect(callsOn(f, "20261021")).toEqual([]);
  });

  it("厳密走査で、前日の便に当日の 0:00 過ぎから乗れる", () => {
    const pack = buildTimetablePack([lateTrip]);
    const ct = compileTimetable(timetableForDate(pack, "20261021"));
    const [ride] = bestRides(
      ct,
      { origin: pack.stops[1], goal: pack.stops[2], departAt: 0, budgetMin: 120 },
      { access: new Map([[1, 0]]), egress: new Map([[2, 0]]) },
    );
    expect(ride).toMatchObject({ board: 1, alight: 2, boardAt: hms(0, 5), alightAt: hms(1, 14) });
  });

  it("前日に走らない便は、翌日に混ぜない", () => {
    expect(callsOn(lateTrip, "20261022")).toEqual([]);
  });

  it("着が 24:00 前・発が 24:00 後の停車は、乗れる駅として残す", () => {
    const f = feed({
      trips: [{ route_id: "R", service_id: "ALL", trip_id: "T" }],
      stopTimes: [st("A", 1, "23:50:00"), st("B", 2, "23:59:00", "24:01:00"), st("C", 3, "24:10:00")],
      calendar: [{ ...EVERY_DAY, start_date: 20261020, end_date: 20261020 }],
    });
    const calls = callsOn(f, "20261021");
    expect(calls[0].map((c) => [c.stop, c.dep])).toEqual([
      ["駅B", 60],
      ["駅C", hms(0, 10)],
    ]);
  });

  it("月をまたぐ前日も解決する", () => {
    const f = feed({
      trips: [{ route_id: "R", service_id: "ALL", trip_id: "T" }],
      stopTimes: [st("A", 1, "24:10:00"), st("B", 2, "24:20:00")],
      calendar: [{ ...EVERY_DAY, start_date: 20261031, end_date: 20261031 }],
    });
    expect(callsOn(f, "20261101")).toHaveLength(1);
  });
});

describe("駅のまとめ", () => {
  const stationsOf = (stops: Row[], feeds = 1) => {
    const inputs = Array.from({ length: feeds }, (_, f) =>
      feed({
        id: `F${f}`,
        stops,
        trips: [{ route_id: "R", service_id: "ALL", trip_id: "T" }],
        stopTimes: stops.map((s, i) => st(String(s.stop_id), i + 1, `10:0${i}:00`)),
      }),
    );
    const pack = buildTimetablePack(inputs);
    return pack.stops.map((s) => pack.stations[s.station].name + "#" + s.station);
  };
  const at = (id: string, name: string, northMeters: number): Row => ({
    stop_id: id,
    stop_name: name,
    stop_lat: (35 + northMeters / 111195).toFixed(7),
    stop_lon: "139.700000",
  });

  it("同じ名前で 500m 以内の stop を1つの駅にまとめる（JR の路線ごとの stop_id）", () => {
    const [a, b] = stationsOf([at("T1", "東京", 0), at("T2", "東京", 450)]);
    expect(a).toBe(b);
  });

  it("同じ名前でも 500m より離れていれば別の駅にする", () => {
    const [a, b] = stationsOf([at("T1", "府中", 0), at("T2", "府中", 2000)]);
    expect(a).not.toBe(b);
  });

  it("近くても名前が違えば別の駅にする", () => {
    const [a, b] = stationsOf([at("T1", "浜松町", 0), at("T2", "大門", 100)]);
    expect(a).not.toBe(b);
  });

  it("鎖状に 500m 以内でつながる stop もまとめる", () => {
    const names = stationsOf([at("T1", "新宿", 0), at("T2", "新宿", 400), at("T3", "新宿", 800)]);
    expect(new Set(names).size).toBe(1);
  });

  it("フィードをまたいでもまとめる", () => {
    const names = stationsOf([at("T1", "大手町", 0), at("T2", "神田", 1500)], 2);
    expect(names).toHaveLength(4);
    expect(names[0]).toBe(names[2]);
    expect(names[1]).toBe(names[3]);
    expect(names[0]).not.toBe(names[1]);
  });

  it("駅の座標は、まとめた stop の平均にする", () => {
    const pack = buildTimetablePack([
      feed({
        stops: [at("T1", "東京", 0), at("T2", "東京", 400)],
        trips: [{ route_id: "R", service_id: "ALL", trip_id: "T" }],
        stopTimes: [st("T1", 1, "10:00:00"), st("T2", 2, "10:05:00")],
      }),
    ]);
    expect(pack.stations).toHaveLength(1);
    expect(pack.stations[0].lat).toBeCloseTo(35 + 200 / 111195, 6);
  });
});

describe("パックに残すもの", () => {
  it("停車列に一度も出てこない stop（親駅など）は入れない", () => {
    const pack = buildTimetablePack([
      feed({
        stops: [...STOPS, { stop_id: "P", stop_name: "親", stop_lat: "35", stop_lon: "139.7", location_type: 1 }],
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "10:05:00")],
      }),
    ]);
    expect(pack.stops.map((s) => s.name)).toEqual(["駅A", "駅B"]);
  });

  it("路線名・行先・block_id・フィードを便ごとに残す", () => {
    const pack = buildTimetablePack([
      feed({
        id: "JR-East",
        routes: [{ route_id: "R", route_short_name: "JY", route_long_name: "山手線" }],
        trips: [
          { route_id: "R", service_id: "ALL", trip_id: "T", trip_headsign: "上野・池袋方面", block_id: "B9" },
        ],
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "10:05:00")],
      }),
    ]);
    expect(pack.trips[0]).toMatchObject({
      route: "山手線",
      headsign: "上野・池袋方面",
      block: "B9",
      feed: 0,
    });
    expect(pack.feeds[0].id).toBe("JR-East");
  });

  it("route_long_name が空なら route_short_name を路線名にし、行先が空なら null", () => {
    const pack = buildTimetablePack([
      feed({
        routes: [{ route_id: "R", route_short_name: "A" }],
        trips: [{ route_id: "R", service_id: "ALL", trip_id: "T" }],
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "10:05:00")],
      }),
    ]);
    expect(pack.trips[0]).toMatchObject({ route: "A", headsign: null, block: null });
  });

  it("フィードの取得日時と feed_info の版を残す", () => {
    const pack = buildTimetablePack([
      feed({
        stopTimes: [st("A", 1, "10:00:00"), st("B", 2, "10:05:00")],
        feedInfo: "feed_publisher_name,feed_version\n東京都交通局,20261009\n",
      }),
    ]);
    expect(pack.feeds).toEqual([
      { id: "F", fetchedAt: "2026-10-20T19:00:00.000Z", version: "20261009" },
    ]);
  });

  it("時刻表の便から、パックの便と運行日へ戻れる", () => {
    const pack = buildTimetablePack([
      feed({
        trips: [
          { route_id: "R", service_id: "ALL", trip_id: "T1" },
          { route_id: "R", service_id: "ALL", trip_id: "T2" },
        ],
        stopTimes: [
          st("A", 1, "24:10:00", "24:10:00", {}, "T1"),
          st("B", 2, "24:20:00", "24:20:00", {}, "T1"),
          st("A", 1, "10:00:00", "10:00:00", {}, "T2"),
          st("B", 2, "10:05:00", "10:05:00", {}, "T2"),
        ],
      }),
    ]);
    const day = timetableForDate(pack, "20261020");
    expect(day.tripSources).toEqual(
      expect.arrayContaining([
        { packTrip: 0, serviceDate: "20261019" },
        { packTrip: 0, serviceDate: "20261020" },
        { packTrip: 1, serviceDate: "20261020" },
      ]),
    );
    expect(day.tripSources).toHaveLength(day.trips.length);
  });
});
