import { Component, EventEmitter, Input, Output } from "@angular/core";
import { ButtonModule } from "primeng/button";
import { CardModule } from "primeng/card";
import { TagModule } from "primeng/tag";

import { SkillBundleStatus, type SkillBundle } from "../../../core/models/skill-bundle.model";

/** Reusable summary card for skill catalog entries. */
@Component({
  selector: "oc-skill-card",
  standalone: true,
  imports: [ButtonModule, CardModule, TagModule],
  templateUrl: "./skill-card.component.html",
})
export class SkillCardComponent
{
  /** Skill bundle metadata to render. */
  @Input({ required: true }) bundle!: SkillBundle;

  /** Whether the parent page currently highlights this bundle. */
  @Input() selected = false;

  /** Emits when the operator wants to inspect bundle grants. */
  @Output() select = new EventEmitter<void>();

  /** Emit a selection event for the parent container. */
  _select(): void
  {
    this.select.emit();
  }

  /** Map bundle status to a PrimeNG tag severity. */
  _statusSeverity(status: SkillBundleStatus): "success" | "info" | "warn"
  {
    switch (status)
    {
      case SkillBundleStatus.Published:
        return "success";
      case SkillBundleStatus.Review:
        return "warn";
      default:
        return "info";
    }
  }

  /** Shorten long OCI digests for compact card rendering. */
  _shortDigest(digest: string): string
  {
    if (digest.length <= 24)
    {
      return digest;
    }

    return `${digest.slice(0, 14)}…${digest.slice(-8)}`;
  }
}
