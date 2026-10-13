import { CommunityError } from './communityValidation.js';

const encoder = new TextEncoder();
let cache;
function decode(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
}

// Never trust an email header or an unsigned Access assertion. Validate at the
// API as well as the edge so workers.dev and direct API calls cannot bypass login.
export async function adminIdentity(request, env, suppliedKeys) {
  const issuer = String(env.ADMIN_ACCESS_ISSUER || '').replace(/\/$/, '');
  const audience = env.ADMIN_ACCESS_AUD;
  const allowed = String(env.ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience || !allowed.length) {
    throw new CommunityError(503, 'Admin sign-in has not been configured yet.');
  }
  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion') || '';
    if (token.length > 16000) throw new Error('Invalid token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || claims.iss !== issuer ||
        !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience) ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.iat) || claims.iat > now + 60 ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60)) ||
        typeof claims.email !== 'string' || !allowed.includes(claims.email.toLowerCase())) throw new Error('Invalid claims');
    let keys = suppliedKeys;
    if (!keys) {
      if (!cache || cache.issuer !== issuer || cache.expires <= Date.now()) {
        const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
        if (!response.ok) throw new Error('Key fetch failed');
        cache = { issuer, keys: (await response.json()).keys, expires: Date.now() + 300000 };
      }
      keys = cache.keys;
    }
    const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) throw new Error('Unknown key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))) throw new Error('Invalid signature');
    return claims.email.toLowerCase();
  } catch {
    throw new CommunityError(401, 'Sign in with an authorized admin account.');
  }
}
