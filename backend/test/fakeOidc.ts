import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

/*
 * Minimal OpenID provider for tests: discovery, JWKS, authorize (logs the
 * configured user in immediately), token (authorization_code with PKCE,
 * refresh_token), end_session. Tokens are RS256-signed like Keycloak's.
 */

export interface FakeUser {
  sub: string;
  name: string;
  email: string;
  roles: string[];
}

export interface FakeOidc {
  issuer: string;
  user: FakeUser;
  /** When true, every refresh is rejected with invalid_grant (the user's session was ended in the IdP). */
  revokeAll: boolean;
  /** Access token lifetime handed out (seconds). */
  expiresIn: number;
  tokenRequests: Array<Record<string, string>>;
  close(): Promise<void>;
}

/**
 * `publicBase` makes the provider advertise an issuer on another origin than
 * the one it listens on (like Keycloak behind KC_HOSTNAME in Docker Compose);
 * `internalBase` is then where it is actually reachable.
 */
export async function startFakeOidc(clientId: string, clientSecret: string, opts: { publicBase?: string } = {}): Promise<FakeOidc & { internalBase: string }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
  const refresh = new Map<string, string>(); // token -> sub
  let server: Server;

  const state: FakeOidc & { internalBase: string } = {
    internalBase: "",
    issuer: "",
    user: { sub: "u-1", name: "Ada Lovelace", email: "ada@example.com", roles: ["viewer", "default-roles-test"] },
    revokeAll: false,
    expiresIn: 300,
    tokenRequests: [],
    close: () => new Promise((r) => server.close(() => r())),
  };

  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(state.issuer).setIssuedAt().setExpirationTime("5m").sign(privateKey);

  async function tokens(nonce?: string) {
    const u = state.user;
    const rt = randomBytes(16).toString("hex");
    refresh.set(rt, u.sub);
    const id = await sign({ sub: u.sub, aud: clientId, azp: clientId, name: u.name, email: u.email, roles: u.roles, ...(nonce ? { nonce } : {}) });
    const access = await sign({ sub: u.sub, aud: "account", azp: clientId, realm_access: { roles: u.roles } });
    return { access_token: access, id_token: id, refresh_token: rt, token_type: "Bearer", expires_in: state.expiresIn };
  }

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.internalBase);
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname.replace("/realms/test", "");
    if (path === "/.well-known/openid-configuration") {
      return send(200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/auth`,
        token_endpoint: `${state.issuer}/token`,
        jwks_uri: `${state.issuer}/certs`,
        end_session_endpoint: `${state.issuer}/logout`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/certs") return send(200, { keys: [jwk] });
    if (path === "/auth") {
      const q = url.searchParams;
      if (q.get("client_id") !== clientId || q.get("code_challenge_method") !== "S256") return send(400, { error: "invalid_request" });
      const code = randomBytes(8).toString("hex");
      codes.set(code, { nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri") ?? "" });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      back.searchParams.set("iss", state.issuer);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (path === "/token") {
      const body = new URLSearchParams(await new Promise<string>((r) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => r(b));
      }));
      const params = Object.fromEntries(body);
      state.tokenRequests.push(params);
      // RFC 6749 §2.3.1: id and secret are form-urlencoded before base64.
      const [id, secret] = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64")
        .toString()
        .split(":")
        .map((x) => decodeURIComponent(x.replace(/\+/g, " ")));
      if (id !== clientId || secret !== clientSecret) return send(401, { error: "invalid_client" });
      if (params.grant_type === "authorization_code") {
        const c = codes.get(params.code ?? "");
        codes.delete(params.code ?? "");
        const challenge = createHash("sha256").update(params.code_verifier ?? "").digest("base64url");
        if (!c) return send(400, { error: "invalid_grant", error_description: "unknown code" });
        if (c.challenge !== challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        if (c.redirectUri !== params.redirect_uri) return send(400, { error: "invalid_grant", error_description: `redirect_uri mismatch: ${params.redirect_uri}` });
        return send(200, await tokens(c.nonce));
      }
      if (params.grant_type === "refresh_token") {
        const rt = params.refresh_token ?? "";
        if (!refresh.has(rt) || state.revokeAll) return send(400, { error: "invalid_grant", error_description: "Session not active" });
        return send(200, await tokens());
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    if (path === "/logout") return send(200, { ok: true });
    send(404, { error: "not_found" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.internalBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  state.issuer = `${opts.publicBase ?? state.internalBase}/realms/test`;
  return state;
}
