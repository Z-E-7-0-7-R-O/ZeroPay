/**
 * src/utils/http.ts
 * Resilient HTTP client module equipped with exponential backoff and retry capabilities.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';

export interface IRetryOptions {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  retryCondition?: (error: AxiosError) => boolean;
}

export class HttpClient {
  private client: AxiosInstance;
  private defaultRetryOptions: Required<IRetryOptions>;

  constructor(baseConfig?: AxiosRequestConfig, retryOptions?: IRetryOptions) {
    this.client = axios.create({
      timeout: 10000,
      ...baseConfig,
    });

    this.defaultRetryOptions = {
      retries: retryOptions?.retries ?? 3,
      initialDelayMs: retryOptions?.initialDelayMs ?? 1000,
      maxDelayMs: retryOptions?.maxDelayMs ?? 10000,
      backoffFactor: retryOptions?.backoffFactor ?? 2,
      retryCondition: retryOptions?.retryCondition ?? this.defaultRetryCondition,
    };
  }

  /**
   * Evaluates whether an HTTP error constitutes a transient fault eligible for retry.
   */
  private defaultRetryCondition(error: AxiosError): boolean {
    // Retry on network-level drops (no response payload received)
    if (!error.response) {
      return true;
    }

    const status = error.response.status;

    // Retry on HTTP 429 (Too Many Requests) or HTTP 5xx (Internal Server Errors)
    return status === 429 || (status >= 500 && status <= 599);
  }

  /**
   * Halts execution asynchronously for the specified millisecond duration.
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Executes an HTTP request enclosed within an exponential backoff loop.
   */
  public async request<T = unknown>(
    config: AxiosRequestConfig,
    options?: IRetryOptions
  ): Promise<AxiosResponse<T>> {
    const mergedOptions: Required<IRetryOptions> = {
      retries: options?.retries ?? this.defaultRetryOptions.retries,
      initialDelayMs: options?.initialDelayMs ?? this.defaultRetryOptions.initialDelayMs,
      maxDelayMs: options?.maxDelayMs ?? this.defaultRetryOptions.maxDelayMs,
      backoffFactor: options?.backoffFactor ?? this.defaultRetryOptions.backoffFactor,
      retryCondition: options?.retryCondition ?? this.defaultRetryOptions.retryCondition,
    };

    let attempt = 0;
    let delay = mergedOptions.initialDelayMs;

    while (attempt <= mergedOptions.retries) {
      try {
        return await this.client.request<T>(config);
      } catch (error) {
        const axiosError = error as AxiosError;
        attempt++;

        // Terminate retry loop if threshold is reached or condition fails
        if (attempt > mergedOptions.retries || !mergedOptions.retryCondition(axiosError)) {
          throw error;
        }

        // Calculate next exponential backoff delay capped at maxDelayMs
        const currentDelay = Math.min(delay, mergedOptions.maxDelayMs);
        await this.sleep(currentDelay);
        delay *= mergedOptions.backoffFactor;
      }
    }

    throw new Error('Maximum request retry threshold exceeded without resolution.');
  }

  /**
   * Utility helper for HTTP GET requests.
   */
  public async get<T = unknown>(
    url: string,
    config?: AxiosRequestConfig,
    options?: IRetryOptions
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url }, options);
  }

  /**
   * Utility helper for HTTP POST requests.
   */
  public async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
    options?: IRetryOptions
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'POST', url, data }, options);
  }
}