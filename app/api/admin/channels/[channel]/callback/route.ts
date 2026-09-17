import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { saveChannelConnection, logEvent } from '@/lib/queries';
import { exchangeCode, identify, type OAuthChannel } from '@/lib/oauth/providers';
import { readOAuthHandshake, clearOAuthHandshake } from '@/lib/oauth/handshake';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/channels/:channel/callback — where the provider sends the
 * person back, with either a code or a refusal.
 *
 * This is a browser redirect, not an API call, so every outcome ends in a
 * redirect back to /admin carrying a message. Returning JSON here would leave
 * someone staring at a raw object in the address bar after clicking "Allow".
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const { channel: raw } = await params;
  const channel = (raw === 'x' || raw === 'linkedin' ? raw : null) as OAuthChannel | null;

  const back = (query: Record<string, string>) =>
    NextResponse.redirect(`${env.APP_URL}/admin?${new URLSearchParams(query)}`);

  if (!channel) return back({ connect_error: 'Unknown channel.' });

  try {
    const user = await requireUser();
    if (!user.is_admin) return back({ connect_error: 'Only an admin can connect accounts.' });

    const url = new URL(request.url);
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    // The person pressed Cancel, or the provider refused. Not a failure worth
    // a stack trace — it is a decision.
    if (error) {
      await clearOAuthHandshake(channel);
      return back({
        connect_error: `${label(channel)} did not authorise this: ${
          url.searchParams.get('error_description') ?? error
        }`,
      });
    }

    const handshake = await readOAuthHandshake(channel);
    if (!handshake) {
      return back({
        connect_error:
          'That authorisation took too long, or was started in a different browser. Try connecting again.',
      });
    }
    // The CSRF check. A code arriving with a state this browser did not
    // generate is someone else's authorisation being planted on this account.
    if (!code || state !== handshake.state) {
      await clearOAuthHandshake(channel);
      return back({ connect_error: 'That authorisation could not be verified. Try again.' });
    }

    const tokens = await exchangeCode(channel, code, handshake.verifier);
    const account = await identify(channel, tokens.accessToken);

    await saveChannelConnection({
      channel,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      accountLabel: account.label,
      authorUrn: account.authorUrn,
      connectedBy: user.id,
    });
    await clearOAuthHandshake(channel);

    // Records that it happened and what it can do — never the token itself.
    await logEvent({
      requestId: null,
      actor: user.email,
      step: 'channel_connected',
      ok: true,
      detail: {
        channel,
        account: account.label,
        scopes: tokens.scopes,
        // Worth knowing at a glance: no refresh token means every scheduled
        // post more than two hours out will fail until it is reconnected.
        refreshable: Boolean(tokens.refreshToken),
      },
    });

    return back({
      connected: channel,
      account: account.label,
      ...(tokens.refreshToken ? {} : { connect_warning: 'no refresh token was issued' }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return back({ connect_error: `Could not finish connecting ${label(channel)}: ${message}` });
  }
}

function label(channel: OAuthChannel): string {
  return channel === 'x' ? 'X' : 'LinkedIn';
}
