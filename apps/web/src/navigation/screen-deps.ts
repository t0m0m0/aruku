import type { SearchMode } from '../features/search/search-screen';
import type { PlacesService } from '../places/places-service';
import type { RecentsRepository } from '../places/recents-repository';

export interface ScreenDeps {
  readonly places: PlacesService;
  readonly recents: Record<SearchMode, RecentsRepository>;
}
