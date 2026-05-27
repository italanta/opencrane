import { DatePipe } from "@angular/common";
import { Component, computed, inject } from "@angular/core";
import { rxResource } from "@angular/core/rxjs-interop";
import type { Observable } from "rxjs";
import { ButtonModule } from "primeng/button";
import { CardModule } from "primeng/card";
import { MessageModule } from "primeng/message";
import { ProgressSpinnerModule } from "primeng/progressspinner";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";

import { ThirdPartySourcesService } from "../../core/api/third-party-sources.service";
import { ThirdPartySourceStatus, type ThirdPartySource } from "../../core/models/third-party-source.model";
import { UiSectionCardComponent } from "../../shared/components/ui-section-card/ui-section-card.component";

/** Central scheduler overview page for source sync orchestration. */
@Component({
  selector: "oc-schedules-page",
  standalone: true,
  imports: [
    DatePipe,
    ButtonModule,
    CardModule,
    MessageModule,
    ProgressSpinnerModule,
    TableModule,
    TagModule,
    UiSectionCardComponent,
  ],
  templateUrl: "./schedules-page.component.html",
})
export class SchedulesPageComponent
{
  /** Third-party source API service. */
  private readonly _thirdPartySourcesService = inject(ThirdPartySourcesService);

  /** Resource-backed source inventory used by the scheduler view. */
  private readonly _sourcesResource = rxResource({
    stream: this._listSources.bind(this),
    defaultValue: [],
  });

  /** Loaded source inventory. */
  readonly _sources = computed(this._computeSources.bind(this));

  /** Page loading state. */
  readonly _loading = computed(this._computeLoading.bind(this));

  /** Page error state. */
  readonly _error = computed(this._computeError.bind(this));

  /** Count of healthy sources. */
  readonly _healthyCount = computed(this._computeHealthyCount.bind(this));

  /** Count of syncing sources. */
  readonly _syncingCount = computed(this._computeSyncingCount.bind(this));

  /** Count of sources currently waiting on approval. */
  readonly _pendingApprovalCount = computed(this._computePendingApprovalCount.bind(this));

  /** Static scheduler notes shown beneath the source table. */
  readonly _schedulerNotes = [
    {
      title: "Central ownership",
      detail: "Schedules live in the control-plane so tenant pod suspension does not stop source refresh or entitlement compilation.",
    },
    {
      title: "Identity-aware dispatch",
      detail: "The final scheduler will dispatch jobs as tenant identity through projected tokens instead of long-lived gateway secrets.",
    },
    {
      title: "Explicit installs",
      detail: "Discovery may sync automatically, but installation remains an explicit admin action after validation and audit checks.",
    },
  ];

  /** Fetch the current third-party source list. */
  private _listSources(): Observable<ThirdPartySource[]>
  {
    return this._thirdPartySourcesService.listThirdPartySources$();
  }

  /** Return the loaded source inventory. */
  private _computeSources(): ThirdPartySource[]
  {
    return this._sourcesResource.value();
  }

  /** Return whether the source inventory is loading. */
  private _computeLoading(): boolean
  {
    return this._sourcesResource.isLoading();
  }

  /** Return the source inventory error message, if any. */
  private _computeError(): string | null
  {
    return this._sourcesResource.error()?.message ?? null;
  }

  /** Count sources in the healthy state. */
  private _computeHealthyCount(): number
  {
    return this._sources().filter(function _isHealthy(source)
    {
      return source.status === ThirdPartySourceStatus.Healthy;
    }).length;
  }

  /** Count sources in the syncing state. */
  private _computeSyncingCount(): number
  {
    return this._sources().filter(function _isSyncing(source)
    {
      return source.status === ThirdPartySourceStatus.Syncing;
    }).length;
  }

  /** Count sources still waiting on approval. */
  private _computePendingApprovalCount(): number
  {
    return this._sources().filter(function _isPending(source)
    {
      return source.status === ThirdPartySourceStatus.PendingApproval;
    }).length;
  }

  /** Reload the scheduler source inventory. */
  _reload(): void
  {
    this._sourcesResource.reload();
  }

  /** Map source status to a PrimeNG tag severity. */
  _statusSeverity(status: ThirdPartySourceStatus): "success" | "info" | "warn" | "danger"
  {
    switch (status)
    {
      case ThirdPartySourceStatus.Healthy:
        return "success";
      case ThirdPartySourceStatus.Syncing:
        return "info";
      case ThirdPartySourceStatus.PendingApproval:
        return "warn";
      default:
        return "danger";
    }
  }
}
