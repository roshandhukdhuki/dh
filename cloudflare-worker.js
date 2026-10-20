import {createWorker} from './worker.js';
import {createCloudflareAccessVerifier,cloudflareAccessConfig} from './lib/cloudflare-access.js';
import {runTick} from './lib/engine.js';

function nativeEnvironment(env){return {...env,RUN_PROFILE:'cloudflare-free',EXTERNAL_SCHEDULER_ENABLED:'false',LOCAL_DEV:'false',
  ACCESS_MODE:'platform',PRIVATE_DEPLOYMENT_CONFIRMED:'true'};}
function nativeDenied(status){return new Response(JSON.stringify({error:status===503?'private_cloudflare_configuration_required':'owner_access_required'}),
  {status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"}});}

export function createCloudflareWorker({sourceFetcher=fetch,jwksFetcher=fetch,clock=Date.now,html='',client=''}={}){
  const application=createWorker({fetcher:sourceFetcher,clock,html:html.replace('<head>','<head><meta name="artha-profile" content="cloudflare-free">'),client});
  const verifyOwner=createCloudflareAccessVerifier({fetcher:jwksFetcher,clock});
  return {
    async fetch(request,env){
      const identity=await verifyOwner(request,env);
      if(!identity.ok)return nativeDenied(identity.configured?403:503);
      if(new URL(request.url).pathname==='/api/engine/tick')return new Response('Not found',{status:404});
      return application.fetch(request,nativeEnvironment(env));
    },
    async scheduled(controller,env,ctx){
      // Native cron is a platform event. It does not use HTTP, user JWTs or any external scheduler credential.
      if(!cloudflareAccessConfig(env))return;
      const work=runTick(nativeEnvironment(env),{trigger:'scheduled',scheduledAt:controller.scheduledTime,clock,fetcher:sourceFetcher});
      if(ctx?.waitUntil)ctx.waitUntil(work);else return await work;
    }
  };
}

export default createCloudflareWorker({html:typeof HTML==='string'?HTML:'',client:typeof CLIENT==='string'?CLIENT:''});
