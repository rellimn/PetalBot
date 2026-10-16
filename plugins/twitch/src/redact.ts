/**
 * Twurple's HTTP errors quote the whole request URL, and token requests carry the client secret,
 * the refresh token or the OAuth code in their query. Everything the plugin logs about Twitch
 * passes through here first.
 */
const SECRET_PARAM = /\b(client_secret|refresh_token|access_token|code)=[^&\s"']*/gi;

export const redact = (text: string): string => text.replace(SECRET_PARAM, '$1=[redacted]');

/** An error's message, safe to log. */
export const errorText = (error: unknown): string =>
  redact(error instanceof Error ? error.message : String(error));
