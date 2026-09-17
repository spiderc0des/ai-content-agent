import 'server-only';
import type { Channel } from '../schemas';
import {
  getChannelConnection,
  updateChannelTokens,
  markChannelInvalid,
  type ChannelConnection,
} from '../queries';
import { refreshTokens, type OAuthChannel } from '../oauth/providers';

/**
 * A usable access token for a channel, refreshed if it is about to die.
 *
 * X access tokens last two hours. Nothing about a publishing queue takes two
 * hours, but a *scheduled* post does: queue something for tomorrow morning and
 * the token that was valid when you scheduled it is long gone by the time the
 * worker picks it up. So the token is checked and refreshed at the point of
 * use, never at the point of queueing.
 */

/**
 * Refresh this far ahead of expiry.
 *
 * A token with forty seconds left passes an `expiresAt > now` check and then
 * expires mid-request, which surfaces as an unexplained 401 on one post in
 * every few hundred. Two minutes is comfortably longer than any call here.
 */
const REFRESH_MARGIN_MS = 120_000;

export type TokenOutcome =
  | { ok: true; accessToken: string; connection: ChannelConnection }
  | { ok: false; reason: string; needsReconnect: boolean };

export async function accessTokenFor(channel: Channel): Promise<TokenOutcome> {
  let connection: ChannelConnection | null;
  try {
    connection = await getChannelConnection(channel);
  } catch (err) {
    // Almost always TOKEN_ENCRYPTION_KEY having changed. Retrying will not
    // help, and saying so beats a decrypt stack trace in the queue.
    return {
      ok: false,
      needsReconnect: true,
      reason: `stored credentials could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (!connection) {
    return { ok: false, needsReconnect: true, reason: `no ${channel} account is connected` };
  }

  const expiring =
    connection.expiresAt !== null &&
    connection.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;

  if (!expiring) return { ok: true, accessToken: connection.accessToken, connection };

  if (!connection.refreshToken) {
    await markChannelInvalid(channel, 'the access token expired and there is no refresh token');
    return {
      ok: false,
      needsReconnect: true,
      reason:
        'the access token expired and no refresh token was issued — reconnect, making sure offline access is granted',
    };
  }

  try {
    const fresh = await refreshTokens(channel as OAuthChannel, connection.refreshToken);
    await updateChannelTokens(channel, {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
    });
    return { ok: true, accessToken: fresh.accessToken, connection: { ...connection, ...fresh } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A refresh token is revoked when someone removes the app, changes their
    // password, or the grant simply ages out. All of those need a human, so
    // the connection is flagged rather than retried every fifteen minutes.
    await markChannelInvalid(channel, reason);
    return { ok: false, needsReconnect: true, reason: `could not refresh the token — ${reason}` };
  }
}
