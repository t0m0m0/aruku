// 移植元: lib/core/models/route_error.dart と test/core/models/route_error_test.dart

import { describe, expect, it } from 'vitest';

import {
  ClientException,
  TimeoutException,
} from '@aruku/engine/services/http-client';
import { RouteException } from '@aruku/engine/services/route-service';

import { RouteErrorKind } from '../../src/state/app-state';
import { classifyRouteError, routeErrorView } from '../../src/state/route-error';

describe('エンジンが投げるステータスの分類', () => {
  it.each([
    ['NO_ORIGIN', RouteErrorKind.noLocation],
    ['NO_DESTINATION', RouteErrorKind.noDestination],
    ['ZERO_RESULTS', RouteErrorKind.noResults],
    ['TIMEOUT', RouteErrorKind.timeout],
  ])('%s は %s', (status, expected) => {
    expect(classifyRouteError(new RouteException(status))).toBe(expected);
  });

  it.each(['HTTP 500', 'HTTP 429', 'HTTP 401'])('%s は通信系', (status) => {
    expect(classifyRouteError(new RouteException(status))).toBe(
      RouteErrorKind.network,
    );
  });

  // 設定・配線の失敗。ユーザーの操作では直らないので、再試行を促す network にも
  // 条件変更を促す noResults にも寄せない。
  it.each(['NO_TRANSIT_API', 'MATRIX_NOT_ARRAY'])('%s は原因不明扱い', (status) => {
    expect(classifyRouteError(new RouteException(status))).toBe(
      RouteErrorKind.unknown,
    );
  });
});

describe('例外そのものの分類', () => {
  // タイムアウトを network に丸めない。上流の遅延は通信断ではなく、「通信状況を
  // 確認して再試行」は電波が正常なユーザーを的外れな導線へ送る（#300）。
  it('TimeoutException は遅延であって通信断ではない', () => {
    expect(classifyRouteError(new TimeoutException('header timeout'))).toBe(
      RouteErrorKind.timeout,
    );
  });

  // fetch の TypeError はトランスポート層（FetchHttpClient）が ClientException へ
  // 寄せて届く。移植元が dart:io の IOException と http の ClientException を両方
  // 見ていたのは、dart2js の dart:io がスタブで Web では一致しないため（#359）。
  // こちらは層が1つに揃えているので、その二重性は運ばない。
  it('ClientException は通信系', () => {
    expect(classifyRouteError(new ClientException('Failed to fetch'))).toBe(
      RouteErrorKind.network,
    );
  });

  // ここを network にすると、本物のバグが「通信状況を確認してください」として
  // ユーザーにも我々にも見えなくなる。通信の TypeError は上記のとおり包まれて届く。
  it('素の TypeError は通信系にしない', () => {
    expect(classifyRouteError(new TypeError('x is not a function'))).toBe(
      RouteErrorKind.unknown,
    );
  });

  it('例外ですらない値も落ちずに分類できる', () => {
    expect(classifyRouteError('ごみ')).toBe(RouteErrorKind.unknown);
    expect(classifyRouteError(null)).toBe(RouteErrorKind.unknown);
    expect(classifyRouteError(undefined)).toBe(RouteErrorKind.unknown);
  });
});

describe('復帰導線', () => {
  // 種別ごとに「まず何をさせるか」が変わる。再試行で直らないものに再試行を
  // 出すと、同じ失敗を繰り返させる。
  it.each([
    [RouteErrorKind.network, 'retry'],
    [RouteErrorKind.timeout, 'retry'],
    [RouteErrorKind.noLocation, 'retry'],
    [RouteErrorKind.unknown, 'retry'],
    [RouteErrorKind.noResults, 'changeConditions'],
    [RouteErrorKind.noDestination, 'changeConditions'],
  ])('%s の主導線は %s', (kind, recovery) => {
    expect(routeErrorView(kind).primaryRecovery).toBe(recovery);
  });

  it('種別ごとに違う文言を持つ', () => {
    const kinds = Object.values(RouteErrorKind);
    const titles = kinds.map((k) => routeErrorView(k).title);

    expect(new Set(titles).size).toBe(kinds.length);
    for (const kind of kinds) {
      expect(routeErrorView(kind).title).not.toBe('');
      expect(routeErrorView(kind).description).not.toBe('');
    }
  });
});
