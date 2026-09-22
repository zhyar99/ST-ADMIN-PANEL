import type {
  ImportEntryStatus,
  ImportJobStatus,
  ImportMappedType,
  MediaAssetKind,
  PublicationStatus,
  StreamSourceKind,
  StreamSourceOwnerType,
  StreamTestResult,
  SubtitleLanguage,
} from './enums.js';
import type { LocalizedText, PartialLocalizedText } from './schemas/i18n.js';

/**
 * The only shape in which a `media_asset` row leaves the API.
 *
 * `file_path` is deliberately absent: callers get a `url` built from
 * STORAGE_URL_PREFIX and never learn where the file sits on disk. Content
 * routes in later phases embed this same type rather than re-deriving it, so
 * every asset the Admin SPA sees looks identical.
 */
export interface AssetDto {
  id: string;
  kind: MediaAssetKind;
  /** Human-readable upload name shown in the admin media library and pickers. */
  name: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  /** Images only — absent for subtitles and non-image ad creatives. */
  width?: number;
  height?: number;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

export interface GenreDto {
  id: string;
  nameI18n: LocalizedText;
}

/**
 * Genre plus its usage count. The admin list needs the count to disable the
 * delete button, and computing it per row in the UI would be N+1 requests.
 */
export interface GenreListItemDto extends GenreDto {
  movieCount: number;
}

/**
 * A stream source as the API describes it.
 *
 * `url` is structurally absent, not merely omitted at runtime: the column is
 * plain text and must never ride along in a list or detail payload. The only
 * way to read it is GET .../sources/:id/url, which is ADMIN-only and audited.
 */
export interface StreamSourceDto {
  id: string;
  priority: number;
  /**
   * Whether the URL is a media file or a third-party player page. Safe to
   * expose where the URL is not: it says how to play the source, not where it
   * lives, and the admin list needs it to label each row.
   */
  kind: StreamSourceKind;
  lastTestedAt: string | null;
  lastTestResult: StreamTestResult | null;
  createdAt: string;
}

/**
 * One recorded outcome of a manual "Test Source" check.
 *
 * Like {@link StreamSourceDto}, this has no `url` field: history is readable by
 * anyone who can see the source list, and the URL stays behind the audited
 * reveal endpoint. `errorMessage` is a short, URL-free reason ("HTTP 404").
 */
export interface StreamHealthCheckDto {
  id: string;
  result: StreamTestResult;
  /** Round-trip time of the probe, or null when the request never completed. */
  latencyMs: number | null;
  errorMessage: string | null;
  checkedAt: string;
}

export interface SubtitleTrackDto {
  id: string;
  language: SubtitleLanguage;
  /** Set when the track comes from the media library. */
  asset: AssetDto | null;
  /** Set when the track is hosted elsewhere. Mutually exclusive with `asset`. */
  externalUrl: string | null;
}

/** Row shape for the admin movies table — deliberately thin. */
export interface MovieListItemDto {
  id: string;
  titleI18n: LocalizedText;
  status: PublicationStatus;
  releaseYear: number | null;
  createdAt: string;
}

export interface MovieDetailDto {
  id: string;
  titleI18n: LocalizedText;
  overviewI18n: LocalizedText;
  taglineI18n: PartialLocalizedText | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  poster: AssetDto | null;
  backdrop: AssetDto | null;
  genres: GenreDto[];
  status: PublicationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Row shape for the admin series table.
 *
 * `seasonCount` is aggregated server-side for the same reason `GenreListItemDto`
 * carries `movieCount`: the list would otherwise fire one request per row just
 * to render a number.
 */
export interface SeriesListItemDto {
  id: string;
  titleI18n: LocalizedText;
  status: PublicationStatus;
  seasonCount: number;
  createdAt: string;
}

/**
 * A season as it appears inside a series detail response.
 *
 * A season is only a numbered container — it has no copy of its own — so it has
 * no detail endpoint. `episodeCount` lets the edit page label a collapsed
 * season without expanding it, and `publishedEpisodeCount` lets it disable the
 * delete button up front rather than surfacing the server's 409 after a click.
 */
export interface SeasonDto {
  id: string;
  number: number;
  episodeCount: number;
  publishedEpisodeCount: number;
}

export interface SeriesDetailDto {
  id: string;
  titleI18n: LocalizedText;
  overviewI18n: LocalizedText;
  poster: AssetDto | null;
  backdrop: AssetDto | null;
  /** Ascending by season number. */
  seasons: SeasonDto[];
  status: PublicationStatus;
  createdAt: string;
  updatedAt: string;
}

/** Row shape for the episode table inside an expanded season. */
export interface EpisodeListItemDto {
  id: string;
  number: number;
  titleI18n: LocalizedText;
  status: PublicationStatus;
  createdAt: string;
}

/**
 * Row shape for the admin live channel table.
 *
 * Carries `logo` and `sourceCount` for the same reason `SeriesListItemDto`
 * carries `seasonCount`: the list renders both per row, and deriving them
 * client-side would mean one request per channel.
 */
export interface LiveChannelListItemDto {
  id: string;
  nameI18n: LocalizedText;
  category: string;
  logo: AssetDto | null;
  status: PublicationStatus;
  sourceCount: number;
  createdAt: string;
}

/**
 * A live channel in full.
 *
 * Flatter than a movie: no overview, no genres, and no subtitle tracks — a
 * linear feed carries its own captions if it carries any. Stream sources are a
 * separate ADMIN-only sub-resource, so they are deliberately absent here too.
 */
export interface LiveChannelDetailDto {
  id: string;
  nameI18n: LocalizedText;
  category: string;
  logo: AssetDto | null;
  status: PublicationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Carries `seriesId` alongside `seasonId` because the episode edit page is
 * reached by a URL that names both, and the breadcrumb back to the series
 * would otherwise need a second request to resolve.
 */
export interface EpisodeDetailDto {
  id: string;
  seriesId: string;
  seasonId: string;
  seasonNumber: number;
  number: number;
  titleI18n: LocalizedText;
  /** Optional for an episode, unlike a movie's. */
  overviewI18n: LocalizedText | null;
  thumbnail: AssetDto | null;
  status: PublicationStatus;
  createdAt: string;
  updatedAt: string;
}

// --- Advertising (Phase 11) ------------------------------------------------

/**
 * The single global ad timing rule, as the Admin SPA edits it.
 *
 * There is no `id` here on purpose. The endpoint is `/admin/advertising/config`
 * — one resource, not a collection — and exposing the row's uuid would invite
 * a `PUT /config/:id` that cannot mean anything, since a second config is a
 * state the database refuses to hold.
 */
export interface AdConfigDto {
  preRollMinSeconds: number;
  preRollMaxSeconds: number;
  midRollIntervalMinutes: number;
  midRollMaxSeconds: number;
  skipAfterSeconds: number;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/**
 * A partial update. Every field is optional so the form can send only what
 * changed, but `preRollMaxSeconds >= preRollMinSeconds` is checked against the
 * *merged* result server-side — a patch that lowers only the max below the
 * stored min is rejected just as a full one would be.
 */
export type AdConfigUpdateInput = Partial<Omit<AdConfigDto, 'updatedAt'>>;

/**
 * One creative in the pool.
 *
 * Embeds the whole `AssetDto` rather than an `assetId`, for the same reason
 * `MovieDetailDto` embeds its poster: the table renders a thumbnail and a mime
 * type, and a bare id would mean one request per row to draw the list.
 */
export interface AdCreativeDto {
  id: string;
  asset: AssetDto;
  durationSeconds: number;
  isActive: boolean;
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface AdCreativeCreateInput {
  assetId: string;
  durationSeconds: number;
}

export interface AdCreativeUpdateInput {
  durationSeconds?: number;
  isActive?: boolean;
}

/**
 * One bulk playlist upload (Phase 14).
 *
 * The counts are stored on the job rather than derived on every read: the list
 * page renders them for every row, and a per-row aggregate over `import_entry`
 * would be one query per job for a table that can hold hundreds of thousands
 * of rows.
 */
export interface ImportJobDto {
  id: string;
  filename: string;
  status: ImportJobStatus;
  totalEntries: number;
  approvedCount: number;
  rejectedCount: number;
  /** Short, URL-free reason. Set only when `status` is FAILED. */
  errorMessage: string | null;
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * A job plus live per-status tallies.
 *
 * Only the detail endpoint pays for these — they are a `GROUP BY` over the
 * job's entries, which is one query for one job rather than one per row.
 */
export interface ImportJobDetailDto extends ImportJobDto {
  entryCounts: Record<ImportEntryStatus, number>;
}

/**
 * A single staged playlist line.
 *
 * `rawUrl` is optional in the *type*, not merely at runtime: it holds the same
 * kind of secret as `stream_source.url`, and the entry list is readable by a
 * VIEWER, so the field is present only in ADMIN responses. Anything consuming
 * this DTO therefore has to handle its absence.
 */
export interface ImportEntryDto {
  id: string;
  lineNumber: number;
  rawName: string | null;
  /** ADMIN responses only — absent for a VIEWER. */
  rawUrl?: string;
  rawLogo: string | null;
  rawGroup: string | null;
  rawTvgId: string | null;
  mappedType: ImportMappedType;
  /** The catalogue row this entry became, once approved. */
  mappedId: string | null;
  status: ImportEntryStatus;
  /** The `stream_source` whose URL this entry repeats. */
  duplicateOf: string | null;
  /**
   * Who owns {@link duplicateOf}, so the reviewer can open the existing item.
   * Null when the repeat is inside this same playlist file.
   */
  duplicateOwner: { type: StreamSourceOwnerType; id: string } | null;
  adminNote: string | null;
}

/** A catalogue item an entry can be linked to instead of creating a stub. */
export interface ImportLinkTargetDto {
  id: string;
  type: 'LIVE_CHANNEL' | 'MOVIE';
  name: string;
  status: PublicationStatus;
  /** Sources already attached, so the reviewer can see they are appending. */
  sourceCount: number;
}
