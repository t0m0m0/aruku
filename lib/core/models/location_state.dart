import 'package:flutter/foundation.dart';

import 'geo_point.dart';

sealed class LocationState {
  const LocationState();
}

@immutable
class LocationLoading extends LocationState {
  const LocationLoading();
}

@immutable
class LocationAvailable extends LocationState {
  const LocationAvailable(this.position);

  final GeoPoint position;
}

@immutable
class LocationDenied extends LocationState {
  const LocationDenied();
}
