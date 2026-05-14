/** Minimal projection row shape needed to compute lag from `updatedAt`. */
export interface ProjectionTimestampRow
{
  /** Logical resource name shared with the drift report. */
  name: string;

  /** Last time the projection row was written. */
  updatedAt: Date;
}