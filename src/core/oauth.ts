// Docs: docs/templates/inbound-inbox.md
// MailKite OAuth 2.1 + PKCE primitives — issuer-bound, framework/runtime agnostic (Web Crypto +
// fetch only, so identical on Node and Cloudflare Workers).
//
// Why OAuth: this inbox renders on a PUBLIC URL. It must show each visitor only mail for the
// domains THEY own, so visitors sign into their own MailKite account and the app acts with their
// short-lived token — never a shared API key. MailKite's auth server is a PUBLIC client (no
// secret) and supports RFC 7591 dynamic registration, so the app self-registers at runtime and
// needs no client id/secret env var.

export const DEFAULT_ISSUER = "https://mcp.mailkite.dev";
const SCOPE = "mcp";
const CLIENT_NAME = "MailKite Inbound Inbox";

export interface OAuthEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export const redirectUri = (origin: string): string => `${origin}/auth/callback`;

/** An OAuth helper bound to one issuer, with per-process discovery + per-origin registration caches. */
export class OAuth {
  private endpoints?: Promise<OAuthEndpoints>;
  private clientIds = new Map<string, Promise<string>>();

  constructor(private issuer: string = DEFAULT_ISSUER) {
    this.issuer = issuer.replace(/\/$/, "");
  }

  discover(): Promise<OAuthEndpoints> {
    this.endpoints ??= fetch(`${this.issuer}/.well-known/oauth-authorization-server`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`OAuth discovery failed (${r.status})`);
        return (await r.json()) as OAuthEndpoints;
      })
      .catch((e) => {
        this.endpoints = undefined;
        throw e;
      });
    return this.endpoints;
  }

  registerClient(origin: string): Promise<string> {
    let p = this.clientIds.get(origin);
    if (!p) {
      p = (async () => {
        const { registration_endpoint } = await this.discover();
        const res = await fetch(registration_endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: CLIENT_NAME,
            redirect_uris: [redirectUri(origin)],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
        });
        if (!res.ok) throw new Error(`OAuth client registration failed (${res.status})`);
        return ((await res.json()) as { client_id: string }).client_id;
      })().catch((e) => {
        this.clientIds.delete(origin);
        throw e;
      });
      this.clientIds.set(origin, p);
    }
    return p;
  }

  async authorizeUrl(origin: string, clientId: string, challenge: string, state: string): Promise<string> {
    const { authorization_endpoint } = await this.discover();
    const u = new URL(authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri(origin));
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", state);
    u.searchParams.set("scope", SCOPE);
    return u.toString();
  }

  private async postToken(params: Record<string, string>): Promise<TokenResponse> {
    const { token_endpoint } = await this.discover();
    const res = await fetch(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return (await res.json()) as TokenResponse;
  }

  exchangeCode(args: { code: string; verifier: string; origin: string; clientId: string }): Promise<TokenResponse> {
    return this.postToken({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: redirectUri(args.origin),
      client_id: args.clientId,
      code_verifier: args.verifier,
    });
  }

  refreshTokens(args: { refreshToken: string; clientId: string }): Promise<TokenResponse> {
    return this.postToken({ grant_type: "refresh_token", refresh_token: args.refreshToken, client_id: args.clientId });
  }

  async revokeToken(refreshToken: string): Promise<void> {
    const { revocation_endpoint } = await this.discover();
    if (!revocation_endpoint) return;
    await fetch(revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    }).catch(() => {});
  }
}

// ---- PKCE + state (Web Crypto) -----------------------------------------------
const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const randomB64url = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const randomState = (): string => randomB64url(24);

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomB64url(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}
