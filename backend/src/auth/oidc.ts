import * as client from "openid-client";

/*
 * Thin wrapper over openid-client for a confidential Keycloak client using
 * the authorization code flow with PKCE, state and nonce.
 */

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
}

export interface LoginStart {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

export interface Tokens {
  sub: string;
  name: string;
  email: string | null;
  roles: string[];
  idToken: string | null;
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export class OidcClient {
  private cfg: Promise<client.Configuration> | null = null;

  constructor(private readonly s: OidcSettings) {}

  /** Discovery is lazy and retried on the next call if it fails (Keycloak may start after us). */
  private config(): Promise<client.Configuration> {
    if (!this.cfg) {
      // Plain http is only acceptable for a local/dev Keycloak; production issuers should be https.
      const execute = this.s.issuer.startsWith("http://") ? [client.allowInsecureRequests] : [];
      this.cfg = client
        .discovery(new URL(this.s.issuer), this.s.clientId, undefined, client.ClientSecretBasic(this.s.clientSecret), { execute })
        .catch((err) => {
          this.cfg = null;
          throw new Error(`cannot reach the identity provider at ${this.s.issuer}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    return this.cfg;
  }

  async startLogin(): Promise<LoginStart> {
    const cfg = await this.config();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(cfg, {
      redirect_uri: this.s.redirectUri,
      scope: "openid profile email",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url: url.href, state, nonce, verifier };
  }

  /** Exchanges the code from the callback URL; validates state, nonce, PKCE and the ID token. */
  async finishLogin(callbackUrl: URL, checks: { state: string; nonce: string; verifier: string }): Promise<Tokens> {
    const cfg = await this.config();
    const res = await client.authorizationCodeGrant(cfg, callbackUrl, {
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    return toTokens(res);
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    const cfg = await this.config();
    return toTokens(await client.refreshTokenGrant(cfg, refreshToken));
  }

  async endSessionUrl(idTokenHint: string | null): Promise<string | null> {
    try {
      const cfg = await this.config();
      const params: Record<string, string> = { post_logout_redirect_uri: this.s.postLogoutRedirectUri, client_id: this.s.clientId };
      if (idTokenHint) params.id_token_hint = idTokenHint;
      return client.buildEndSessionUrl(cfg, params).href;
    } catch {
      return null; // provider has no end_session_endpoint or is unreachable: local logout only
    }
  }
}

type TokenResponse = Awaited<ReturnType<typeof client.refreshTokenGrant>>;

function toTokens(res: TokenResponse): Tokens {
  const claims = (res.claims() ?? {}) as Record<string, unknown>;
  const sub = String(claims.sub ?? "");
  if (!sub) throw new Error("identity provider returned no subject (is the openid scope enabled?)");
  return {
    sub,
    name: String(claims.name ?? claims.preferred_username ?? claims.email ?? sub),
    email: typeof claims.email === "string" ? claims.email : null,
    roles: rolesFrom(claims, res.access_token),
    idToken: res.id_token ?? null,
    refreshToken: res.refresh_token ?? null,
    expiresIn: typeof res.expires_in === "number" ? res.expires_in : 300,
  };
}

/**
 * Realm roles: the `roles` claim our realm's client mapper adds to the ID
 * token, else Keycloak's default `realm_access.roles` from the access token
 * (received directly from the token endpoint over the back channel).
 */
export function rolesFrom(idClaims: Record<string, unknown>, accessToken: string | undefined): string[] {
  const fromId = idClaims.roles;
  if (Array.isArray(fromId)) return fromId.map(String);
  const realm = (idClaims.realm_access as { roles?: unknown } | undefined)?.roles;
  if (Array.isArray(realm)) return realm.map(String);
  if (accessToken) {
    try {
      const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        realm_access?: { roles?: unknown };
      };
      if (Array.isArray(payload.realm_access?.roles)) return payload.realm_access!.roles.map(String);
    } catch {
      // opaque access token: no roles
    }
  }
  return [];
}
