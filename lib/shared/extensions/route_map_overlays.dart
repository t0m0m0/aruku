import 'package:flutter/painting.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/models/route_plan.dart';

const _walkColor = Color(0xFF4F9527);
const _trainColor = Color(0xFF3E6792);

extension RouteMapOverlays on RoutePlan {
  Set<Polyline> toPolylines() {
    final result = <Polyline>{};
    for (var i = 0; i < segments.length; i++) {
      final seg = segments[i];
      if (seg.polyline.isEmpty) continue;
      final isWalk = seg.type == SegmentType.walk;
      result.add(
        Polyline(
          polylineId: PolylineId('seg-$i'),
          points: seg.polyline.map((p) => LatLng(p.lat, p.lng)).toList(),
          color: isWalk ? _walkColor : _trainColor,
          width: isWalk ? 5 : 6,
          startCap: Cap.roundCap,
          endCap: Cap.roundCap,
          jointType: JointType.round,
          patterns: isWalk
              ? [PatternItem.dash(20), PatternItem.gap(12)]
              : const [],
        ),
      );
    }
    return result;
  }

  List<LatLng> get _allPoints => [
    for (final s in segments)
      for (final p in s.polyline) LatLng(p.lat, p.lng),
  ];

  Set<Marker> toMarkers() {
    final points = _allPoints;
    if (points.isEmpty) return {};
    return {
      Marker(
        markerId: const MarkerId('start'),
        position: points.first,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
      ),
      Marker(
        markerId: const MarkerId('end'),
        position: points.last,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
      ),
    };
  }

  LatLngBounds? toBounds() {
    final points = _allPoints;
    if (points.isEmpty) return null;
    var minLat = points.first.latitude;
    var maxLat = points.first.latitude;
    var minLng = points.first.longitude;
    var maxLng = points.first.longitude;
    for (final p in points) {
      minLat = p.latitude < minLat ? p.latitude : minLat;
      maxLat = p.latitude > maxLat ? p.latitude : maxLat;
      minLng = p.longitude < minLng ? p.longitude : minLng;
      maxLng = p.longitude > maxLng ? p.longitude : maxLng;
    }
    return LatLngBounds(
      southwest: LatLng(minLat, minLng),
      northeast: LatLng(maxLat, maxLng),
    );
  }
}
