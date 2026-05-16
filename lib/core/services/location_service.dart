import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../models/geo_point.dart';
import '../models/location_state.dart';

abstract interface class LocationService {
  Future<LocationState> request();
}

class GeolocatorLocationService implements LocationService {
  @override
  Future<LocationState> request() async {
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) return const LocationDenied();

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return const LocationDenied();
      }

      final pos = await Geolocator.getCurrentPosition();
      return LocationAvailable(GeoPoint(pos.latitude, pos.longitude));
    } catch (_) {
      return const LocationDenied();
    }
  }
}

final locationServiceProvider = Provider<LocationService>(
  (_) => GeolocatorLocationService(),
);
