export type Result<T, E> =
  | Readonly<{
      ok: true;
      value: T;
    }>
  | Readonly<{
      ok: false;
      error: E;
    }>;

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const mapResult = <T, U, E>(result: Result<T, E>, mapper: (value: T) => U): Result<U, E> =>
  result.ok ? ok(mapper(result.value)) : result;

export const mapError = <T, E, F>(result: Result<T, E>, mapper: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(mapper(result.error));
