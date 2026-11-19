import type { FakePlace } from './upstream/fake-upstream';

export const currentPosition = { latitude: 35.6812, longitude: 139.7671 };

export const destinationPlace: FakePlace = {
  placeId: 'fake-place-destination',
  name: 'テスト公園',
  description: 'テスト公園, 東京都テスト区1-2-3',
  lat: 35.7295,
  lng: 139.7109,
};

export const otherPlace: FakePlace = {
  placeId: 'fake-place-other',
  name: 'テスト会館',
  description: 'テスト会館, 東京都テスト区4-5-6',
  lat: 35.7101,
  lng: 139.7702,
};

export const places: readonly FakePlace[] = [destinationPlace, otherPlace];
