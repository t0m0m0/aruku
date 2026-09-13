// 移植元: lib/features/search/search_screen.dart と search_widgets.dart。
//
// デスクトップ幅のタイプアヘッド（desktop_typeahead_field.dart）は運んでいない。
// あれは #372 のデスクトップ作り分け（DesktopContent / DesktopTimeField と対）で、
// 時刻フィールドがまだ押せない現状で入力欄だけデスクトップ化しても片肺になる。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';

import { ja, searchErrorWithStatus } from '../../i18n/ja';
import { useInitialLocation } from '../../location/use-initial-location';
import { Screen } from '../../navigation/screens';
import type { PlacePrediction } from '../../places/place-prediction';
import type { PlacesService } from '../../places/places-service';
import type { RecentPlace } from '../../places/recent-place';
import type { RecentsRepository } from '../../places/recents-repository';
import { resolvePlacePrediction } from '../../places/resolve-prediction';
import { ChevronIcon, CloseIcon, CompassIcon, PinIcon, SearchIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import { createSearchState } from './search-state';
import styles from './search-screen.module.css';

export type SearchMode = 'destination' | 'origin';

interface SearchScreenProps {
  store: StoreApi<AppStore>;
  mode: SearchMode;
  places: PlacesService;

  /// 系統ごとの履歴。モードで選ぶのは画面の側。呼ぶ側に選ばせると、mode と渡された
  /// リポジトリが食い違っても型が通ってしまう——目的地の履歴に出発地が混ざる。
  recents: Record<SearchMode, RecentsRepository>;
}

export function SearchScreen({ store, mode, places, recents }: SearchScreenProps) {
  const locationState = useStore(store, (s) => s.locationState);
  const go = useStore(store, (s) => s.go);
  const setDestination = useStore(store, (s) => s.setDestination);
  const setOrigin = useStore(store, (s) => s.setOrigin);

  const currentLocation: GeoPoint | null =
    locationState.kind === 'available' ? locationState.position : null;

  // 位置は「取得できたか」だけを見る。GeoPoint をそのまま依存に入れると、同じ座標でも
  // 取り直しのたびに別インスタンスになり、検索の状態が作り直される。
  const located = currentLocation !== null;
  const locationRef = useRef(currentLocation);
  locationRef.current = currentLocation;

  const history = recents[mode];

  // home を経由せず直接開かれた場合、home の effect は走らない。取りに行かないと
  // 位置が loading のまま固まり、位置バイアスも「近くの店」も永久に出ない
  // （PR #395 の Codex レビュー）。決着済みなら何もしない。
  useInitialLocation(store);

  // 移植元の `State.mounted` に対応する（search_screen.dart の `if (!mounted) return;`）。
  // 座標解決の await を跨いで離脱されたとき、続きを走らせてはいけない——届いた座標が
  // 目的地を書き換え、その後に開いた画面から home へ飛ばす。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const search = useMemo(
    () =>
      createSearchState({
        service: places,
        currentLocation: () => locationRef.current,
      }),
    [places],
  );
  useEffect(() => () => search.getState().dispose(), [search]);

  const status = useStore(search, (s) => s.status);
  const suggestions = useStore(search, (s) => s.suggestions);
  const errorStatus = useStore(search, (s) => s.errorStatus);
  const nearby = useStore(search, (s) => s.nearby);

  const [query, setQuery] = useState('');
  const [pickFailed, setPickFailed] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [saved, setSaved] = useState<RecentPlace[]>(() => history.load());

  function applySelection(name: string | null, latLng: GeoPoint | null) {
    if (mode === 'origin') setOrigin(name, latLng);
    else setDestination(name, latLng);
    go(Screen.home);
  }

  function remember(place: RecentPlace) {
    history.add(place);
    setSaved(history.load());
  }

  async function selectPrediction(prediction: PlacePrediction) {
    // 座標解決の最中に別の候補を押せると、2件目の結果が1件目を上書きする。
    if (selecting) return;
    setSelecting(true);
    setPickFailed(false);

    const resolved = await resolvePlacePrediction(places, prediction);
    if (!alive.current) return;
    setSelecting(false);
    if (resolved === null) {
      setPickFailed(true);
      return;
    }
    remember(resolved);
    applySelection(resolved.name, resolved.latLng);
  }

  // 再訪したものを最新として先頭へ繰り上げる。
  function selectRecent(place: RecentPlace) {
    remember(place);
    applySelection(place.name, place.latLng);
  }

  function useCurrentLocation() {
    // 出発地の null は「未設定」ではなく現在地を使う、の意味。座標は要らない——
    // 検索は出発地が無ければ現在地を取りに行く。
    if (mode === 'origin') {
      applySelection(null, null);
      return;
    }
    // 目的地に現在地を入れるには座標が要る。ボタン自体、取れているときしか出さない。
    if (currentLocation === null) return;
    applySelection(ja.searchCurrentLocationName, currentLocation);
  }

  function onQueryChange(next: string) {
    setQuery(next);
    setPickFailed(false);
    search.getState().search(next);
  }

  function clearHistory() {
    history.clear();
    setSaved([]);
  }

  // 出発地モードでは測位できていなくても「現在地を使う」を出す。出発地の未設定は
  // 現在地の意味なので、今の取得状況に関わらず選べる必要がある。
  const showCurrentLocation = mode === 'origin' || located;

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>

        <div className={styles.field}>
          <SearchIcon size={18} />
          <input
            type="search"
            className={styles.input}
            // 中身から名前を組ませない。placeholder だけだと、値が入った時点で
            // 読み上げ名が入力値へ差し替わる。
            aria-label={
              mode === 'origin' ? ja.searchOriginHint : ja.searchDestinationHint
            }
            placeholder={
              mode === 'origin' ? ja.searchOriginHint : ja.searchDestinationHint
            }
            value={query}
            autoFocus
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
          />
          {query !== '' && (
            <button
              type="button"
              className={styles.clear}
              aria-label={ja.searchClearInput}
              onClick={() => {
                onQueryChange('');
              }}
            >
              <CloseIcon size={18} />
            </button>
          )}
        </div>
      </header>

      {/* 距離の基準が取れないと並べ替えられないので、現在地が分かるときだけ出す。 */}
      {located && (
        <button
          type="button"
          role="switch"
          aria-checked={nearby}
          className={`${styles.nearby} ${nearby ? styles.nearbyOn : ''}`}
          onClick={() => {
            search.getState().setNearby(!nearby);
          }}
        >
          <CompassIcon size={15} />
          <span>{ja.searchNearbyToggle}</span>
        </button>
      )}

      {query !== '' ? (
        <Results
          status={status}
          errorStatus={errorStatus}
          suggestions={suggestions}
          query={query}
          mode={mode}
          pickFailed={pickFailed}
          selecting={selecting}
          onSelect={selectPrediction}
        />
      ) : (
        <Recents
          mode={mode}
          places={saved}
          showCurrentLocation={showCurrentLocation}
          onUseCurrentLocation={useCurrentLocation}
          onSelect={selectRecent}
          onClear={clearHistory}
        />
      )}
    </main>
  );
}

interface ResultsProps {
  status: 'idle' | 'loading' | 'success' | 'error';
  errorStatus: string | null;
  suggestions: PlacePrediction[];
  query: string;
  mode: SearchMode;
  pickFailed: boolean;
  selecting: boolean;
  onSelect: (prediction: PlacePrediction) => void;
}

function Results({
  status,
  errorStatus,
  suggestions,
  query,
  mode,
  pickFailed,
  selecting,
  onSelect,
}: ResultsProps) {
  if (status === 'idle') return null;

  if (status === 'loading') {
    return (
      <div className={styles.list} aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={styles.skeletonRow} aria-hidden="true">
            <span className={styles.skeletonIcon} />
            <span className={styles.skeletonLines}>
              <span className={styles.skeletonTitle} />
              <span className={styles.skeletonSub} />
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.notice}>
        <SearchIcon size={32} />
        <p className={styles.noticeTitle}>
          {errorStatus !== null
            ? searchErrorWithStatus(errorStatus)
            : ja.searchErrorGeneric}
        </p>
        <p className={styles.noticeHint}>{ja.searchNetworkHint}</p>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className={styles.notice}>
        <PinIcon size={32} />
        <p className={styles.noticeTitle}>{ja.searchEmptyTitle}</p>
        <p className={styles.noticeHint}>{ja.searchEmptyHint}</p>
      </div>
    );
  }

  return (
    <>
      {/* 移植元は確定中に CircularProgressIndicator を重ねていた。ここでは行を
          押せなくして淡くするだけなので、見えない代わりに読み上げへ出す
          （base.css の .srOnly はこの用途のために置いてある）。 */}
      <span className="srOnly" role="status">
        {selecting ? ja.searchResolvingPlace : ''}
      </span>
      {pickFailed && (
        <p className={styles.pickFailed} role="alert">
          {mode === 'origin'
            ? ja.searchPickFailedOrigin
            : ja.searchPickFailedDestination}
        </p>
      )}
      <div className={styles.list}>
        {suggestions.map((s) => (
          <PlaceRow
            key={s.placeId}
            name={s.name}
            address={s.address}
            query={query}
            disabled={selecting}
            onSelect={() => {
              onSelect(s);
            }}
          />
        ))}
      </div>
    </>
  );
}

interface RecentsProps {
  mode: SearchMode;
  places: RecentPlace[];
  showCurrentLocation: boolean;
  onUseCurrentLocation: () => void;
  onSelect: (place: RecentPlace) => void;
  onClear: () => void;
}

function Recents({
  mode,
  places,
  showCurrentLocation,
  onUseCurrentLocation,
  onSelect,
  onClear,
}: RecentsProps) {
  if (!showCurrentLocation && places.length === 0) return null;

  return (
    <div className={styles.list}>
      {showCurrentLocation && (
        <button
          type="button"
          className={styles.row}
          aria-label={ja.searchUseCurrentLocation}
          onClick={onUseCurrentLocation}
        >
          <span className={styles.rowIcon}>
            <CompassIcon size={18} />
          </span>
          <span className={styles.rowName}>{ja.searchUseCurrentLocation}</span>
        </button>
      )}

      {places.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              {mode === 'origin'
                ? ja.searchRecentOrigins
                : ja.searchRecentDestinations}
            </h2>
            <button type="button" className={styles.clearHistory} onClick={onClear}>
              {ja.searchClearHistory}
            </button>
          </div>
          {places.map((place) => (
            <PlaceRow
              key={`${place.placeId ?? ''}:${place.name}`}
              name={place.name}
              address={place.address ?? ''}
              onSelect={() => {
                onSelect(place);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

interface PlaceRowProps {
  name: string;
  address: string;
  query?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/// 候補と履歴で共通の1行。読み上げ名は「名称 住所」で明示する——中身から組ませると、
/// jsdom（CSS を読まない）と実ブラウザで語の区切りが食い違う。
function PlaceRow({ name, address, query, disabled, onSelect }: PlaceRowProps) {
  return (
    <button
      type="button"
      className={styles.row}
      aria-label={address !== '' ? `${name} ${address}` : name}
      disabled={disabled ?? false}
      onClick={onSelect}
    >
      <span className={styles.rowIcon}>
        <PinIcon size={18} />
      </span>
      <span className={styles.rowText}>
        <span className={styles.rowName}>
          <Highlighted text={name} query={query ?? ''} />
        </span>
        {address !== '' && <span className={styles.rowAddress}>{address}</span>}
      </span>
    </button>
  );
}

/// 打った語に当たる部分へ印を付ける。大小文字を無視して**最初の1箇所**だけ——
/// 移植元と同じ。
function Highlighted({ text, query }: { text: string; query: string }) {
  if (query === '') return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className={styles.match}>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}
