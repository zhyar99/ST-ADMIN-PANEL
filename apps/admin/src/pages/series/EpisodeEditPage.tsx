import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type Resolver, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, ImageOff } from 'lucide-react';
import type { AssetDto, EpisodeCreateInput, SupportedLocale } from '@streaming/shared';
import { EpisodeCreateInput as EpisodeCreateSchema, SUPPORTED_LOCALES } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { createEpisode, getEpisode, updateEpisode } from '../../lib/seriesApi';
import AssetPickerModal from '../../components/AssetPickerModal';
import LocalizedTabs, { LOCALE_DIRECTION } from '../../components/LocalizedTabs';
import PublishActions from '../../components/PublishActions';
import EpisodeSourcesSection from './EpisodeSourcesSection';
import EpisodeSubtitlesSection from './EpisodeSubtitlesSection';

type FormValues = EpisodeCreateInput;

const EMPTY_FORM: FormValues = {
  number: 1,
  title_i18n: { en: '', ckb: '', ar: '' },
  overview_i18n: null,
  thumbnail_asset_id: null,
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

/**
 * Episode thumbnail picker.
 *
 * Fixed to 16:9 and to `kind=THUMBNAIL`, which the server also enforces — a
 * portrait poster passed here comes back as an ASSET_KIND_MISMATCH rather than
 * silently breaking every episode row that renders it.
 */
function ThumbnailPicker({
  asset,
  onChange,
}: {
  asset: AssetDto | null;
  onChange: (asset: AssetDto | null) => void;
}) {
  const [isOpen, setOpen] = useState(false);

  return (
    <div>
      <span className={LABEL_CLASS}>Thumbnail</span>

      {asset ? (
        <div className="space-y-2">
          <img
            src={asset.url}
            alt=""
            className="aspect-video w-full max-w-md rounded-md border border-slate-800 object-cover"
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
          className="flex aspect-video w-full max-w-md flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-slate-700 text-slate-500 transition hover:border-slate-500 hover:text-slate-300"
        >
          <ImageOff size={20} aria-hidden />
          <span className="text-xs">Choose thumbnail</span>
        </button>
      )}

      <AssetPickerModal
        open={isOpen}
        kind="THUMBNAIL"
        onSelect={onChange}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

export default function EpisodeEditPage() {
  const { seriesId, seasonId, episodeId } = useParams<{
    seriesId: string;
    seasonId: string;
    episodeId: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();

  // The create route is ".../episodes/new", so the literal "new" is what
  // distinguishes the two modes rather than an absent param.
  const isCreate = episodeId === undefined || episodeId === 'new';
  const canEdit = isAdmin();

  const [thumbnail, setThumbnail] = useState<AssetDto | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const episodeQuery = useQuery({
    queryKey: ['admin', 'episodes', episodeId],
    queryFn: () => getEpisode(seriesId!, seasonId!, episodeId!),
    enabled: !isCreate,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    // `overview_i18n` is wrapped in z.preprocess (all-blank normalises to
    // null), which widens the schema's *input* type to unknown and stops it
    // matching FormValues. The fields themselves only ever produce the output
    // shape, so the form is typed on that and the resolver asserted to match.
    resolver: zodResolver(EpisodeCreateSchema) as Resolver<FormValues>,
    defaultValues: EMPTY_FORM,
  });

  const episode = episodeQuery.data;
  useEffect(() => {
    if (!episode) return;

    reset({
      number: episode.number,
      title_i18n: episode.titleI18n,
      overview_i18n: episode.overviewI18n,
      thumbnail_asset_id: episode.thumbnail?.id ?? null,
    });

    setThumbnail(episode.thumbnail);
  }, [episode, reset]);

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: EpisodeCreateInput = {
        ...values,
        thumbnail_asset_id: thumbnail?.id ?? null,
      };

      return isCreate
        ? createEpisode(seriesId!, seasonId!, payload)
        : updateEpisode(seriesId!, seasonId!, episodeId!, payload);
    },
    onSuccess: (saved) => {
      // The season's episode list and the parent series' counts both change.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'series', seriesId] });
      // Land on the saved episode so sources and subtitles become usable
      // straight after a create.
      navigate(`/series/${seriesId}/seasons/${seasonId}/episodes/${saved.id}`, { replace: true });
    },
    onError: (cause) => {
      setSaveError(cause instanceof ApiError ? cause.message : 'Could not save this episode.');
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

  if (!isCreate && episodeQuery.isPending) {
    return <p className="p-6 text-sm text-slate-400">Loading…</p>;
  }

  if (!isCreate && episodeQuery.isError) {
    return <p className="p-6 text-sm text-rose-300">Could not load this episode.</p>;
  }

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={() => navigate(`/series/${seriesId}`)}
        className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to series
      </button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            {isCreate ? 'New episode' : (episode?.titleI18n.en ?? 'Episode')}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {episode
              ? `Season ${episode.seasonNumber}, episode ${episode.number}.`
              : 'Metadata is required in English, Kurdish Sorani and Arabic.'}
          </p>
        </div>
      </header>

      {/*
        An episode publishes on its own, independently of its series — a
        published series can hold draft episodes and vice versa.
      */}
      {!isCreate && episode && (
        <PublishActions
          contentType="episode"
          id={episode.id}
          seriesId={episode.seriesId}
          seasonId={episode.seasonId}
          currentStatus={episode.status}
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
          <div className="mb-5 max-w-40">
            <label htmlFor="episode-number" className={LABEL_CLASS}>
              Episode number
            </label>
            <input
              id="episode-number"
              type="number"
              min={0}
              max={10000}
              disabled={!canEdit}
              className={INPUT_CLASS}
              {...register('number', { setValueAs: (v) => (v === '' ? undefined : Number(v)) })}
            />
            {errors.number && (
              <p className="mt-1 text-xs text-rose-300">{errors.number.message}</p>
            )}
          </div>

          <LocalizedTabs invalidLocales={invalidLocales}>
            {(locale: SupportedLocale) => (
              <div className="space-y-4">
                <div>
                  <label htmlFor={`episode-title-${locale}`} className={LABEL_CLASS}>
                    Title
                  </label>
                  <input
                    id={`episode-title-${locale}`}
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
                  <label htmlFor={`episode-overview-${locale}`} className={LABEL_CLASS}>
                    Overview <span className="text-slate-600">(optional)</span>
                  </label>
                  <textarea
                    id={`episode-overview-${locale}`}
                    rows={4}
                    dir={LOCALE_DIRECTION[locale]}
                    disabled={!canEdit}
                    className={INPUT_CLASS}
                    {...register(`overview_i18n.${locale}`)}
                  />
                  {/*
                    Leaving the overview blank everywhere is fine, but filling
                    in one language and not the others is not. Without this the
                    save would fail with nothing on screen to explain why.
                  */}
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

        <Section title="Artwork" description="Episode thumbnails are 16:9.">
          <ThumbnailPicker asset={thumbnail} onChange={setThumbnail} />
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
        Sources and subtitles hang off an episode id, so they cannot exist
        before the episode does. On create they appear after the first save.
      */}
      {isCreate ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-800 px-5 py-4 text-sm text-slate-400">
          Save this episode first to add stream sources and subtitle tracks.
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          <Section
            title="Stream sources"
            description="Priority order — the first entry is the primary source. URLs are hidden by default and every reveal is audited."
          >
            <EpisodeSourcesSection
              episode={{ seriesId: seriesId!, seasonId: seasonId!, episodeId: episodeId! }}
            />
          </Section>

          <Section
            title="Subtitles"
            description="One track per language, from the library or a remote URL."
          >
            <EpisodeSubtitlesSection
              episode={{ seriesId: seriesId!, seasonId: seasonId!, episodeId: episodeId! }}
            />
          </Section>
        </div>
      )}
    </div>
  );
}
