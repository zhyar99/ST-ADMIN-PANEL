import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { z } from 'zod';

import { ApiError, apiFetch } from '../lib/api';
import { useAuth, type AdminRole } from '../lib/authContext';

interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

const inviteSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  name: z.string().min(1, 'Name is required').max(120),
  password: z.string().min(10, 'Password must be at least 10 characters'),
  role: z.enum(['ADMIN', 'VIEWER']),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

const ROLE_BADGE: Record<AdminRole, string> = {
  ADMIN: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  VIEWER: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
};

const USERS_QUERY_KEY = ['admin', 'users'] as const;

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [isInviteOpen, setInviteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const usersQuery = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: () => apiFetch<{ users: AdminUserRow[] }>('/admin/users'),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch<{ user: AdminUserRow }>(`/admin/users/${id}`, {
        method: 'PATCH',
        body: { isActive },
      }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : 'Could not update the user.');
    },
  });

  const columnHelper = createColumnHelper<AdminUserRow>();

  const columns = useMemo(
    () => [
      columnHelper.accessor('email', {
        header: 'Email',
        cell: (info) => <span className="text-slate-200">{info.getValue()}</span>,
      }),
      columnHelper.accessor('name', { header: 'Name' }),
      columnHelper.accessor('role', {
        header: 'Role',
        cell: (info) => (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
              ROLE_BADGE[info.getValue()]
            }`}
          >
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('isActive', {
        header: 'Status',
        cell: (info) => (
          <span className={info.getValue() ? 'text-emerald-400' : 'text-slate-500'}>
            {info.getValue() ? 'Active' : 'Inactive'}
          </span>
        ),
      }),
      columnHelper.accessor('lastLoginAt', {
        header: 'Last Login',
        cell: (info) => <span className="text-slate-400">{formatDate(info.getValue())}</span>,
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const target = row.original;
          // Deactivating yourself is rejected by the server; don't offer it.
          const isSelf = target.id === currentUser?.id;

          return (
            <button
              type="button"
              disabled={isSelf || toggleActive.isPending}
              onClick={() => toggleActive.mutate({ id: target.id, isActive: !target.isActive })}
              title={isSelf ? 'You cannot deactivate your own account' : undefined}
              className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {target.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
          );
        },
      }),
    ],
    [columnHelper, currentUser?.id, toggleActive],
  );

  const table = useReactTable({
    data: usersQuery.data?.users ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Users</h1>
          <p className="mt-1 text-sm text-slate-400">
            Admin staff accounts. Only an ADMIN can invite or deactivate users.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
        >
          Invite User
        </button>
      </div>

      {actionError && (
        <p
          className="mt-4 rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {actionError}
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} className="px-4 py-3 font-medium">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-800">
            {usersQuery.isLoading && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-6 text-slate-400">
                  Loading users…
                </td>
              </tr>
            )}

            {usersQuery.isError && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-6 text-rose-300">
                  {usersQuery.error instanceof ApiError
                    ? usersQuery.error.message
                    : 'Could not load users.'}
                </td>
              </tr>
            )}

            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-900/40">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 text-slate-300">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isInviteOpen && (
        <InviteUserDialog
          onClose={() => setInviteOpen(false)}
          onCreated={() => {
            setInviteOpen(false);
            void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
          }}
        />
      )}
    </div>
  );
}

function InviteUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', name: '', password: '', role: 'VIEWER' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await apiFetch('/admin/users', { method: 'POST', body: values });
      onCreated();
    } catch (error) {
      setSubmitError(
        error instanceof ApiError ? error.message : 'Could not create the user. Please try again.',
      );
    }
  });

  const fieldClass =
    'mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-slate-500';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-user-title"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h2 id="invite-user-title" className="text-lg font-semibold text-slate-100">
          Invite User
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          The new user signs in with the password you set here.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
          <div>
            <label htmlFor="invite-email" className="block text-sm font-medium text-slate-300">
              Email
            </label>
            <input id="invite-email" type="email" className={fieldClass} {...register('email')} />
            {errors.email && <p className="mt-1 text-xs text-rose-400">{errors.email.message}</p>}
          </div>

          <div>
            <label htmlFor="invite-name" className="block text-sm font-medium text-slate-300">
              Name
            </label>
            <input id="invite-name" type="text" className={fieldClass} {...register('name')} />
            {errors.name && <p className="mt-1 text-xs text-rose-400">{errors.name.message}</p>}
          </div>

          <div>
            <label htmlFor="invite-password" className="block text-sm font-medium text-slate-300">
              Temporary password
            </label>
            <input
              id="invite-password"
              type="password"
              autoComplete="new-password"
              className={fieldClass}
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-rose-400">{errors.password.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="invite-role" className="block text-sm font-medium text-slate-300">
              Role
            </label>
            <select id="invite-role" className={fieldClass} {...register('role')}>
              <option value="VIEWER">VIEWER — read-only access</option>
              <option value="ADMIN">ADMIN — full access, can manage users</option>
            </select>
          </div>

          {submitError && (
            <p
              className="rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300"
              role="alert"
            >
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
