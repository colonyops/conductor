import type { Logger } from "./logger.js";

export type RequestInterceptor = (init: RequestInit) => RequestInit;
export type ResponseInterceptor = (
  response: Response,
  init?: RequestInit,
) => void;

export interface HttpRequestArgs<T = unknown> {
  url: string;
  body?: T;
  data?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  error: boolean;
  data: T;
  response: Response;
}

export interface HttpClient {
  get<T>(args: HttpRequestArgs): Promise<HttpResponse<T>>;
  post<TBody, TResponse>(
    args: HttpRequestArgs<TBody>,
  ): Promise<HttpResponse<TResponse>>;
  put<TBody, TResponse>(
    args: HttpRequestArgs<TBody>,
  ): Promise<HttpResponse<TResponse>>;
  patch<TBody, TResponse>(
    args: HttpRequestArgs<TBody>,
  ): Promise<HttpResponse<TResponse>>;
  delete<T>(args: HttpRequestArgs): Promise<HttpResponse<T>>;
  withRequestInterceptor(fn: RequestInterceptor): HttpClient;
  withResponseInterceptor(fn: ResponseInterceptor): HttpClient;
  withBearer(token: () => string | null): HttpClient;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const BODY_METHODS = new Set<Method>(["POST", "PUT", "PATCH"]);

export function createHttpClient(
  logger: Logger,
  baseHeaders: Record<string, string> = {},
): HttpClient {
  const requestInterceptors: RequestInterceptor[] = [];
  const responseInterceptors: ResponseInterceptor[] = [];
  let getBearer: () => string | null = () => null;

  function applyRequestInterceptors(init: RequestInit): RequestInit {
    return requestInterceptors.reduce((acc, fn) => fn(acc), init);
  }

  async function doRequest<T>(
    method: Method,
    args: HttpRequestArgs,
  ): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { ...baseHeaders, ...args.headers };

    const token = getBearer();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };
    if (args.signal) init.signal = args.signal;

    if (BODY_METHODS.has(method)) {
      if (args.data) {
        init.body = args.data;
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(args.body);
      }
    }

    const finalInit = applyRequestInterceptors(init);

    const start = performance.now();
    logger.debug("http request", { method, url: args.url });

    let response: Response;
    try {
      response = await fetch(args.url, finalInit);
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      logger.error("http request failed", {
        method,
        url: args.url,
        durationMs: ms,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const ms = Math.round(performance.now() - start);
    logger.info("http response", {
      method,
      url: args.url,
      status: response.status,
      durationMs: ms,
    });

    for (const fn of responseInterceptors) fn(response, finalInit);

    const data = await (async (): Promise<T> => {
      if (response.status === 204) return {} as T;
      const ct = response.headers.get("Content-Type") ?? "";
      if (ct.startsWith("application/json")) {
        try {
          return await response.json();
        } catch {
          return {} as T;
        }
      }
      return response.body as unknown as T;
    })();

    return { status: response.status, error: !response.ok, data, response };
  }

  const client: HttpClient = {
    get: (args) => doRequest("GET", args),
    post: (args) => doRequest("POST", args),
    put: (args) => doRequest("PUT", args),
    patch: (args) => doRequest("PATCH", args),
    delete: (args) => doRequest("DELETE", args),

    withRequestInterceptor(fn) {
      requestInterceptors.push(fn);
      return client;
    },

    withResponseInterceptor(fn) {
      responseInterceptors.push(fn);
      return client;
    },

    withBearer(token) {
      getBearer = token;
      return client;
    },
  };

  return client;
}
