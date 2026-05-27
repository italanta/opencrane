import { computed, signal, type Signal } from "@angular/core";

import type { Grant } from "../../core/models/grant.model";

/** Shared minimum shape required to drive local entitlement preview state. */
export interface EntitlementPreviewTarget
{
  /** Stable record identifier. */
  id: string;
  /** Compiled grants attached to the record. */
  grants: Grant[];
}

/** Shared signal state returned to catalog pages with local grant previews. */
export interface EntitlementCatalogPageState<T extends EntitlementPreviewTarget>
{
  /** Currently selected record identifier. */
  readonly selectedId: Signal<string | null>;
  /** Selected record or the first available fallback. */
  readonly selectedItem: Signal<T | null>;
  /** Grants for the selected record with local preview overrides applied. */
  readonly selectedItemGrants: Signal<Grant[]>;
  /** Update the selected record identifier. */
  selectItem: (itemId: string) => void;
  /** Persist local preview grants for the selected record. */
  updateSelectedGrants: (grants: Grant[]) => void;
}

/**
 * Build the local selection and grant-preview state used by the catalog-style pages.
 *
 * @param items - Signal containing the loaded catalog items.
 * @returns Reusable selection state and handlers.
 */
export function createEntitlementCatalogPageState<T extends EntitlementPreviewTarget>(items: Signal<T[]>): EntitlementCatalogPageState<T>
{
  const selectedId = signal<string | null>(null);
  const grantOverrides = signal<Record<string, Grant[]>>({});
  const selectedItem = computed(function _computeSelectedItem(): T | null
  {
    const currentSelectedId = selectedId();
    if (currentSelectedId)
    {
      const matchingItem = items().find(function _matchItem(item)
      {
        return item.id === currentSelectedId;
      });

      if (matchingItem)
      {
        return matchingItem;
      }
    }

    return items()[0] ?? null;
  });
  const selectedItemGrants = computed(function _computeSelectedItemGrants(): Grant[]
  {
    const currentSelectedItem = selectedItem();
    if (!currentSelectedItem)
    {
      return [];
    }

    return grantOverrides()[currentSelectedItem.id] ?? currentSelectedItem.grants;
  });

  return {
    selectedId,
    selectedItem,
    selectedItemGrants,
    selectItem(itemId: string): void
    {
      selectedId.set(itemId);
    },
    updateSelectedGrants(grants: Grant[]): void
    {
      const currentSelectedItem = selectedItem();
      if (!currentSelectedItem)
      {
        return;
      }

      grantOverrides.set({
        ...grantOverrides(),
        [currentSelectedItem.id]: grants,
      });
    },
  };
}
