import { CommunityError } from './communityValidation.js';

const encoder = new TextEncoder();
let appleKeyCache;

export async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function decodePart(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), c => c.charCodeAt(0));
}

async function appleKeys(force = false) {
  if (!force && appleKeyCache && appleKeyCache.expires > Date.now()) return appleKeyCache.keys;
  const response = await fetch('https://appleid.apple.com/auth/keys');
  if (!response.ok) throw new CommunityError(503, 'Apple sign-in is temporarily unavailable.');
  const { keys } = await response.json();
  if (!Array.isArray(keys)) throw new CommunityError(503, 'Apple sign-in is temporarily unavailable.');
  appleKeyCache = { keys, expires: Date.now() + 3600_000 };
  return keys;
}

export async function verifyAppleIdentity(token, nonce, audience, suppliedKeys) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
        claims.iss !== 'https://appleid.apple.com' || claims.aud !== audience ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.iat < now - 600 ||
        claims.nonce !== await sha256(nonce)) throw new Error('Invalid claims');
    let keys = suppliedKeys ?? await appleKeys();
    let jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256');
    if (!jwk && !suppliedKeys) {
      keys = await appleKeys(true);
      jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256');
    }
    if (!jwk) throw new Error('Unknown signing key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodePart(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error('Invalid signature');
    return claims.sub;
  } catch (error) {
    if (error instanceof CommunityError) throw error;
    throw new CommunityError(401, 'Please sign in with Apple again.');
  }
}

export async function communityUser(request, env, required = true) {
  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (token) {
    const row = await env.COMMUNITY_DB.prepare(
      'SELECT u.id, u.handle FROM community_sessions s JOIN community_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?'
    ).bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
    if (row) return row;
  }
  if (required) throw new CommunityError(401, 'Please sign in with Apple to continue.');
  return null;
}
