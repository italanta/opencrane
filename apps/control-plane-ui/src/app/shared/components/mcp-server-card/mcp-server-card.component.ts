import { DatePipe } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { ButtonModule } from "primeng/button";
import { CardModule } from "primeng/card";
import { TagModule } from "primeng/tag";

import { McpServerStatus, type McpServer } from "../../../core/models/mcp-server.model";

/** Reusable summary card for MCP server entries. */
@Component({
  selector: "oc-mcp-server-card",
  standalone: true,
  imports: [DatePipe, ButtonModule, CardModule, TagModule],
  templateUrl: "./mcp-server-card.component.html",
})
export class McpServerCardComponent
{
  /** MCP server metadata to render. */
  @Input({ required: true }) server!: McpServer;

  /** Whether the parent page currently highlights this server. */
  @Input() selected = false;

  /** Emits when the operator wants to inspect server grants. */
  @Output() select = new EventEmitter<void>();

  /** Emit a selection event for the parent container. */
  _select(): void
  {
    this.select.emit();
  }

  /** Map server status to a PrimeNG tag severity. */
  _statusSeverity(status: McpServerStatus): "success" | "warn" | "info"
  {
    switch (status)
    {
      case McpServerStatus.Active:
        return "success";
      case McpServerStatus.Degraded:
        return "warn";
      default:
        return "info";
    }
  }
}
