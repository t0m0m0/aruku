// 移植元: lib/features/search/desktop_typeahead_field.dart（#372）。
//
// 全画面の検索へ飛ばさず、その場で目的地を決めきる欄。デスクトップ幅の home が使う。
//
// 「近くの店」（#146）は置かない。移植元はフォーカスのたびに `setNearby(false)` して
// いたが、それは全画面検索と検索状態を共有していたため——ここは自前の検索状態を持つ
// ので、引き継ぐモードがそもそも無い。

import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';

import { ja, searchErrorWithStatus } from '../../i18n/ja';
import type { PlacePrediction } from '../../places/place-prediction';
import type { PlacesService } from '../../places/places-service';
import type { RecentPlace } from '../../places/recent-place';
import type { RecentsRepository } from '../../places/recents-repository';
import { resolvePlacePrediction } from '../../places/resolve-prediction';
import { SearchIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import { createSearchState } from './search-state';
import type { SearchMode } from './search-screen';
import styles from './typeahead-field.module.css';

interface TypeaheadFieldProps {
  store: StoreApi<AppStore>;
  mode: SearchMode;
  places: PlacesService;
  recents: RecentsRepository;

  /// 欄そのものへの参照。目的地が未選択のときの CTA が焦点を移すのに使う
  /// （home の CTA は、この幅では全画面の検索へ飛ばさない）。
  inputRef?: RefObject<HTMLInputElement | null>;
}

interface Entry {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  select(): void;
}

export function TypeaheadField({
  store,
  mode,
  places,
  recents,
  inputRef,
}: TypeaheadFieldProps) {
  const locationState = useStore(store, (s) => s.locationState);
  const selected = useStore(store, (s) =>
    mode === 'origin' ? s.origin : s.destination,
  );
  const setDestination = useStore(store, (s) => s.setDestination);
  const setOrigin = useStore(store, (s) => s.setOrigin);

  const locationRef = useRef<GeoPoint | null>(null);
  locationRef.current =
    locationState.kind === 'available' ? locationState.position : null;

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

  /// null は「確定済みの地点を映している」。打ち始めると文字列になり、確定で null へ
  /// 戻る。移植元は入力を空にして確定名を hintText へ出していたが、placeholder は
  /// 読み上げ名にならない——欄が何を指しているかが支援技術から消える。
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [pickFailed, setPickFailed] = useState(false);
  const [saved, setSaved] = useState<RecentPlace[]>(() => recents.load());

  // 座標解決の await を跨いで外されたら続きを走らせない（PORTING.md の
  // 「await を跨ぐ操作には mounted 相当のガードが要る」）。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 確定の世代。待っている間に打ち替えられたら、その確定はもう欄が指していない。
  const generation = useRef(0);
  const selecting = useRef(false);

  const typed = query ?? '';
  const listId = useId();

  /// 選択位置の行。一覧は 320px で頭打ちなので、↓ を押し続けると見えない行が
  /// 選ばれたままになる（PR #407 の Codex レビュー）。
  const activeOption = useRef<HTMLLIElement>(null);

  function apply(place: RecentPlace) {
    recents.add(place);
    setSaved(recents.load());
    if (mode === 'origin') setOrigin(place.name, place.latLng);
    else setDestination(place.name, place.latLng);
    setQuery(null);
    setPickFailed(false);
    setOpen(false);
    // 並びが候補から履歴へ替わる。位置を残すと、開き直したときに存在しない行を
    // 指したままになる（PR #407 の Codex レビュー）。
    setHighlighted(0);
    search.getState().search('');
  }

  async function selectPrediction(prediction: PlacePrediction) {
    if (selecting.current) return;
    const gen = ++generation.current;
    selecting.current = true;

    const resolved = await resolvePlacePrediction(places, prediction);
    selecting.current = false;
    if (!alive.current || gen !== generation.current) return;

    // 座標を引けない候補は確定させない。黙って無反応にすると「押しても何も起きない
    // 候補」になるので、理由を出して選び直させる。
    if (resolved === null) {
      setPickFailed(true);
      return;
    }
    apply(resolved);
  }

  const entries: Entry[] =
    typed === ''
      ? saved.map((place) => ({
          // 履歴の placeId は null になり得る（座標だけ持つ「現在地」等）。
          key: place.placeId ?? place.name,
          name: place.name,
          detail: place.address ?? '',
          select: () => {
            apply(place);
          },
        }))
      : suggestions.map((prediction) => ({
          key: prediction.placeId,
          name: prediction.name,
          detail: prediction.address,
          select: () => {
            void selectPrediction(prediction);
          },
        }));

  function onChange(next: string) {
    // 打ち替えを始めた時点で、確定済みの地点は「今その欄が指しているもの」でなくなる。
    // 残すと表示は新しいクエリ・状態は古い座標というズレになり、CTA が有効なまま
    // 前の目的地へ経路を引く（移植元 _clearSelection）。
    if (selected !== null) {
      if (mode === 'origin') setOrigin(null, null);
      else setDestination(null, null);
    }
    generation.current++;
    // 確定中の錠も解く。古い確定は世代で無効化されるので、待たせる理由が無い
    // ——持ったままだと、新しい候補を押しても無反応な数秒が残る
    // （PR #407 の Codex レビュー）。
    selecting.current = false;
    setQuery(next);
    setHighlighted(0);
    setPickFailed(false);
    setOpen(true);
    search.getState().search(next);
  }

  function move(delta: number) {
    if (entries.length === 0) return;
    setHighlighted((current) =>
      Math.min(Math.max(current + delta, 0), entries.length - 1),
    );
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        // 既定の「行頭／行末へ移動」を止める。単一行の入力では文字カーソルが飛ぶ。
        event.preventDefault();
        // 閉じているときは開き直す合図。Escape のあと、打ち替えるまで二度と
        // 開けない欄にしない。
        if (!open) {
          setOpen(true);
          return;
        }
        move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'Escape':
        setOpen(false);
        return;
      case 'Enter':
        event.preventDefault();
        // 閉じている一覧からは確定しない。候補と選択位置は閉じても残るので、
        // 素通しすると aria-expanded=false の欄で見えていない候補が入る
        // （PR #407 の Codex レビュー）。
        if (!open) return;
        entries[activeIndex]?.select();
        return;
      default:
        return;
    }
  }

  // 並びは打鍵のたびに入れ替わり、確定した行より短くなることもある。移動時の
  // クランプ（move）だけでは足りないので、描画のたびに丸める。
  const activeIndex = Math.min(highlighted, Math.max(entries.length - 1, 0));
  const showList = open && entries.length > 0;
  // 選択位置が変わるたびに、その行を一覧の中へ送る。`block: 'nearest'` は
  // 既に見えている行では何もしない——押すたびに一覧が跳ねるのを避ける。
  useEffect(() => {
    if (!showList) return;
    activeOption.current?.scrollIntoView({ block: 'nearest' });
  }, [showList, activeIndex, entries.length]);

  const message = messageFor({
    open,
    typed,
    status,
    errorStatus,
    pickFailed,
    mode,
    // 一覧が出ているならメッセージは出さない。両方出ると、候補が並んでいるのに
    // 「見つかりませんでした」と書かれた画面になる（実ブラウザで発覚）。
    hasEntries: entries.length > 0,
  });

  return (
    <div className={styles.wrap}>
      <div className={`${styles.field} ${open ? styles.fieldOpen : ''}`}>
        <SearchIcon size={17} />
        <input
          type="text"
          role="combobox"
          className={styles.input}
          // 中身から名前を組ませない。値が入った時点で読み上げ名が入力値へ変わる。
          aria-label={mode === 'origin' ? ja.searchOriginHint : ja.searchDestinationHint}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
          placeholder={
            mode === 'origin' ? ja.homeDepartureLabel : ja.homeDestinationPlaceholder
          }
          value={query ?? selected ?? ''}
          ref={inputRef}
          onFocus={() => {
            setOpen(true);
          }}
          // 確定しても焦点は欄に残る（候補の押下で blur を止めているため）。
          // focus だけを開く合図にすると、二度目に押しても開かない。
          onClick={() => {
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
          }}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {showList && (
        <ul className={styles.list} id={listId} role="listbox">
          {entries.map((entry, index) => (
            <li
              key={entry.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`${styles.option} ${index === activeIndex ? styles.optionActive : ''}`}
              ref={index === activeIndex ? activeOption : null}
              // 押した時点で入力から焦点が外れると、blur が先に一覧を閉じて
              // click が宙に浮く。既定の焦点移動だけ止める。
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={entry.select}
            >
              <span className={styles.optionName}>{entry.name}</span>
              {entry.detail !== '' && (
                <span className={styles.optionDetail}>{entry.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {message !== null && (
        <p className={styles.message} role="status">
          {message}
        </p>
      )}
    </div>
  );
}

interface MessageInput {
  open: boolean;
  typed: string;
  status: 'idle' | 'loading' | 'success' | 'error';
  errorStatus: string | null;
  pickFailed: boolean;
  mode: SearchMode;
  hasEntries: boolean;
}

/// 一覧に出せる行が無いときに、代わりに出す一文。無言で閉じない——候補が出ない
/// 理由（打ち間違い・通信・座標が引けない）が画面から復元できなくなる。
function messageFor({
  open,
  typed,
  status,
  errorStatus,
  pickFailed,
  mode,
  hasEntries,
}: MessageInput): string | null {
  if (pickFailed) {
    return mode === 'origin'
      ? ja.searchPickFailedOrigin
      : ja.searchPickFailedDestination;
  }
  if (!open || typed === '' || hasEntries) return null;
  if (status === 'error') {
    // 生ステータスが取れないときは原因不明の汎用エラー（search-state.ts）。
    return errorStatus === null
      ? ja.searchErrorGeneric
      : searchErrorWithStatus(errorStatus);
  }
  if (status === 'success') return ja.searchEmptyTitle;
  return null;
}
