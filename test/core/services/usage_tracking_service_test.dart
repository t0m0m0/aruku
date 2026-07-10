import 'package:aruku/core/services/usage_tracking_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('NoopUsageTrackingService', () {
    test('recordSearch は例外なく no-op', () async {
      const service = NoopUsageTrackingService();
      await service.recordSearch();
    });
  });
}
