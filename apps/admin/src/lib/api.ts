/**
 * Thin fetch wrapper for the admin API.
 *
 * The access token lives in this module's closure — never in localStorage and
 * never in React state that could be serialised into the DOM. `AuthProvider`
 * is what pushes it in and registers the refresh handler.
 */

const API_BASE = '/api/v1';

let accessToken: string | null = null;
let refreshHandler: (() => Promise<string | null>) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Registered by AuthProvider so a 401 can transparently rotate the session. */
export function setRefreshHandler(handler: (() => Promise<string | null>) | null): void {
  refreshHandler = handler;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * The machine-readable half of errors that have one — a failed publish
     * lists every unmet requirement here so the UI can render a checklist
     * rather than re-parsing `message`. Empty for everything else.
     */
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set false for the auth endpoints themselves, to avoid a refresh loop. */
  auth?: boolean;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'REQUEST_FAILED';
  let message = `Request failed with status ${response.status}`;
  let reasons: string[] = [];

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; reasons?: unknown };
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    if (Array.isArray(body.error?.reasons)) {
      reasons = body.error.reasons.filter((reason): reason is string => typeof reason === 'string');
    }
  } catch {
    // Non-JSON error body — keep the status-derived defaults.
  }

  return new ApiError(response.status, code, message, reasons);
}

async function send(path: string, options: ApiRequestOptions): Promise<Response> {
  const { body, auth = true, headers, ...rest } = options;
  const requestHeaders = new Headers(headers);

  // FormData carries its own multipart boundary — setting Content-Type by hand
  // would strip it and the server would fail to parse the upload.
  const isMultipart = body instanceof FormData;

  if (body !== undefined && !isMultipart) requestHeaders.set('Content-Type', 'application/json');
  if (auth && accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);

  return fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: requestHeaders,
    body: body === undefined ? undefined : isMultipart ? body : JSON.stringify(body),
  });
}

/**
 * Performs a request, and on a 401 refreshes the access token and retries
 * exactly once before giving up.
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  if (response.status === 401 && options.auth !== false && refreshHandler) {
    const renewed = await refreshHandler();
    if (renewed) response = await send(path, options);
  }

  if (!response.ok) throw await toApiError(response);

  // 204 and friends have no body to parse.
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return (await response.json()) as T;
}
