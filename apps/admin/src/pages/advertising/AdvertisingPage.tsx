import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Film, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import type { AdConfigDto, AdCreativeDto, AssetDto } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import {
  createAdCreative,
  deleteAdCreative,
  getAdConfig,
  listAdCreatives,
  updateAdConfig,
  updateAdCreative,
} from '../../lib/advertisingApi';
import AssetPickerModal from '../../components/AssetPickerModal';
import Modal from '../../components/Modal';

/**
 * Advertising settings and the creative pool.
 *
 * Both halves of the page describe *rules*, not campaigns: one global timing
 * config, and a flat pool of creatives one of which each VOD session receives
 * at random. There is deliberately no scheduling, targeting or reporting UI —
 * those need a campaign model this phase does not build, and a disabled control
 * promising them would be a worse lie than their absence.
 */

const CONFIG_KEY = ['admin', 'advertising', 'config'] as const;
const CREATIVES_KEY = ['admin', 'advertising', 'creatives'] as const;

/**
 * Mirrors the server's `adConfigUpdateBody`, including the cross-field rule.
 *
 * Duplicated rather than imported because the server's copy also accepts a
 * partial patch, while this form always submits every field — the shapes agree
 * on what is valid and differ on what is required, which is the normal split
 * between a form and an API.
 */
const seconds = (label: string) =>
  z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(1, `${label} must be at least 1`)
    .max(3600, `${label} must be at most 3600`);

const configSchema = z
  .object({
    preRollMinSeconds: seconds('Pre-roll minimum'),
    preRollMaxSeconds: seconds('Pre-roll maximum'),
    midRollIntervalMinutes: seconds('Mid-roll interval'),
    midRollMaxSeconds: seconds('Mid-roll maximum'),
    skipAfterSeconds: seconds('Skip after'),
  })
  .refine((values) => values.preRollMaxSeconds >= values.preRollMinSeconds, {
    path: ['preRollMaxSeconds'],
    message: 'Maximum must be at least the minimum',
  });

type ConfigFormValues = z.infer<typeof configSchema>;

const FIELDS: { name: keyof ConfigFormValues; label: string; hint: string }[] = [
  {
    name: 'preRollMinSeconds',
    label: 'Pre-roll minimum (seconds)',
    hint: 'Shortest pre-roll break before playback starts.',
  },
  {
    name: 'preRollMaxSeconds',
    label: 'Pre-roll maximum (seconds)',
    hint: 'Longest pre-roll break. Never below the minimum.',
  },
  {
    name: 'midRollIntervalMinutes',
    label: 'Mid-roll interval (minutes)',
    hint: 'How often a mid-roll break is due during playback.',
  },
  {
    name: 'midRollMaxSeconds',
    label: 'Mid-roll maximum (seconds)',
    hint: 'Longest mid-roll break.',
  },
  {
    name: 'skipAfterSeconds',
    label: 'Skip after (seconds)',
    hint: 'When a mid-roll becomes skippable. Pre-rolls are never skippable.',
  },
];

function AdSettingsCard({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null);

  const configQuery = useQuery({ queryKey: CONFIG_KEY, queryFn: getAdConfig });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<ConfigFormValues>({ resolver: zodResolver(configSchema) });

  // Seeded from the server rather than from hardcoded defaults, so the form
  // never briefly shows numbers that are not the ones in force.
  const config: AdConfigDto | undefined = configQuery.data;
  useEffect(() => {
    if (!config) return;

    reset({
      preRollMinSeconds: config.preRollMinSeconds,
      preRollMaxSeconds: config.preRollMaxSeconds,
      midRollIntervalMinutes: config.midRollIntervalMinutes,
      midRollMaxSeconds: config.midRollMaxSeconds,
      skipAfterSeconds: config.skipAfterSeconds,
    });
  }, [config, reset]);

  const saveMutation = useMutation({
    mutationFn: (values: ConfigFormValues) => updateAdConfig(values),
    onSuccess: (saved) => {
      queryClient.setQueryData(CONFIG_KEY, saved);
      reset({
        preRollMinSeconds: saved.preRollMinSeconds,
        preRollMaxSeconds: saved.preRollMaxSeconds,
        midRollIntervalMinutes: saved.midRollIntervalMinutes,
        midRollMaxSeconds: saved.midRollMaxSeconds,
        skipAfterSeconds: saved.skipAfterSeconds,
      });
      setStatus({ tone: 'ok', message: 'Ad settings saved.' });
    },
    onError: (cause) => {
      setStatus({
        tone: 'error',
        message: cause instanceof ApiError ? cause.message : 'Could not save the ad settings.',
      });
    },
  });

  const onSubmit: SubmitHandler<ConfigFormValues> = (values) => {
    setStatus(null);
    saveMutation.mutate(values);
  };

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <header className="mb-4">
        <h2 className="text-sm font-medium text-slate-200">Ad settings</h2>
        <p className="mt-1 text-xs text-slate-400">
          One global rule. It applies to every movie and episode; live channels carry no ad breaks.
        </p>
      </header>

      {configQuery.isPending && <p className="text-sm text-slate-400">Loading…</p>}

      {configQuery.isError && (
        <p className="text-sm text-rose-300">Could not load the ad settings.</p>
      )}

      {configQuery.isSuccess && (
        <form onSubmit={(event) => void handleSubmit(onSubmit)(event)}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((field) => (
              <div key={field.name}>
                <label
                  htmlFor={field.name}
                  className="mb-1 block text-xs font-medium text-slate-400"
                >
                  {field.label}
                </label>
                <input
                  id={field.name}
                  type="number"
                  min={1}
                  max={3600}
                  step={1}
                  disabled={!canEdit}
                  {...register(field.name)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-slate-500">{field.hint}</p>
                {errors[field.name] && (
                  <p className="mt-1 text-xs text-rose-300">{errors[field.name]?.message}</p>
                )}
              </div>
            ))}
          </div>

          {status && (
            <p
              className={`mt-4 rounded-md border px-3 py-2 text-sm ${
                status.tone === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              }`}
            >
              {status.message}
            </p>
          )}

          {canEdit && (
            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={!isDirty || saveMutation.isPending}
                className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-40"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}

/** Duration is typed, not probed: nothing in this system decodes video. */
function AddCreativeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [asset, setAsset] = useState<AssetDto | null>(null);
  const [duration, setDuration] = useState('15');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedDuration = Number(duration);
  const durationValid = Number.isInteger(parsedDuration) && parsedDuration >= 1;

  function close() {
    setAsset(null);
    setDuration('15');
    setError(null);
    onClose();
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createAdCreative({ assetId: asset!.id, durationSeconds: parsedDuration }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CREATIVES_KEY });
      close();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not add this creative.');
    },
  });

  return (
    <>
      <Modal
        open={open && !pickerOpen}
        title="Add creative"
        description="Pick an uploaded ad creative and say how long it runs."
        onClose={close}
        footer={
          <div className="flex w-full justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-slate-700 px-2.5 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!asset || !durationValid || createMutation.isPending}
              onClick={() => createMutation.mutate()}
              className="rounded-md bg-slate-100 px-2.5 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-40"
            >
              {createMutation.isPending ? 'Adding…' : 'Add creative'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-400">Creative file</span>
            {asset ? (
              <div className="flex items-center gap-3 rounded-md border border-slate-800 bg-slate-950 p-2">
                <CreativePreview asset={asset} />
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
                  {asset.url.slice(asset.url.lastIndexOf('/') + 1)}
                </span>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
                >
                  Change
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="w-full rounded-md border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
              >
                Choose from the media library
              </button>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Only ad creatives are listed. Upload new ones from the Media Library page.
            </p>
          </div>

          <div>
            <label
              htmlFor="creative-duration"
              className="mb-1 block text-xs font-medium text-slate-400"
            >
              Duration (seconds)
            </label>
            <input
              id="creative-duration"
              type="number"
              min={1}
              step={1}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
            />
          </div>

          {error && (
            <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </p>
          )}
        </div>
      </Modal>

      <AssetPickerModal
        open={pickerOpen}
        kind="AD_CREATIVE"
        onSelect={setAsset}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

/** A creative is an image or an MP4; only the former has anything to show. */
function CreativePreview({ asset }: { asset: AssetDto }) {
  if (asset.mimeType.startsWith('image/')) {
    return (
      <img
        src={asset.url}
        alt=""
        loading="lazy"
        className="h-10 w-16 shrink-0 rounded object-cover"
      />
    );
  }

  return (
    <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-slate-900 text-slate-500">
      <Film size={16} aria-hidden />
    </span>
  );
}

function CreativesSection({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdCreativeDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const creativesQuery = useQuery({ queryKey: CREATIVES_KEY, queryFn: listAdCreatives });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: CREATIVES_KEY });
  }

  function reportError(cause: unknown) {
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Try again.');
  }

  const toggleMutation = useMutation({
    mutationFn: (creative: AdCreativeDto) =>
      updateAdCreative(creative.id, { isActive: !creative.isActive }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdCreative(id),
    onSuccess: () => {
      setPendingDelete(null);
      setError(null);
      invalidate();
    },
    onError: (cause) => {
      setPendingDelete(null);
      reportError(cause);
    },
  });

  const creatives = creativesQuery.data ?? [];
  const activeCount = creatives.filter((creative) => creative.isActive).length;

  return (
    <section>
      <header className="mb-3 flex items-end justify-between">
        <div>
          <h2 className="text-sm font-medium text-slate-200">Ad creatives</h2>
          <p className="mt-1 text-xs text-slate-400">
            {activeCount === 0
              ? 'No active creatives — sessions carry the timing rules with no creative to play.'
              : `${activeCount} active. Each VOD session receives one of them at random.`}
          </p>
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white"
          >
            <Plus size={14} aria-hidden />
            Add creative
          </button>
        )}
      </header>

      {error && (
        <p className="mb-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Creative</th>
              <th className="px-4 py-2.5 font-medium">Duration</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              {canEdit && <th className="px-4 py-2.5 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {creativesQuery.isPending && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {creativesQuery.isError && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-rose-300">
                  Could not load the creatives.
                </td>
              </tr>
            )}

            {creativesQuery.isSuccess && creatives.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  No creatives yet.
                </td>
              </tr>
            )}

            {creatives.map((creative) => (
              <tr key={creative.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <CreativePreview asset={creative.asset} />
                    <span className="min-w-0 truncate text-slate-300">
                      {creative.asset.url.slice(creative.asset.url.lastIndexOf('/') + 1)}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-300">{creative.durationSeconds}s</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      creative.isActive
                        ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                        : 'bg-slate-500/15 text-slate-400 ring-slate-500/30'
                    }`}
                  >
                    {creative.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                {canEdit && (
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={toggleMutation.isPending}
                        onClick={() => toggleMutation.mutate(creative)}
                        className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
                      >
                        {creative.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(creative)}
                        className="flex items-center gap-1.5 rounded-md border border-rose-500/40 px-2.5 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/10"
                      >
                        <Trash2 size={13} aria-hidden />
                        Delete
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AddCreativeDialog open={addOpen} onClose={() => setAddOpen(false)} />

      <Modal
        open={pendingDelete !== null}
        title="Delete creative"
        description="The creative leaves the pool. Its file stays in the media library."
        onClose={() => setPendingDelete(null)}
        footer={
          <div className="flex w-full justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="rounded-md border border-slate-700 px-2.5 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleteMutation.isPending}
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
              className="rounded-md bg-rose-500 px-2.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-400 disabled:opacity-40"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        }
      >
        <p className="text-sm text-slate-300">
          Remove this creative from the pool? Playback sessions will stop receiving it.
        </p>
      </Modal>
    </section>
  );
}

export default function AdvertisingPage() {
  const { isAdmin } = useAuth();
  const canEdit = isAdmin();

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Advertising</h1>
        <p className="mt-1 text-sm text-slate-400">
          Fixed-rule VOD advertising. Timing applies to every movie and episode; a live channel
          session carries no ad policy at all.
        </p>
      </header>

      <AdSettingsCard canEdit={canEdit} />
      <CreativesSection canEdit={canEdit} />
    </div>
  );
}
