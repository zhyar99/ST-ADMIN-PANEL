import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, ImageOff } from 'lucide-react';
import type { AssetDto, LiveChannelCreateInput, SupportedLocale } from '@streaming/shared';
import { LiveChannelCreateInput as LiveChannelCreateSchema, SUPPORTED_LOCALES } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import {
  addChannelSource,
  createLiveChannel,
  deleteChannelSource,
  getChannelSourceUrl,
  getLiveChannel,
  listChannelSources,
  reorderChannelSources,
  testChannelSource,
  updateLiveChannel,
} from '../../lib/liveTvApi';
import AssetPickerModal from '../../components/AssetPickerModal';
import LocalizedTabs, { LOCALE_DIRECTION } from '../../components/LocalizedTabs';
import PublishActions from '../../components/PublishActions';
import StreamSourceManager, { type StreamSourceApi } from '../../components/StreamSourceManager';

type FormValues = LiveChannelCreateInput;

const EMPTY_FORM: FormValues = {
  name_i18n: { en: '', ckb: '', ar: '' },
  category: '',
  logo_asset_id: null,
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

/** Channel logo picker with a preview and a remove button. */
function LogoPicker({
  asset,
  disabled,
  onChange,
}: {
  asset: AssetDto | null;
  disabled: boolean;
  onChange: (asset: AssetDto | null) => void;
}) {
  const [isOpen, setOpen] = useState(false);

  return (
    <div>
      <span className={LABEL_CLASS}>Logo</span>

      {asset ? (
        <div className="space-y-2">
          {/*
            `object-contain` on a neutral tile: channel logos are usually
            transparent PNGs of varying aspect ratio, and cropping them to a
            square the way poster artwork is cropped would cut off the mark.
          */}
          <img
            src={asset.url}
            alt=""
            className="h-24 w-24 rounded-md border border-slate-800 bg-slate-950 object-contain p-2"
          />
          {!disabled && (
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
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="flex h-24 w-24 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-slate-700 text-slate-500 transition hover:border-slate-500 hover:text-slate-300 disabled:opacity-40"
        >
          <ImageOff size={20} aria-hidden />
          <span className="text-xs">Choose logo</span>
        </button>
      )}

      <AssetPickerModal open={isOpen} kind="LOGO" onSelect={onChange} onClose={() => setOpen(false)} />
    </div>
  );
}

export default function LiveTvEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();

  const isCreate = id === undefined || id === 'new';
  const canEdit = isAdmin();

  const [logo, setLogo] = useState<AssetDto | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const channelQuery = useQuery({
    queryKey: ['admin', 'live-channels', id],
    queryFn: () => getLiveChannel(id!),
    enabled: !isCreate,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(LiveChannelCreateSchema),
    defaultValues: EMPTY_FORM,
  });

  // Seed the form once the channel arrives. The logo is held outside the form
  // because it is picked through a modal, not typed.
  const channel = channelQuery.data;
  useEffect(() => {
    if (!channel) return;

    reset({
      name_i18n: channel.nameI18n,
      category: channel.category,
      logo_asset_id: channel.logo?.id ?? null,
    });

    setLogo(channel.logo);
  }, [channel, reset]);

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload: LiveChannelCreateInput = { ...values, logo_asset_id: logo?.id ?? null };
      return isCreate ? createLiveChannel(payload) : updateLiveChannel(id!, payload);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'live-channels'] });
      // Land on the saved channel so the sources section becomes usable
      // straight after a create.
      navigate(`/live-tv/${saved.id}`, { replace: true });
    },
    onError: (cause) => {
      setSaveError(cause instanceof ApiError ? cause.message : 'Could not save this channel.');
    },
  });

  const onSubmit: SubmitHandler<FormValues> = (values) => {
    setSaveError(null);
    saveMutation.mutate(values);
  };

  /** Locales with a validation error, for the tab markers. */
  const invalidLocales = SUPPORTED_LOCALES.filter((locale) => errors.name_i18n?.[locale]);

  // Rebuilt only when the channel id changes — a new object identity on every
  // render would reset the source list's mutation state mid-interaction.
  const sourceApi = useMemo<StreamSourceApi>(
    () => ({
      list: () => listChannelSources(id!),
      add: (url) => addChannelSource(id!, { url }),
      remove: (sourceId) => deleteChannelSource(id!, sourceId),
      reorder: (orderedIds) => reorderChannelSources(id!, orderedIds),
      test: (sourceId) => testChannelSource(id!, sourceId),
      revealUrl: (sourceId) => getChannelSourceUrl(id!, sourceId),
    }),
    [id],
  );

  if (!isCreate && channelQuery.isPending) {
    return <p className="p-6 text-sm text-slate-400">Loading…</p>;
  }

  if (!isCreate && channelQuery.isError) {
    return <p className="p-6 text-sm text-rose-300">Could not load this channel.</p>;
  }

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={() => navigate('/live-tv')}
        className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to live TV
      </button>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            {isCreate ? 'New live channel' : (channel?.nameI18n.en ?? 'Live channel')}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            The channel name is required in English, Kurdish Sorani and Arabic.
          </p>
        </div>
      </header>

      {!isCreate && channel && (
        <PublishActions
          contentType="live_channel"
          id={channel.id}
          currentStatus={channel.status}
          onStatusChange={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin', 'live-channels'] });
          }}
        />
      )}

      {saveError && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {saveError}
        </p>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <Section title="Channel details">
          <LocalizedTabs invalidLocales={invalidLocales}>
            {(locale: SupportedLocale) => (
              <div>
                <label htmlFor={`name-${locale}`} className={LABEL_CLASS}>
                  Name
                </label>
                <input
                  id={`name-${locale}`}
                  type="text"
                  dir={LOCALE_DIRECTION[locale]}
                  disabled={!canEdit}
                  className={INPUT_CLASS}
                  {...register(`name_i18n.${locale}`)}
                />
                {errors.name_i18n?.[locale] && (
                  <p className="mt-1 text-xs text-rose-300">{errors.name_i18n[locale]?.message}</p>
                )}
              </div>
            )}
          </LocalizedTabs>

          <div className="mt-5">
            <label htmlFor="category" className={LABEL_CLASS}>
              Category
            </label>
            <input
              id="category"
              type="text"
              placeholder="News, Sport, Entertainment…"
              disabled={!canEdit}
              className={`${INPUT_CLASS} max-w-xs`}
              {...register('category')}
            />
            {errors.category && (
              <p className="mt-1 text-xs text-rose-300">{errors.category.message}</p>
            )}
          </div>
        </Section>

        <Section title="Branding" description="Logos are shown in the channel strip and the guide.">
          <LogoPicker asset={logo} disabled={!canEdit} onChange={setLogo} />
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
        Sources hang off a channel id, so they cannot exist before the channel
        does. On create they appear after the first save. Live TV has no
        subtitle section — a linear feed carries its own captions.
      */}
      {isCreate ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-800 px-5 py-4 text-sm text-slate-400">
          Save this channel first to add stream sources.
        </p>
      ) : (
        <div className="mt-5">
          <Section
            title="Stream sources"
            description="Priority order — the first entry is the primary feed. URLs are hidden by default and every reveal is audited."
          >
            <StreamSourceManager
              queryKey={['admin', 'live-channels', id, 'sources']}
              api={sourceApi}
            />
          </Section>
        </div>
      )}
    </div>
  );
}
