/**
 * A converter from a document format a portal exports into a FHIR R4 bundle (yourphr#735).
 *
 * ngdpbase's shape, as its ImportManager has it (`src/converters/IContentConverter.ts`): a format
 * id and name, `canHandle` for detection, `convert` for the work. The Sources door keeps the list
 * and asks each one about an upload; the first that says yes converts it, and what comes back is
 * imported like any FHIR file. One converter exists today (C-CDA); PDF-as-DocumentReference
 * (Go's #255) is the obvious second.
 *
 * `status` is this product's addition, and the lesson of yourphr#397: a converter that depends on
 * something running elsewhere must be able to say, before anyone uploads, whether it will work —
 * and if not, exactly what the operator has to do.
 */
export interface ConverterStatus {
  /** The operator has not turned it off. */
  enabled: boolean;
  /** An upload would actually be converted: enabled AND fully configured. */
  ready: boolean;
  /** Operator-facing steps, shown verbatim when not ready. Never carries an address. */
  setup_hint: string;
}

export abstract class BaseDocumentConverterProvider {
  /** Stable id, e.g. 'ccda'. */
  abstract readonly formatId: string;
  /** Human name, e.g. 'C-CDA'. */
  abstract readonly formatName: string;
  /** Whether this converter is the one for these bytes. Must be cheap: it runs on every upload. */
  abstract canHandle(bytes: Buffer, filename: string): boolean;
  abstract status(): ConverterStatus;
  /** The document as FHIR R4 Bundle JSON. Throws with operator-actionable text when it cannot. */
  abstract convert(bytes: Buffer): Promise<Buffer>;
}
