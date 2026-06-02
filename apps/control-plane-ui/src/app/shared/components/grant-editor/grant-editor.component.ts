import { Component, input, output, signal } from "@angular/core";
import { ButtonModule } from "primeng/button";
import { InputTextModule } from "primeng/inputtext";
import { MessageModule } from "primeng/message";
import { TagModule } from "primeng/tag";

import { GrantAccess, GrantScope, GrantSubjectType, type Grant } from "../../../core/models/grant.model";
import { _CreateGrantId, _ReadInputValue, _ReadSelectValue } from "./grant-editor.utils";

/** Supported principal types exposed in the reusable grant editor. */
const _GRANT_SUBJECT_TYPES: GrantSubjectType[] = [GrantSubjectType.Group, GrantSubjectType.Tenant, GrantSubjectType.User];

/** Supported scopes exposed in the reusable grant editor. */
const _GRANT_SCOPES: GrantScope[] = [GrantScope.Org, GrantScope.Department, GrantScope.Project, GrantScope.Personal];

/** Supported access decisions exposed in the reusable grant editor. */
const _GRANT_ACCESS_OPTIONS: GrantAccess[] = [GrantAccess.Allow, GrantAccess.Deny];

/** Reusable editor for entitlement grant previews. */
@Component({
  selector: "oc-grant-editor",
  standalone: true,
  imports: [ButtonModule, InputTextModule, MessageModule, TagModule],
  templateUrl: "./grant-editor.component.html",
})
export class GrantEditorComponent
{
  /** Optional card-level title rendered above the editor. */
  readonly title = input("Entitlement grants");

  /** Current grants shown in the editor. */
  readonly grants = input.required<Grant[]>();

  /** Disable editor interactions when the parent page cannot accept changes. */
  readonly disabled = input(false);

  /** Inline message rendered when no grants are present. */
  readonly emptyMessage = input("No grants configured yet.");

  /** Emits the updated grant list after add/remove actions. */
  readonly grantsChange = output<Grant[]>();

  /** Draft subject type for the next grant row. */
  readonly _draftSubjectType = signal<GrantSubjectType>(GrantSubjectType.Group);

  /** Draft subject name for the next grant row. */
  readonly _draftSubjectName = signal("");

  /** Draft scope for the next grant row. */
  readonly _draftScope = signal(GrantScope.Org);

  /** Draft access decision for the next grant row. */
  readonly _draftAccess = signal(GrantAccess.Allow);

  /** Draft operator note for the next grant row. */
  readonly _draftNote = signal("");

  /** Subject types rendered in the native select input. */
  readonly _subjectTypes = _GRANT_SUBJECT_TYPES;

  /** Scope options rendered in the native select input. */
  readonly _scopes = _GRANT_SCOPES;

  /** Access options rendered in the native select input. */
  readonly _accessOptions = _GRANT_ACCESS_OPTIONS;

  /** Update the draft subject type from the select input. */
  _onSubjectTypeChange(event: Event): void
  {
    this._draftSubjectType.set(_ReadSelectValue(event) as GrantSubjectType);
  }

  /** Update the draft scope from the select input. */
  _onScopeChange(event: Event): void
  {
    this._draftScope.set(_ReadSelectValue(event) as GrantScope);
  }

  /** Update the draft access decision from the select input. */
  _onAccessChange(event: Event): void
  {
    this._draftAccess.set(_ReadSelectValue(event) as GrantAccess);
  }

  /** Update the draft subject name from the text input. */
  _onSubjectNameInput(event: Event): void
  {
    this._draftSubjectName.set(_ReadInputValue(event));
  }

  /** Update the draft note from the text input. */
  _onNoteInput(event: Event): void
  {
    this._draftNote.set(_ReadInputValue(event));
  }

  /** Return whether the current draft contains enough data to add a new grant. */
  _canAddGrant(): boolean
  {
    return this._draftSubjectName().trim().length > 0;
  }

  /** Add the current draft grant and emit the updated grant list. */
  _addGrant(): void
  {
    // 1. Validate the draft first so the editor never emits an incomplete permission row.
    const subjectName = this._draftSubjectName().trim();
    if (!subjectName)
    {
      return;
    }

    // 2. Build the grant payload locally because backend CRUD routes are not part of this UI-only slice.
    const grant: Grant = {
      id: _CreateGrantId(this._draftSubjectType(), subjectName, this._draftScope(), this._draftAccess()),
      scope: this._draftScope(),
      subjectType: this._draftSubjectType(),
      subjectId: subjectName,
      subjectName,
      access: this._draftAccess(),
      note: this._draftNote().trim() || undefined,
    };

    // 3. Emit the updated list and reset the draft so operators can queue another preview edit quickly.
    this.grantsChange.emit([...this.grants(), grant]);
    this._resetDraft();
  }

  /** Remove a grant from the preview list and emit the updated array. */
  _removeGrant(grantId: string): void
  {
    this.grantsChange.emit(this.grants().filter(function _keepGrant(grant)
    {
      return grant.id !== grantId;
    }));
  }

  /** Reset the local draft row after a successful add. */
  private _resetDraft(): void
  {
    this._draftSubjectName.set("");
    this._draftNote.set("");
    this._draftScope.set(GrantScope.Org);
    this._draftAccess.set(GrantAccess.Allow);
    this._draftSubjectType.set(GrantSubjectType.Group);
  }

  /** Map an access decision to a PrimeNG tag severity. */
  _accessSeverity(access: GrantAccess): "success" | "danger"
  {
    return access === GrantAccess.Allow ? "success" : "danger";
  }
}
