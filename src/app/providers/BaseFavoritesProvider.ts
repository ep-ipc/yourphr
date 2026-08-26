/**
 * Favourites storage (yourphr#616): the practitioners a person starred — Go's non-FHIR `favorites`
 * table keyed (owner, source, type, id). An annotation on a record, kept beside the records and
 * reached through the Records door; the provider stores, the manager decides what may be starred.
 */
export interface Favorite {
  source_id: string;
  resource_type: string;
  resource_id: string;
}

export abstract class BaseFavoritesProvider {
  abstract initialize(): Promise<void>;
  abstract list(owner: string, resourceType: string): Promise<Favorite[]>;
  /** Idempotent: starring twice is one star. */
  abstract add(owner: string, fav: Favorite, at: Date): Promise<void>;
  abstract remove(owner: string, fav: Favorite): Promise<boolean>;
  abstract removeAll(owner: string): Promise<number>;
}
