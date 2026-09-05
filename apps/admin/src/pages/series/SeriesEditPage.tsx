import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type Resolver, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, ChevronDown, ChevronRight, ImageOff, Plus, Trash2 } from 'lucide-react';
import type { AssetDto, SeasonDto, SeriesCreateInput, SupportedLocale } from '@streaming/shared';
import { SeriesCreateInput as SeriesCreateSchema, SUPPORTED_LOCALES } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import {
  createSeason,
  createSeries,
  deleteSeason,
  getSeries,
  listEpisodes,
  updateSeries,
} from '../../lib/seriesApi';
import AssetPickerModal from '../../components/AssetPickerModal';
import LocalizedTabs, { LOCALE_DIRECTION } from '../../components/LocalizedTabs';
import Modal from '../../components/Modal';
import PublishActions from '../../components/PublishActions';
import StatusBadge from '../../components/StatusBadge';

type FormValues = SeriesCreateInput;

const EMPTY_FORM: FormValues = {
  title_i18n: { en: '', ckb: '', ar: '' },
  overview_i18n: { en: '', ckb: '', ar: '' },
  poster_asset_id: null,
  backdrop_asset_id: null,
};

const INPUT_CLASS =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500';

const LABEL_CLASS = 'mb-1 block text-xs font-medium text-slate-400';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
      {description && <p className="mt-0.5 mb-4 text-xs text-slate-400">{description}</p>}
      <div className={description ? '' : 'mt-4'}>{children}</div>
    </section>
  );
}

/** Poster / backdrop picker with a preview and a clear button. */
function ArtworkPicker({
  label,
  kind,
  asset,
  onChange,
}: {
  label: string;
  kind: 'POSTER' | 'BACKDROP';
  asset: AssetDto | null;
  onChange: (asset: AssetDto | null) => void;
}) {
  const [isOpen, setOpen] = useState(false);

  return (
    <div>
      <span className={LABEL_CLASS}>{label}</span>

      {asset ? (
        <div className="space-y-2">
          <img
            src={asset.url}
            alt=""
            className={`w-full rounded-md border border-slate-800 object-cover ${
              kind === 'POSTER' ? 'aspect-2/3 max-w-40' : 'aspect-video max-w-full'
            }`}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-rose-300 transition hover:bg-slate-800"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-slate-700 text-slate-500 transition hover:border-slate-500 hover:text-slate-300 ${
            kind === 'POSTER' ? 'aspect-2/3 w-40' : 'aspect-video w-full max-w-md'
          }`}
        >
          <ImageOff size={20} aria-hidden />
          <span className="text-xs">Choose {label.toLowerCase()}</span>
        </button>
      )}

      <AssetPickerModal
        open={isOpen}
        kind={kind}
        onSelect={onChange}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

/**
 * One collapsible season row.
 *
 * The episode list is fetched only once the row is expanded — a series with
 * twelve seasons would otherwise fire twelve requests on mount to populate
 * tables nobody has looked at.
 */
function SeasonRow({
  seriesId,
  season,
  canEdit,
  onRequestDelete,
}: {
  seriesId: string;
  season: SeasonDto;
  canEdit: boolean;
  onRequestDelete: (season: SeasonDto) => void;
}) {
  const navigate = useNavigate();
  const [isOpen, setOpen] = useState(false);

  const episodesQuery = useQuery({
    queryKey: ['admin', 'series', seriesId, 'seasons', season.id, 'episodes'],
    queryFn: () => listEpisodes(seriesId, season.id),
    enabled: isOpen,
  });

  const episodes = episodesQuery.data ?? [];

  return (
    <div className="rounded-lg border border-slate-800">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((open) => !open)}
          aria-expanded={isOpen}
          className="flex flex-1 items-center gap-2 text-left text-sm text-slate-100"
        >
          {isOpen ? (
            <ChevronDown size={15} aria-hidden className="text-slate-400" />
          ) : (
            <ChevronRight size={15} aria-hidden className="text-slate-400" />
          )}
          <span className="font-medium">Season {season.number}</span>
          <span className="text-xs text-slate-500">
            {season.episodeCount} {season.episodeCount === 1 ? 'episode' : 'episodes'}
          </span>
        </button>

        {canEdit && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => navigate(`/series/${seriesId}/seasons/${season.id}/episodes/new`)}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
            >
              <Plus size={13} aria-hidden />
              Add episode
            </button>
            {/*
              Disabled up front when the season holds published episodes: the
              server refuses this with a 409 either way, but a button that
              cannot succeed should say so before it is clicked.
            */}
            <button
              type="button"
              aria-label={`Delete season ${season.number}`}
              disabled={season.publishedEpisodeCount > 0}
              title={
                season.publishedEpisodeCount > 0
                  ? 'Unpublish this season’s episodes before deleting it'
                  : undefined
              }
              onClick={() => onRequestDelete(season)}
              className="rounded-md border border-slate-700 p-1.5 text-rose-300 transition hover:bg-slate-800 disabled:opacity-30"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        )}
      </div>

      {isOpen && (
        <div className="border-t border-slate-800 px-4 py-3">
          {episodesQuery.isPending && <p className="text-xs text-slate-400">Loading episodes…</p>}

          {episodesQuery.isError && (
            <p className="text-xs text-rose-300">Could not load episodes.</p>
          )}

          {episodesQuery.isSuccess && episodes.length === 0 && (
            <p className="text-xs text-slate-400">No episodes in this season yet.</p>
          )}

          {episodes.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">#</th>
                  <th className="py-1.5 font-medium">Title</th>
                  <th className="py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {episodes.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() =>
                      navigate(`/series/${seriesId}/seasons/${season.id}/episodes/${item.id}`)
                    }
                    className="cursor-pointer text-slate-300 transition hover:text-slate-100"
                  >
                    <td className="py-2 pr-3 text-slate-500">{item.number}</td>
                    <td className="py-2 pr-3">{item.titleI18n.en}</td>
                    <td className="py-2">
                      <StatusBadge status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function SeriesEditPage() {
  const { seriesId } = useParams<{ seriesId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();

  const isCreate = seriesId === undefined;
  const canEdit = isAdmin();

  const [poster, setPoster] = useState<AssetDto | null>(null);
  const [backdrop, setBackdrop] = useState<AssetDto | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [seasonNumber, setSeasonNumber] = useState('');
  const [seasonError, setSeasonError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SeasonDto | null>(null);

  const seriesQuery = useQuery({
    queryKey: ['admin', 'series', seriesId],
    queryFn: () => getSeries(seriesId!),
    enabled: !isCreate,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(SeriesCreateSchema) as Resolver<FormValues>,
    defaultValues: EMPTY_FORM,
  });

  // Seed the form once the series arrives. Artwork is held outside the form
  // because it is picked through a modal, not typed.
  const series = seriesQuery.data;
  useEffect(() => {
    if (!series) return;

    reset({
      title_i18n: series.titleI18n,
      overview_i18n: series.overviewI18n,
      poster_asset_id: series.poster?.id ?? null,
      backdrop_asset_id: series.backdrop?.id ?? null,
    });

    setPoster(series.poster);
    setBackdrop(series.backdrop);
  }, [series, reset]);

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: SeriesCreateInput = {
        ...values,
        poster_asset_id: poster?.id ?? null,
        backdrop_asset_id: backdrop?.id ?? null,
      };

      return isCreate ? createSeries(payload) : updateSeries(seriesId!, payload);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'series'] });
      // Land on the saved series so the seasons section becomes usable straight
      // after a create.
      navigate(`/series/${saved.id}`, { replace: true });
    },
    onError: (cause) => {
      setSaveError(cause instanceof ApiError ? cause.message : 'Could not save this series.');
    },
  });

  const addSeasonMutation = useMutation({
    mutationFn: (number: number) => createSeason(seriesId!, number),
    onSuccess: () => {
      setSeasonNumber('');
      setSeasonError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'series', seriesId] });
    },
    onError: (cause) => {
      setSeasonError(cause instanceof ApiError ? cause.message : 'Could not add that season.');
    },
  });

  const deleteSeasonMutation = useMutation({
    mutationFn: (seasonId: string) => deleteSeason(seriesId!, seasonId),
    onSuccess: () => {
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'series', seriesId] });
    },
    onError: (cause) => {
      setPendingDelete(null);
      setSeasonError(cause instanceof ApiError ? cause.message : 'Could not delete that season.');
    },
  });

  const onSubmit: SubmitHandler<FormValues> = (values) => {
    setSaveError(null);
    saveMutation.mutate(values);
  };

  /** Locales with a validation error, for the tab markers. */
  const invalidLocales = SUPPORTED_LOCALES.filter(
    (locale) => errors.title_i18n?.[locale] || errors.overview_i18n?.[locale],
  );

  const seasons = series?.seasons ?? [];

  /** Suggests the next unused number so the common case is one click. */
  const nextSeasonNumber =
    seasons.length === 0 ? 1 : Math.max(...seasons.map((item) => item.number)) + 1;

  if (!isCreate && seriesQuery.isPending) {
    return <p className="p-6 text-sm text-slate-400">Loading…</p>;
  }

  if (!isCreate && seriesQuery.isError) {
    return <p className="p-6 text-sm text-rose-300">Could not load this series.</p>;
  }

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={() => navigate('/series')}
        className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to series
      </button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            {isCreate ? 'New series' : (series?.titleI18n.en ?? 'Series')}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Metadata is required in English, Kurdish Sorani and Arabic.
          </p>
        </div>
      </header>

      {/*
        Publishing the series shell is independent of its episodes — each of
        those is published from its own page.
      */}
      {!isCreate && series && (
        <PublishActions
          contentType="series"
          id={series.id}
          currentStatus={series.status}
          onStatusChange={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin', 'series'] });
          }}
        />
      )}

      {saveError && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {saveError}
        </p>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <Section title="Metadata">
          <LocalizedTabs invalidLocales={invalidLocales}>
            {(locale: SupportedLocale) => (
              <div className="space-y-4">
                <div>
                  <label htmlFor={`series-title-${locale}`} className={LABEL_CLASS}>
                    Title
                  </label>
                  <input
                    id={`series-title-${locale}`}
                    type="text"
                    dir={LOCALE_DIRECTION[locale]}
                    disabled={!canEdit}
                    className={INPUT_CLASS}
                    {...register(`title_i18n.${locale}`)}
                  />
                  {errors.title_i18n?.[locale] && (
                    <p className="mt-1 text-xs text-rose-300">
                      {errors.title_i18n[locale]?.message}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor={`series-overview-${locale}`} className={LABEL_CLASS}>
                    Overview
                  </label>
                  <textarea
                    id={`series-overview-${locale}`}
                    rows={4}
                    dir={LOCALE_DIRECTION[locale]}
                    disabled={!canEdit}
                    className={INPUT_CLASS}
                    {...register(`overview_i18n.${locale}`)}
                  />
                  {errors.overview_i18n?.[locale] && (
                    <p className="mt-1 text-xs text-rose-300">
                      {errors.overview_i18n[locale]?.message}
                    </p>
                  )}
                </div>
              </div>
            )}
          </LocalizedTabs>
        </Section>

        <Section title="Artwork" description="Posters are portrait; backdrops are landscape.">
          <div className="grid gap-6 sm:grid-cols-2">
            <ArtworkPicker label="Poster" kind="POSTER" asset={poster} onChange={setPoster} />
            <ArtworkPicker
              label="Backdrop"
              kind="BACKDROP"
              asset={backdrop}
              onChange={setBackdrop}
            />
          </div>
        </Section>

        {canEdit && (
          <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-5 py-4">
            <p className="text-xs text-slate-400">
              Saving edits metadata only — it never changes the publish status.
            </p>
            <button
              type="submit"
              disabled={isSubmitting || saveMutation.isPending}
              className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-40"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </form>

      {/*
        Seasons hang off a series id, so they cannot exist before the series
        does. On create they appear after the first save.
      */}
      {isCreate ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-800 px-5 py-4 text-sm text-slate-400">
          Save this series first to add seasons and episodes.
        </p>
      ) : (
        <div className="mt-5">
          <Section
            title="Seasons"
            description="Expand a season to see its episodes. Season numbers are unique within a series."
          >
            {seasonError && (
              <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {seasonError}
              </p>
            )}

            <div className="space-y-2">
              {seasons.length === 0 && (
                <p className="text-sm text-slate-400">No seasons yet.</p>
              )}

              {seasons.map((season) => (
                <SeasonRow
                  key={season.id}
                  seriesId={seriesId!}
                  season={season}
                  canEdit={canEdit}
                  onRequestDelete={setPendingDelete}
                />
              ))}
            </div>

            {canEdit && (
              <form
                className="mt-4 flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const parsed = Number(seasonNumber);
                  if (!Number.isInteger(parsed)) return;
                  addSeasonMutation.mutate(parsed);
                }}
              >
                <div>
                  <label htmlFor="new-season-number" className={LABEL_CLASS}>
                    Season number
                  </label>
                  <input
                    id="new-season-number"
                    type="number"
                    min={0}
                    max={1000}
                    value={seasonNumber}
                    placeholder={String(nextSeasonNumber)}
                    onChange={(event) => setSeasonNumber(event.target.value)}
                    className="w-32 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={seasonNumber.trim() === '' || addSeasonMutation.isPending}
                  className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
                >
                  <Plus size={14} aria-hidden />
                  {addSeasonMutation.isPending ? 'Adding…' : 'Add season'}
                </button>
              </form>
            )}
          </Section>
        </div>
      )}

      <Modal
        open={pendingDelete !== null}
        title="Delete season"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleteSeasonMutation.isPending}
              onClick={() => pendingDelete && deleteSeasonMutation.mutate(pendingDelete.id)}
              className="rounded-md bg-rose-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-rose-400 disabled:opacity-40"
            >
              {deleteSeasonMutation.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          Delete <span className="font-medium text-slate-100">Season {pendingDelete?.number}</span>{' '}
          and its {pendingDelete?.episodeCount}{' '}
          {pendingDelete?.episodeCount === 1 ? 'episode' : 'episodes'}? Their stream sources and
          subtitle tracks go too. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
