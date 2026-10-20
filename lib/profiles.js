export const CLOUDFLARE_FREE_PROFILE=Object.freeze({name:'cloudflare-free',maxJobs:1,dictionaryLimit:1,
  maxResponseBytes:32768,maxTextChars:8000,wallTimeBudgetMs:12000,dailyTickCap:360,registrarDisabled:true});
export function executionProfile(env){
  return env.RUN_PROFILE==='cloudflare-free'?CLOUDFLARE_FREE_PROFILE:
    {name:'standard',maxJobs:3,dictionaryLimit:10,maxResponseBytes:750000,maxTextChars:50000,
      wallTimeBudgetMs:25000,dailyTickCap:null,registrarDisabled:false};
}
