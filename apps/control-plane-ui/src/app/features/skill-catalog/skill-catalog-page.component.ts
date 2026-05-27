import { Component, computed, inject } from "@angular/core";
import { rxResource } from "@angular/core/rxjs-interop";
import type { Observable } from "rxjs";
import { ButtonModule } from "primeng/button";
import { MessageModule } from "primeng/message";
import { ProgressSpinnerModule } from "primeng/progressspinner";
import { TagModule } from "primeng/tag";

import { GroupsService } from "../../core/api/groups.service";
import { SkillCatalogService } from "../../core/api/skill-catalog.service";
import type { Group } from "../../core/models/group.model";
import { SkillBundleStatus, type SkillBundle } from "../../core/models/skill-bundle.model";
import { createEntitlementCatalogPageState } from "../shared/entitlement-catalog-page.state";
import { GrantEditorComponent } from "../../shared/components/grant-editor/grant-editor.component";
import { SkillCardComponent } from "../../shared/components/skill-card/skill-card.component";
import { UiSectionCardComponent } from "../../shared/components/ui-section-card/ui-section-card.component";
import { getGrantScopeSeverity } from "../../shared/utils/grant-scope-severity";

/** Operator page for the registry-backed skill catalog. */
@Component({
  selector: "oc-skill-catalog-page",
  standalone: true,
  imports: [
    ButtonModule,
    MessageModule,
    ProgressSpinnerModule,
    TagModule,
    GrantEditorComponent,
    SkillCardComponent,
    UiSectionCardComponent,
  ],
  templateUrl: "./skill-catalog-page.component.html",
})
export class SkillCatalogPageComponent
{
  /** Skill catalog API service. */
  private readonly _skillCatalogService = inject(SkillCatalogService);

  /** Group API service. */
  private readonly _groupsService = inject(GroupsService);

  /** Resource-backed skill catalog list. */
  private readonly _skillBundlesResource = rxResource({
    stream: this._listSkillBundles.bind(this),
    defaultValue: [],
  });

  /** Resource-backed group list. */
  private readonly _groupsResource = rxResource({
    stream: this._listGroups.bind(this),
    defaultValue: [],
  });

  /** Loaded skill bundles. */
  readonly _skillBundles = computed(this._computeSkillBundles.bind(this));

  /** Loaded groups. */
  readonly _groups = computed(this._computeGroups.bind(this));

  /** Shared selection and preview state for the skill catalog. */
  private readonly _catalogState = createEntitlementCatalogPageState(this._skillBundles);

  /** Combined page loading state. */
  readonly _loading = computed(this._computeLoading.bind(this));

  /** Combined page error state. */
  readonly _error = computed(this._computeError.bind(this));

  /** Skill catalog summary subtitle. */
  readonly _catalogSubtitle = computed(this._computeCatalogSubtitle.bind(this));

  /** Selected bundle details. */
  readonly _selectedBundle = this._catalogState.selectedItem;

  /** Grants for the selected bundle, including local preview edits. */
  readonly _selectedBundleGrants = this._catalogState.selectedItemGrants;

  /** Count of published bundles. */
  readonly _publishedCount = computed(this._computePublishedCount.bind(this));

  /** Count of review bundles. */
  readonly _reviewCount = computed(this._computeReviewCount.bind(this));

  /** Count of draft bundles. */
  readonly _draftCount = computed(this._computeDraftCount.bind(this));

  /** Fetch the current skill bundle list. */
  private _listSkillBundles(): Observable<SkillBundle[]>
  {
    return this._skillCatalogService.listSkillBundles$();
  }

  /** Fetch the current group list. */
  private _listGroups(): Observable<Group[]>
  {
    return this._groupsService.listGroups$();
  }

  /** Return the loaded skill bundle list. */
  private _computeSkillBundles(): SkillBundle[]
  {
    return this._skillBundlesResource.value();
  }

  /** Return the loaded group list. */
  private _computeGroups(): Group[]
  {
    return this._groupsResource.value();
  }

  /** Return whether either resource is still loading. */
  private _computeLoading(): boolean
  {
    return this._skillBundlesResource.isLoading() || this._groupsResource.isLoading();
  }

  /** Return the first resource error, if any. */
  private _computeError(): string | null
  {
    return this._skillBundlesResource.error()?.message ?? this._groupsResource.error()?.message ?? null;
  }

  /** Build the skill catalog subtitle shown in the section header. */
  private _computeCatalogSubtitle(): string
  {
    return `${this._skillBundles().length} bundles • ${this._publishedCount()} published • ${this._reviewCount()} in review • ${this._draftCount()} draft`;
  }

  /** Count bundles in the published state. */
  private _computePublishedCount(): number
  {
    return this._skillBundles().filter(function _isPublished(bundle)
    {
      return bundle.status === SkillBundleStatus.Published;
    }).length;
  }

  /** Count bundles in the review state. */
  private _computeReviewCount(): number
  {
    return this._skillBundles().filter(function _isReview(bundle)
    {
      return bundle.status === SkillBundleStatus.Review;
    }).length;
  }

  /** Count bundles in the draft state. */
  private _computeDraftCount(): number
  {
    return this._skillBundles().filter(function _isDraft(bundle)
    {
      return bundle.status === SkillBundleStatus.Draft;
    }).length;
  }

  /** Select a skill bundle for the entitlement preview section. */
  _selectBundle(bundleId: string): void
  {
    this._catalogState.selectItem(bundleId);
  }

  /** Persist a local preview of the selected bundle grants. */
  _updateSelectedGrants(grants: SkillBundle["grants"]): void
  {
    this._catalogState.updateSelectedGrants(grants);
  }

  /** Reload both the skill catalog and group inventory. */
  _reload(): void
  {
    this._skillBundlesResource.reload();
    this._groupsResource.reload();
  }

  /** Map a group scope to a PrimeNG tag severity. */
  _scopeSeverity(scope: Group["scope"]): "info" | "warn" | "success" | "secondary"
  {
    return getGrantScopeSeverity(scope);
  }
}
