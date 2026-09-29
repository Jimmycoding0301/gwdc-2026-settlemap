export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, typeof data?.code === 'string' ? data.code : undefined, data?.details);
  }
  return data as T;
}

export function post<T>(path: string, body?: unknown) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

export function downloadUrl(path: string) {
  const anchor = document.createElement('a');
  anchor.href = `/api${path}`;
  anchor.click();
}
