import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { disconnectChannel, listChannelConnections, logEvent } from '@/lib/queries';
import { errorResponse } from '@/lib/api-helpers';
import { createPkce, authorizeUrl, type OAuthChannel } from '@/lib/oauth/providers';
import { xConfigured, linkedinConfigured } from '@/lib/env';
import { setOAuthHandshake, clearOAuthHandshake } from '@/lib/oauth/handshake';

export const dynamic = 'force-dynamic';

const CHANNELS: OAuthChannel[] = ['x', 'linkedin'];

function parseChannel(value: string): OAuthChannel | null {
  return CHANNELS.includes(value as OAuthChannel) ? (value as OAuthChannel) : null;
}

export async function GET() {
  try {
    await requireUser();
    return NextResponse.json({ connections: await listChannelConnections() });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/admin/channels/:channel — begin the OAuth handshake.
 *
 * Returns the provider's authorize URL rather than redirecting, so the page
 * can open it itself and keep the admin page where it was. The verifier and
 * the state go into a short-lived httpOnly cookie: PKCE's verifier must not
 * reach the browser's JavaScript, and `state` is only CSRF protection if the
 * value the callback compares against was not supplied by the caller.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const { channel: raw } = await params;
  try {
    const user = await requireUser();
    if (!user.is_admin) {
      return NextResponse.json({ error: 'Only an admin can connect accounts.' }, { status: 403 });
    }
    const channel = parseChannel(raw);
    if (!channel) return NextResponse.json({ error: 'Unknown channel.' }, { status: 404 });

    const configured = channel === 'x' ? xConfigured : linkedinConfigured;
    if (!configured) {
      return NextResponse.json(
        {
          error:
            `${channel === 'x' ? 'X' : 'LinkedIn'} is not set up yet. Add its client id and secret ` +
            '(and TOKEN_ENCRYPTION_KEY) to the environment, then restart.',
        },
        { status: 409 },
      );
    }

    const pkce = createPkce();
    const state = crypto.randomUUID();
    await setOAuthHandshake(channel, { state, verifier: pkce.verifier });

    return NextResponse.json({ url: authorizeUrl(channel, state, pkce) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const { channel: raw } = await params;
  try {
    const user = await requireUser();
    if (!user.is_admin) {
      return NextResponse.json({ error: 'Only an admin can disconnect accounts.' }, { status: 403 });
    }
    const channel = parseChannel(raw);
    if (!channel) return NextResponse.json({ error: 'Unknown channel.' }, { status: 404 });

    const removed = await disconnectChannel(channel);
    await clearOAuthHandshake(channel);

    // The event records THAT it was disconnected, never the token. `events`
    // is append-only, so a credential written there could never be removed.
    await logEvent({
      requestId: null,
      actor: user.email,
      step: 'channel_disconnected',
      ok: true,
      detail: { channel, was_connected: removed },
    });

    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    return errorResponse(err);
  }
}
