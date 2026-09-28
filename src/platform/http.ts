/**
 * The HTTP client handed to providers.
 *
 * Two things it does that a bare `fetch` does not:
 *
 * - Sends `Api-User-Agent`. Wikimedia's etiquette policy requires a
 *   meaningful User-Agent with contact details; browser JavaScript cannot
 *   set `User-Agent`, and `Api-User-Agent` is the documented substitute.
 *   Anonymous traffic is the first to be throttled.
 * - Fails fast and loudly on a non-2xx, so a provider treats an outage as
 *   an absent slot rather than parsing an error page as data.
 */
import type { HttpClient } from '../core/types.ts';

const CONTACT = 'https://github.com/mmdemirbas/quick-lookup-extension';

export function userAgent(version: string): string {
  return `QuickLookup/${version} (${CONTACT})`;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export function createHttpClient(version: string): HttpClient {
  const headers = {
    Accept: 'application/json',
    'Api-User-Agent': userAgent(version),
  };

  return {
    async json<T>(url: string, init: { signal?: AbortSignal } = {}): Promise<T> {
      const response = await fetch(url, {
        headers,
        credentials: 'omit',
        redirect: 'follow',
        ...(init.signal ? { signal: init.signal } : {}),
      });
      if (!response.ok) throw new HttpError(response.status, url);
      return (await response.json()) as T;
    },
  };
}
