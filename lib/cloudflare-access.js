import {boundedText} from './safety.js';

export function cloudflareAccessConfig(env){
  if(!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(env.CF_ACCESS_TEAM||'')
    ||typeof env.CF_ACCESS_AUD!=='string'||!env.CF_ACCESS_AUD||env.CF_ACCESS_AUD.length>256
    ||typeof env.CF_ACCESS_OWNER_EMAIL!=='string'||!/^\S+@\S+\.\S+$/.test(env.CF_ACCESS_OWNER_EMAIL)
    ||env.CLOUDFLARE_PRIVATE_READY!=='true')return null;
  let origin;try{origin=new URL(env.CF_APP_ORIGIN)}catch{return null}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.port||origin.search||origin.hash
    ||origin.pathname!=='/'||origin.hostname==='localhost'||/^[\d.]+$/.test(origin.hostname))return null;
  return {issuer:`https://${env.CF_ACCESS_TEAM}.cloudflareaccess.com`,audience:env.CF_ACCESS_AUD,
    ownerEmail:env.CF_ACCESS_OWNER_EMAIL.toLowerCase(),ownerSub:env.CF_ACCESS_OWNER_SUB||'',origin:origin.origin};
}

function accessDecode(part){
  if(!/^[A-Za-z0-9_-]+$/.test(part))throw Error('invalid');
  const raw=atob(part.replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}

export function createCloudflareAccessVerifier({fetcher=fetch,clock=Date.now}={}){
  let cached=null,pending=null,lastAttempt={issuer:'',at:-Infinity};
  async function keysFor(config,kid){
    const now=clock();
    if(cached?.issuer===config.issuer&&cached.until>now&&cached.keys.has(kid))return cached.keys;
    if(pending)return pending.issuer===config.issuer?pending.promise:null;
    if(lastAttempt.issuer===config.issuer&&now-lastAttempt.at<30000)return null;
    lastAttempt={issuer:config.issuer,at:now};
    const promise=(async()=>{
      try{
        const response=await fetcher(config.issuer+'/cdn-cgi/access/certs',{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
        if(!response.ok){await response.body?.cancel();return null}
        const data=JSON.parse(await boundedText(response,32768));
        if(!Array.isArray(data.keys)||data.keys.length<1||data.keys.length>16)return null;
        const keys=new Map();
        for(const jwk of data.keys){
          if(jwk.kty!=='RSA'||typeof jwk.kid!=='string'||jwk.kid.length>128||jwk.alg&&jwk.alg!=='RS256'
            ||jwk.use&&jwk.use!=='sig'||typeof jwk.n!=='string'||jwk.n.length<342||jwk.n.length>1024||jwk.e!=='AQAB')continue;
          keys.set(jwk.kid,await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']));
        }
        cached={issuer:config.issuer,until:now+15*60000,keys};return keys;
      }catch{return null}
    })();
    pending={issuer:config.issuer,promise};
    try{return await promise}finally{pending=null}
  }
  return async function verifyOwner(request,env){
    const config=cloudflareAccessConfig(env);if(!config)return {ok:false,configured:false};
    if(new URL(request.url).origin!==config.origin)return {ok:false,configured:true};
    const token=request.headers.get('Cf-Access-Jwt-Assertion');
    if(!token||token.length>12000)return {ok:false,configured:true};
    try{
      const pieces=token.split('.');if(pieces.length!==3)return {ok:false,configured:true};
      const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(accessDecode(pieces[0])));
      const claims=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(accessDecode(pieces[1])));
      const now=Math.floor(clock()/1000);
      if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>128||header.crit
        ||claims.iss!==config.issuer||!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes(config.audience)
        ||!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+30
        ||claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now+30)
        ||typeof claims.email!=='string'||claims.email.toLowerCase()!==config.ownerEmail
        ||typeof claims.sub!=='string'||!claims.sub||config.ownerSub&&claims.sub!==config.ownerSub)return {ok:false,configured:true};
      const keys=await keysFor(config,header.kid),key=keys?.get(header.kid);
      if(!key)return {ok:false,configured:true};
      const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,accessDecode(pieces[2]),new TextEncoder().encode(pieces[0]+'.'+pieces[1]));
      return {ok,configured:true};
    }catch{return {ok:false,configured:true}}
  };
}
