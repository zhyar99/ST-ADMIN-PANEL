import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type Resolver, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Check, ImageOff, Plus, X } from 'lucide-react';
import type { AssetDto, GenreDto, MovieCreateInput, SupportedLocale } from '@streaming/shared';
import { MovieCreateInput as MovieCreateSchema, SUPPORTED_LOCALES } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { createMovie, getMovie, listGenres, updateMovie } from '../../lib/catalogApi';
import AssetPickerModal from '../../components/AssetPickerModal';
import LocalizedTabs, { LOCALE_DIRECTION } from '../../components/LocalizedTabs';
import PublishActions from '../../components/PublishActions';
import StreamSourcesSection from './StreamSourcesSection';
import SubtitlesSection from './SubtitlesSection';

type FormValues = MovieCreateInput;

const EMPTY_FORM: FormValues = {
  title_i18n: { en: '', ckb: '', ar: '' },
  overview_i18n: { en: '', ckb: '', ar: '' },
  tagline_i18n: null,
  release_year: null,
  runtime_minutes: null,
  poster_asset_id: null,
  backdrop_asset_id: null,
  genre_ids: [],
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

export default function MovieEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();

  const isCreate = id === undefined;
  const canEdit = isAdmin();

  const [poster, setPoster] = useState<AssetDto | null>(null);
  const [backdrop, setBackdrop] = useState<AssetDto | null>(null);
  const [selectedGenres, setSelectedGenres] = useState<GenreDto[]>([]);
  const [isGenreOpen, setGenreOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const movieQuery = useQuery({
    queryKey: ['admin', 'movies', id],
    queryFn: () => getMovie(id!),
    enabled: !isCreate,
  });

  const genresQuery = useQuery({ queryKey: ['admin', 'genres'], queryFn: listGenres });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    // `tagline_i18n` is wrapped in z.preprocess (all-blank normalises to null),
    // which widens the schema's *input* type to unknown and stops it matching
    // FormValues. The fields themselves only ever produce the output shape, so
    // the form is typed on that and the resolver is asserted to match.
    resolver: zodResolver(MovieCreateSchema) as Resolver<FormValues>,
    defaultValues: EMPTY_FORM,
  });

  // Seed the form once the movie arrives. Artwork and genres are held outside
  // the form because they are picked through modals, not typed.
  const movie = movieQuery.data;
  useEffect(() => {
    if (!movie) return;

    reset({
      title_i18n: movie.titleI18n,
      overview_i18n: movie.overviewI18n,
      tagline_i18n: movie.taglineI18n?.en
        ? {
            en: movie.taglineI18n.en ?? '',
            ckb: movie.taglineI18n.ckb ?? '',
            ar: movie.taglineI18n.ar ?? '',
          }
        : null,
      release_year: movie.releaseYear,
      runtime_minutes: movie.runtimeMinutes,
      poster_asset_id: movie.poster?.id ?? null,
      backdrop_asset_id: movie.backdrop?.id ?? null,
      genre_ids: movie.genres.map((genre) => genre.id),
    });

    setPoster(movie.poster);
    setBackdrop(movie.backdrop);
    setSelectedGenres(movie.genres);
  }, [movie, reset]);

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: MovieCreateInput = {
        ...values,
        poster_asset_id: poster?.id ?? null,
        backdrop_asset_id: backdrop?.id ?? null,
        genre_ids: selectedGenres.map((genre) => genre.id),
      };

      return isCreate ? createMovie(payload) : updateMovie(id!, payload);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'movies'] });
      // Land on the saved movie so the sources and subtitles sections become
      // usable straight after a create.
      navigate(`/movies/${saved.id}`, { replace: true });
    },
    onError: (cause) => {
      setSaveError(cause instanceof ApiError ? cause.message : 'Could not save this movie.');
    },
  });

  const onSubmit: SubmitHandler<FormValues> = (values) => {
    setSaveError(null);
    saveMutation.mutate(values);
  };

  /** Locales with a validation error, for the tab markers. */
  const invalidLocales = SUPPORTED_LOCALES.filter(
    (locale) =>
      errors.title_i18n?.[locale] ||
      errors.overview_i18n?.[locale] ||
      errors.tagline_i18n?.[locale],
  );

  function toggleGenre(genre: GenreDto) {
    setSelectedGenres((current) =>
      current.some((item) => item.id === genre.id)
        ? current.filter((item) => item.id !== genre.id)
        : [...current, genre],
    );
  }

  if (!isCreate && movieQuery.isPending) {
    return <p className="p-6 text-sm text-slate-400">Loading…</p>;
  }

  if (!isCreate && movieQuery.isError) {
    return <p className="p-6 text-sm text-rose-300">Could not load this movie.</p>;
  }

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={() => navigate('/movies')}
        className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to movies
      </button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            {isCreate ? 'New movie' : (movie?.titleI18n.en ?? 'Movie')}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Metadata is required in English, Kurdish Sorani and Arabic.
          </p>
        </div>
      </header>

      {/*
        Publishing needs a saved movie to validate, so it only appears once the
        movie exists — on create the status is DRAFT by definition.
      */}
      {!isCreate && movie && (
        <PublishActions
          contentType="movie"
          id={movie.id}
          currentStatus={movie.status}
          onStatusChange={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin', 'movies'] });
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
                  <label htmlFor={`title-${locale}`} className={LABEL_CLASS}>
                    Title
                  </label>
                  <input
                    id={`title-${locale}`}
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
                  <label htmlFor={`overview-${locale}`} className={LABEL_CLASS}>
                    Overview
                  </label>
                  <textarea
                    id={`overview-${locale}`}
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

                <div>
                  <label htmlFor={`tagline-${locale}`} className={LABEL_CLASS}>
                    Tagline <span className="text-slate-600">(optional)</span>
                  </label>
                  <input
                    id={`tagline-${locale}`}
                    type="text"
                    dir={LOCALE_DIRECTION[locale]}
                    disabled={!canEdit}
                    className={INPUT_CLASS}
                    {...register(`tagline_i18n.${locale}`)}
                  />
                  {/*
                    Leaving the tagline blank everywhere is fine, but filling in
                    one language and not the others is not. Without this the
                    save would fail with nothing on screen to explain why.
                  */}
                  {errors.tagline_i18n?.[locale] && (
                    <p className="mt-1 text-xs text-rose-300">
                      {errors.tagline_i18n[locale]?.message}
                    </p>
                  )}
                </div>
              </div>
            )}
          </LocalizedTabs>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="release-year" className={LABEL_CLASS}>
                Release year
              </label>
              <input
                id="release-year"
                type="number"
                min={1888}
                max={2100}
                disabled={!canEdit}
                className={INPUT_CLASS}
                {...register('release_year', { setValueAs: (v) => (v === '' ? null : Number(v)) })}
              />
              {errors.release_year && (
                <p className="mt-1 text-xs text-rose-300">{errors.release_year.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="runtime" className={LABEL_CLASS}>
                Runtime (minutes)
              </label>
              <input
                id="runtime"
                type="number"
                min={1}
                disabled={!canEdit}
                className={INPUT_CLASS}
                {...register('runtime_minutes', {
                  setValueAs: (v) => (v === '' ? null : Number(v)),
                })}
              />
              {errors.runtime_minutes && (
                <p className="mt-1 text-xs text-rose-300">{errors.runtime_minutes.message}</p>
              )}
            </div>
          </div>
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

        <Section title="Genres">
          <div className="flex flex-wrap items-center gap-2">
            {selectedGenres.map((genre) => (
              <span
                key={genre.id}
                className="flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-200"
              >
                {genre.nameI18n.en}
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Remove ${genre.nameI18n.en}`}
                    onClick={() => toggleGenre(genre)}
                    className="text-slate-400 transition hover:text-slate-100"
                  >
                    <X size={12} aria-hidden />
                  </button>
                )}
              </span>
            ))}

            {canEdit && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setGenreOpen((open) => !open)}
                  className="flex items-center gap-1.5 rounded-full border border-dashed border-slate-700 px-2.5 py-1 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
                >
                  <Plus size={12} aria-hidden />
                  Add genre
                </button>

                {isGenreOpen && (
                  <div className="absolute left-0 top-full z-10 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 py-1 shadow-xl">
                    {(genresQuery.data ?? []).length === 0 && (
                      <p className="px-3 py-2 text-xs text-slate-400">
                        No genres defined yet.
                      </p>
                    )}
                    {(genresQuery.data ?? []).map((genre) => {
                      const isSelected = selectedGenres.some((item) => item.id === genre.id);
                      return (
                        <button
                          key={genre.id}
                          type="button"
                          onClick={() => toggleGenre(genre)}
                          className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-slate-300 transition hover:bg-slate-800"
                        >
                          {genre.nameI18n.en}
                          {isSelected && <Check size={12} aria-hidden className="text-slate-100" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {selectedGenres.length === 0 && !canEdit && (
              <span className="text-xs text-slate-500">No genres assigned.</span>
            )}
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
        Sources and subtitles hang off a movie id, so they cannot exist before
        the movie does. On create they appear after the first save.
      */}
      {isCreate ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-800 px-5 py-4 text-sm text-slate-400">
          Save this movie first to add stream sources and subtitle tracks.
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          <Section
            title="Stream sources"
            description="Priority order — the first entry is the primary source. URLs are hidden by default and every reveal is audited."
          >
            <StreamSourcesSection movieId={id} />
          </Section>

          <Section title="Subtitles" description="One track per language, from the library or a remote URL.">
            <SubtitlesSection movieId={id} />
          </Section>
        </div>
      )}
    </div>
  );
}
