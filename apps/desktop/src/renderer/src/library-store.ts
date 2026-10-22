import { create } from 'zustand';
import type { Category, ColorId } from '@brickloop/catalog';
import type { ImportReview, LibraryColor, LibraryPart, LibraryStatus } from '../../shared/library-api';
import { reloadAssemblyCatalog, useAssemblyStore } from './assembly-store';

interface LibraryState {
  status: LibraryStatus | null;
  categories: Category[];
  colors: LibraryColor[];
  allColors: LibraryColor[];
  favorites: ColorId[];
  selected: LibraryPart | null;
  currentColor: LibraryColor | null;
  revision: number;
  managerOpen: boolean;
  pendingReview: ImportReview | null;
  error: string | null;
  refresh(): Promise<void>;
  select(part: LibraryPart): void;
  chooseColor(color: LibraryColor): void;
  toggleFavorite(id: ColorId): Promise<void>;
  openManager(open: boolean): void;
}
let generation = 0;
export const useLibraryStore = create<LibraryState>((set, get) => ({
  status: null,
  categories: [],
  colors: [],
  allColors: [],
  favorites: [],
  selected: null,
  currentColor: null,
  revision: 0,
  managerOpen: false,
  pendingReview: null,
  error: null,
  async refresh() {
    const request = ++generation;
    const previousPack = get().status?.pack;
    try {
      const status = await window.brickloop.catalogStatus();
      if (request !== generation) return;
      if (status.state !== 'ready') {
        set({ status });
        return;
      }
      const [categories, colors, settings] = await Promise.all([
        window.brickloop.catalogCategories(),
        window.brickloop.catalogColors(),
        window.brickloop.getSettings(),
      ]);
      if (request !== generation) return;
      const previous = get().currentColor?.id;
      useAssemblyStore.setState({ maintenance: settings.maintenanceMode ?? false });
      set({
        status,
        categories,
        colors: colors.factory,
        allColors: colors.all,
        favorites: settings.favoriteColors ?? [],
        currentColor:
          colors.factory.find((color) => color.id === previous) ??
          colors.factory.find((color) => color.id === 'c:bright-red') ??
          colors.factory[0] ??
          null,
        selected: null,
        revision: get().revision + 1,
        error: null,
      });
      if (
        previousPack &&
        (previousPack.id !== status.pack?.id || previousPack.contentHash !== status.pack?.contentHash)
      )
        await reloadAssemblyCatalog();
    } catch {
      if (request === generation) set({ error: 'loadFailed' });
    }
  },
  select: (selected) => set({ selected }),
  chooseColor: (currentColor) => set({ currentColor }),
  openManager: (managerOpen) => set({ managerOpen }),
  async toggleFavorite(id) {
    const favorites = get().favorites.includes(id)
      ? get().favorites.filter((color) => color !== id)
      : [...get().favorites, id];
    try {
      set({ favorites: await window.brickloop.setFavoriteColors(favorites), error: null });
    } catch {
      set({ error: 'saveFailed' });
    }
  },
}));
