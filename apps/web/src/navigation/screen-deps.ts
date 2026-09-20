import type { SearchMode } from '../features/search/search-screen';
import type { PlacesService } from '../places/places-service';
import type { RecentsRepository } from '../places/recents-repository';

/// 画面が要る外部依存。合成のルート（app.tsx）が組み立て、ルート表が配る。
///
/// router.tsx ではなくここに置くのは、画面の側（home）からも型として要るため
/// ——ルート表は画面を import しているので、逆向きに辿ると循環する。
export interface ScreenDeps {
  readonly places: PlacesService;
  readonly recents: Record<SearchMode, RecentsRepository>;
}
