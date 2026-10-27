// Types for schema.js (so the TS server and its tests can import it).

export type FieldSpec =
  | string
  | { $array: FieldSpec }
  | { [field: string]: FieldSpec };

export interface EventShape {
  /** NATS subject pattern ('*' = one token), or 'sse' for sseController-originated events. */
  subject: string;
  required: Record<string, FieldSpec>;
  optional?: Record<string, FieldSpec>;
}

export interface EventDef {
  shapes: EventShape[];
  /** Client files whose useEventStream handler map has this key. */
  handledBy: string[];
}

export declare const SSE_SUBJECTS: string[];
export declare const INTERNAL_SUBJECTS: string[];
export declare const SSE_EVENTS: Record<string, EventDef>;
export declare const KNOWN_VIOLATIONS: Record<string, string>;

export declare function subjectMatches(pattern: string, subject: string): boolean;
export declare function isSseSubject(subject: string): boolean;
export declare function isInternalSubject(subject: string): boolean;
export declare function validateEvent(event: Record<string, unknown>, subject?: string): string[];
export declare function sampleEvent(
  type: string,
  overrides?: Record<string, unknown>,
  shapeIndex?: number,
): Record<string, unknown>;
