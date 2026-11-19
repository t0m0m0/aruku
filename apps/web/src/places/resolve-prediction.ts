import type { PlacePrediction } from './place-prediction';
import type { PlacesService } from './places-service';
import type { RecentPlace } from './recent-place';

export async function resolvePlacePrediction(
  service: PlacesService,
  prediction: PlacePrediction,
): Promise<RecentPlace | null> {
  let latLng;
  try {
    latLng = await service.fetchLatLng(prediction.placeId);
  } catch {
    latLng = null;
  }
  if (latLng === null) return null;

  return {
    name: prediction.name,
    placeId: prediction.placeId,
    latLng,
    address: prediction.address,
    usedAt: null,
  };
}
