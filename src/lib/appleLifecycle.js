import { CommunityError } from './communityValidation.js';
import { appleKeys, decodePart, verifyAppleIdentity } from './communityAuth.js';
const encoder=new TextEncoder();
const epoch=()=>Math.floor(Date.now()/1000);
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const encode=value=>b64(encoder.encode(JSON.stringify(value)));
export const appleConfigured=env=>Boolean(env.APPLE_PRIVATE_KEY && env.APPLE_KEY_ID && env.APPLE_TEAM_ID && env.APPLE_TOKEN_ENCRYPTION_KEY);
export function validateAppleCode(body) {
  if(body.authorizationCode!==undefined && (typeof body.authorizationCode!=='string'||!body.authorizationCode||body.authorizationCode.length>4096)) throw new CommunityError(400,'Invalid Apple authorization code.');
}
export async function appleClientSecret(env) {
  if(!appleConfigured(env)) throw new CommunityError(503,'Apple token revocation is not configured.','APPLE_NOT_CONFIGURED');
  try {
    const pem=env.APPLE_PRIVATE_KEY.replace(/\\n/g,'\n').replace(/-----[^-]+-----|\s/g,'');
    const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
    const header=encode({alg:'ES256',kid:env.APPLE_KEY_ID}), claims=encode({iss:env.APPLE_TEAM_ID,iat:epoch(),exp:epoch()+900,aud:'https://appleid.apple.com',sub:env.APPLE_CLIENT_ID||'com.learnalert.app'});
    const input=header+'.'+claims;
    return input+'.'+b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(input)));
  } catch {throw new CommunityError(503,'Apple authentication configuration needs attention.','APPLE_NOT_CONFIGURED');}
}
async function cipherKey(env) {
  try {
    const bytes=decodePart(env.APPLE_TOKEN_ENCRYPTION_KEY);
    if(bytes.length!==32) throw new Error();
    return await crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
  } catch {throw new CommunityError(503,'Apple token encryption is not configured correctly.','APPLE_NOT_CONFIGURED');}
}
export async function encryptAppleToken(env,token) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},await cipherKey(env),encoder.encode(token));
  return b64(iv)+'.'+b64(data);
}
export async function decryptAppleToken(env,value) {
  const [iv,data]=value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decodePart(iv)},await cipherKey(env),decodePart(data)));
}
export async function exchangeAppleCode(env,body,expectedSubject) {
  validateAppleCode(body);
  const secret=await appleClientSecret(env);
  let response;
  try {response=await fetch('https://appleid.apple.com/auth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.APPLE_CLIENT_ID||'com.learnalert.app',client_secret:secret,code:body.authorizationCode,grant_type:'authorization_code'}),signal:AbortSignal.timeout(10000)});}
  catch {throw new CommunityError(503,'Apple is unavailable. Try again shortly.','APPLE_UNAVAILABLE');}
  if(!response.ok) {
    const failure=await response.json().catch(()=>({}));
    if(failure.error==='invalid_client')throw new CommunityError(503,'Apple authentication configuration needs attention.','APPLE_NOT_CONFIGURED');
    throw new CommunityError(response.status>=500?503:401,'Apple authorization could not complete. Sign in again.','APPLE_AUTH_CODE_INVALID');
  }
  let tokens; try {tokens=await response.json();} catch {throw new CommunityError(503,'Apple returned an invalid response.','APPLE_UNAVAILABLE');}
  if(typeof tokens.id_token!=='string' || typeof tokens.refresh_token!=='string' || !tokens.refresh_token || tokens.refresh_token.length>12000) throw new CommunityError(503,'Apple returned an incomplete token response.','APPLE_UNAVAILABLE');
  const subject=await verifyAppleIdentity(tokens.id_token,body.nonce,env.APPLE_CLIENT_ID||'com.learnalert.app');
  if(subject!==expectedSubject) throw new CommunityError(401,'Reauthenticate with the Apple account used for this community profile.','APPLE_IDENTITY_MISMATCH');
  return encryptAppleToken(env,tokens.refresh_token);
}
export async function revokeAppleJob(env,job) {
  if(!appleConfigured(env)) return false;
  try {
    const token=await decryptAppleToken(env,job.encrypted_token);
    const response=await fetch('https://appleid.apple.com/auth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.APPLE_CLIENT_ID||'com.learnalert.app',client_secret:await appleClientSecret(env),token,token_type_hint:'refresh_token'}),signal:AbortSignal.timeout(10000)});
    if(response.status!==200) return false;
    await env.COMMUNITY_DB.prepare('DELETE FROM community_apple_revocations WHERE id=?').bind(job.id).run(); return true;
  } catch {return false;}
}
export async function deleteCommunityAccount(db,id,queueRevocation=true) {
  const jobID=crypto.randomUUID();
  const statements=[];
  if(queueRevocation)statements.push(db.prepare('INSERT INTO community_apple_revocations(id,encrypted_token,created_at) SELECT ?,encrypted_token,? FROM community_apple_tokens WHERE user_id=?').bind(jobID,epoch(),id));
  statements.push(
    db.prepare('INSERT OR IGNORE INTO community_deleted_objects(object_key,created_at) SELECT m.object_key,? FROM community_media m JOIN community_decks d ON d.id=m.deck_id WHERE d.owner_id=?').bind(epoch(),id),
    db.prepare('DELETE FROM community_reports WHERE user_id=?').bind(id),
    db.prepare('DELETE FROM community_decks WHERE owner_id=?').bind(id),
    db.prepare('DELETE FROM community_users WHERE id=?').bind(id));
  await db.batch(statements);
  return db.prepare('SELECT id,encrypted_token FROM community_apple_revocations WHERE id=?').bind(jobID).first();
}
export async function verifyAppleEvent(token,audience,suppliedKeys) {
  try {
    if(typeof token!=='string'||token.length>20000)throw new Error();
    const parts=token.split('.'); if(parts.length!==3)throw new Error();
    const header=JSON.parse(new TextDecoder().decode(decodePart(parts[0]))), claims=JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    if(header.alg!=='RS256'||typeof header.kid!=='string'||claims.iss!=='https://appleid.apple.com'||claims.aud!==audience||!Number.isFinite(claims.iat)||claims.iat>epoch()+60||claims.iat<epoch()-7*86400||typeof claims.jti!=='string'||!claims.jti||claims.jti.length>255||(claims.exp!==undefined&&(!Number.isFinite(claims.exp)||claims.exp<=epoch())))throw new Error();
    let keys=suppliedKeys||await appleKeys(); let jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&k.alg==='RS256');
    if(!jwk&&!suppliedKeys){keys=await appleKeys(true);jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&k.alg==='RS256');} if(!jwk)throw new Error();
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decodePart(parts[2]),encoder.encode(parts[0]+'.'+parts[1])))throw new Error();
    const event=typeof claims.events==='string'?JSON.parse(claims.events):claims.events;
    if(!event||typeof event.sub!=='string'||!event.sub||event.sub.length>255||!['consent-revoked','account-deleted','email-enabled','email-disabled'].includes(event.type)||!Number.isFinite(event.event_time)||event.event_time>epoch()+60)throw new Error();
    return {id:claims.jti,event};
  }catch(error){if(error instanceof CommunityError)throw error;throw new CommunityError(401,'Invalid Apple notification.','APPLE_EVENT_INVALID');}
}
