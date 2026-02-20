export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
}

export interface ErrorResponseBody {
  code: string;
  message: string;
}

export const ok = <T>(body: T): HttpResponse<T> => ({
  status: 200,
  body,
});

export const created = <T>(body: T): HttpResponse<T> => ({
  status: 201,
  body,
});

export const failure = (
  status: number,
  code: string,
  message: string
): HttpResponse<ErrorResponseBody> => ({
  status,
  body: {
    code,
    message,
  },
});
