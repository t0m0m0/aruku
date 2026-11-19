import { describe, expect, it } from 'vitest';

import { ClientException, TimeoutException } from '@aruku/engine/services/http-client';
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
    expect(classifyRouteError(new RouteException(status))).toBe(RouteErrorKind.network);
  });

  it.each(['NO_TRANSIT_API', 'MATRIX_NOT_ARRAY'])('%s は原因不明扱い', (status) => {
    expect(classifyRouteError(new RouteException(status))).toBe(RouteErrorKind.unknown);
  });
});

describe('例外そのものの分類', () => {
  it('TimeoutException は遅延であって通信断ではない', () => {
    expect(classifyRouteError(new TimeoutException('header timeout'))).toBe(RouteErrorKind.timeout);
  });

  it('ClientException は通信系', () => {
    expect(classifyRouteError(new ClientException('Failed to fetch'))).toBe(RouteErrorKind.network);
  });

  it('素の TypeError は通信系にしない', () => {
    expect(classifyRouteError(new TypeError('x is not a function'))).toBe(RouteErrorKind.unknown);
  });

  it('例外ですらない値も落ちずに分類できる', () => {
    expect(classifyRouteError('ごみ')).toBe(RouteErrorKind.unknown);
    expect(classifyRouteError(null)).toBe(RouteErrorKind.unknown);
    expect(classifyRouteError(undefined)).toBe(RouteErrorKind.unknown);
  });
});

describe('復帰導線', () => {
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
