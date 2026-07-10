import 'package:aruku/core/services/analytics_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('NoopAnalyticsService', () {
    test('全メソッドが例外なく no-op', () {
      const service = NoopAnalyticsService();
      service.logSearchRequested();
      service.logSearchFallbackTriggered(
        navitimeCalls: 1,
        googleWalkCalls: 2,
        googleMatrixCalls: 3,
      );
      service.logSearchApiCalls(
        navitimeCalls: 1,
        googleWalkCalls: 2,
        googleMatrixCalls: 3,
        fallbackTriggered: true,
      );
    });
  });
}
