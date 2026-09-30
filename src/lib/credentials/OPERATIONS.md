# Credential broker — operator guide

What this module holds and how to run it. Design: `docs/adr/0006-credential-broker.md`.
The customer-side setup is `deploy/aws/README.md`.

## Environment variables

Read in exactly one place, `loadCredentialsConfig` (`src/lib/credentials/config.ts`).
None of them ever appears in a log line, error message, event, or API response.

| Variable | Required | Meaning |
|---|---|---|
| `ZENITH_OIDC_ISSUER` | production | Issuer URL, e.g. `https://app.tryzenith.cloud/api/oidc`. https only (http for localhost). Default when unset: `<request origin>/api/oidc` for the two public routes, but the token minter has no request, so it **must** be set wherever tokens are minted. |
| `ZENITH_OIDC_SIGNING_JWK` | one of | Private **RSA** JWK (RS256) as JSON, or base64 of that JSON. Local signer: fine for development and small installs. |
| `ZENITH_OIDC_KMS_KEY_ID` | one of | AWS KMS key id / ARN / alias, `RSA_2048`+ `SIGN_VERIFY`. Production: the private key never leaves KMS. |
| `ZENITH_OIDC_EXTRA_PUBLIC_JWKS` | rotation | JWKS (`{"keys":[…]}`), array, or single JWK of extra **public** keys to publish (next / previous). A private key here is refused. |
| `ZENITH_CONTROL_SIGNING_JWK` | one of | Private **Ed25519** JWK: signs capability grants (`typ zenith-grant+jwt`), runner jobs and machine requests. |
| `ZENITH_CONTROL_KMS_KEY_ID` | one of | KMS key `ECC_NIST_EDWARDS25519` alternative for the above (unverified against real KMS, see below). |
| `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` | rotation | Extra public Ed25519 keys accepted when verifying grants (and announced to agents). |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | KMS | Region hint for the default KMS client when the key id is not an ARN. |

Setting both the JWK and the KMS variable for the same key family is a
configuration error (the module refuses to guess).

The OIDC key and the control-plane key must be different keys. The loaders
enforce the algorithm of each (RS256 vs EdDSA), so one cannot be loaded as the
other.

## Generating keys

`generateSigningJwk(alg)` is a plain function (no scripts). From the repo root:

```bash
# OIDC issuer key (RS256). Prints the PRIVATE JWK on stdout, the public JWK on stderr.
npx tsx -e "import('./src/lib/credentials/signing/keygen.ts').then(async (m) => { const k = await m.generateSigningJwk('RS256', { kid: 'oidc-2026-09' }); console.log(m.serializePrivateJwk(k)); console.error('public:', JSON.stringify(k.publicJwk)); })"

# Control-plane key (Ed25519)
npx tsx -e "import('./src/lib/credentials/signing/keygen.ts').then(async (m) => { const k = await m.generateSigningJwk('EdDSA', { kid: 'cp-2026-09' }); console.log(m.serializePrivateJwk(k)); console.error('public:', JSON.stringify(k.publicJwk)); })"
```

Put the private JSON in the secret manager / hosting provider's encrypted
environment (`ZENITH_OIDC_SIGNING_JWK`, `ZENITH_CONTROL_SIGNING_JWK`). Never in
the repository, a manifest, a chat or a ticket. The `kid` is an RFC 7638
thumbprint unless you pass one; a readable one (`cp-2026-09`) helps rotations.

### KMS (production OIDC key)

```bash
aws kms create-key --key-spec RSA_2048 --key-usage SIGN_VERIFY \
  --description "Zenith OIDC issuer key" --tags TagKey=zenith:purpose,TagValue=oidc-issuer
aws kms create-alias --alias-name alias/zenith-oidc --target-key-id <key-id>
```

Grant the Zenith execution role `kms:Sign` and `kms:GetPublicKey` on that key
and nothing else (no `kms:Decrypt`, no key administration). Then set
`ZENITH_OIDC_KMS_KEY_ID=alias/zenith-oidc`. `KmsSigner` verifies every signature
against the key's published public half before returning it, so a wrong key
spec or a repointed alias fails loudly instead of minting tokens nobody accepts.

## Rotation

Relying parties (AWS IAM) cache the JWKS, so a new key must be published
**before** it signs.

1. Generate the next key. Add its public JWK to `ZENITH_OIDC_EXTRA_PUBLIC_JWKS`
   and deploy. `GET /api/oidc/jwks` now lists current + next.
2. Wait ≥ 24 h (the JWKS is cached for 5 minutes by Zenith's CDN headers, but
   IAM's own cache is not under our control).
3. Swap: make the next key the signer (`ZENITH_OIDC_SIGNING_JWK` / KMS id) and
   move the old public key into `ZENITH_OIDC_EXTRA_PUBLIC_JWKS`.
4. After ≥ 1 hour (tokens live ≤ 5 minutes, sessions ≤ 1 hour) remove the old key.

The control-plane key follows the same shape with
`ZENITH_CONTROL_EXTRA_PUBLIC_JWKS`; agents pin the public key and learn about
rotations through their heartbeat (`nextKeys`, ≥ 24 h ahead; RUNNER-PROTOCOL §1).

**Suspected compromise of the OIDC key:** rotate immediately (skip the wait),
then delete and recreate the IAM OIDC provider entries or tighten trust
policies on affected customer accounts if tokens could have been forged. A
forged token is bounded by the customer's trust policy: it would need the exact
`sub` and audience, and reaches only the observe/deploy roles' permissions.

## Public endpoints

`GET /api/oidc/.well-known/openid-configuration` and `GET /api/oidc/jwks` are
public and unauthenticated by design — AWS fetches them anonymously. They serve
metadata and public keys only. **The deployment's session middleware must let
both paths through** (`src/middleware.ts` / `isPublicPath`), otherwise IAM sees
a 401/redirect and cannot create or use the OIDC provider. Verify from outside:

```bash
curl -s https://<host>/api/oidc/.well-known/openid-configuration | jq .
curl -s https://<host>/api/oidc/jwks | jq '.keys[] | {kid, alg, kty}'
```

## What is and is not verified

Verified by tests in this repository: signer behaviour (local and via
`aws-sdk-client-mock` for KMS), JWKS/discovery routes, token claims, grant
verification, STS request parameters, session invalidation, leak scanning.

Not verified against real services (no AWS credentials in CI): AWS IAM actually
accepting our tokens and the shipped trust/permission policies; real KMS
`Sign`/`GetPublicKey` (the Ed25519 `ED25519_SHA_512` control-plane path in
particular); ES256 through KMS (unit-tested only via the DER→raw conversion).
The first real connection is the acceptance test — see `deploy/aws/README.md`.
