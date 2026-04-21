export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const errors = {
  notImplemented: (what: string) =>
    new AppError('not_implemented', 501, `${what} is not implemented yet`),
  unauthorized: (message = 'Unauthorized') => new AppError('unauthorized', 401, message),
  forbidden: (message = 'Forbidden') => new AppError('forbidden', 403, message),
  mustChangePassword: () =>
    new AppError('must_change_password', 403, 'Password change required'),
  notFound: (what: string) => new AppError('not_found', 404, `${what} not found`),
  conflict: (message: string) => new AppError('conflict', 409, message),
  badRequest: (message: string, details?: unknown) =>
    new AppError('bad_request', 400, message, details),
  tooManyRequests: (message = 'Too many requests') =>
    new AppError('rate_limited', 429, message),
  internal: (message = 'Internal server error') => new AppError('internal', 500, message),
};
