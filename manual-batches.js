// Uses the existing append-only history table as a bounded reservation ledger; no migration is required.
const MANUAL_UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validManualRequest(body){return body&&Number.isInteger(body.count)&&body.count>=1&&body.count<=20&&MANUAL_UUID.test(body.request_id);}
export async function listManualBatches(db,now=Date.now()){
  const [history,leases]=await Promise.all([
    db.prepare("SELECT happened,action,detail FROM history WHERE action IN ('Batch reserved','Batch released') ORDER BY id DESC LIMIT 100").all(),
    db.prepare('SELECT w.*,l.batch_id,l.expires AS lease_expires FROM words w JOIN leases l ON l.domain=w.domain ORDER BY w.word').all()
  ]);
  const batches=new Map();
  for(const event of history.results){
    const id=event.detail.slice(0,36);if(!MANUAL_UUID.test(id)||event.detail[36]!=='|')continue;
    let data;try{data=JSON.parse(event.detail.slice(37))}catch{continue;}
    if(!data||typeof data!=='object'||!Number.isFinite(Date.parse(data.expires)))continue;
    const item=batches.get(id)||{id,words:[]};
    if(event.action==='Batch reserved'){item.created_at=event.happened;item.expires=data.expires;item.requested_count=data.count;}
    else{item.released_at=event.happened;if(!item.expires)item.expires=data.expires;}
    batches.set(id,item);
  }
  for(const word of leases.results){
    const item=batches.get(word.batch_id)||{id:word.batch_id,created_at:null,expires:word.lease_expires,words:[]};
    item.words.push(word);batches.set(item.id,item);
  }
  return [...batches.values()].map(b=>({...b,state:b.released_at?'released':Date.parse(b.expires)<=now?'expired':'active'}))
    .sort((a,b)=>b.expires.localeCompare(a.expires)).slice(0,20);
}
export async function reserveManualBatch(db,body,now=Date.now()){
  if(!validManualRequest(body))throw Error('Invalid batch request');
  const id=body.request_id,stamp=new Date(now).toISOString(),expires=new Date(now+12*60000).toISOString();
  const detail=id+'|'+JSON.stringify({expires,count:body.count,nonce:crypto.randomUUID()});
  await db.batch([
    db.prepare("INSERT INTO history(happened,action,detail) SELECT ?,'Batch reserved',? WHERE NOT EXISTS(SELECT 1 FROM history WHERE action='Batch reserved' AND substr(detail,1,36)=?)").bind(stamp,detail,id),
    db.prepare(`INSERT INTO leases(domain,batch_id,expires) SELECT w.domain,?,? FROM words w
      LEFT JOIN leases l ON l.domain=w.domain LEFT JOIN observations o ON o.domain=w.domain
      WHERE EXISTS(SELECT 1 FROM history WHERE action='Batch reserved' AND detail=?)
      AND NOT EXISTS(SELECT 1 FROM leases WHERE batch_id=?)
      AND w.triage!='rejected' AND length(trim(w.meaning))>0 AND (l.domain IS NULL OR l.expires<=?)
      AND (o.domain IS NULL OR o.checked_at<?)
      ORDER BY CASE WHEN w.language='Nepali' THEN 0 ELSE 1 END,w.favorite DESC,w.word LIMIT ?
      ON CONFLICT(domain) DO UPDATE SET batch_id=excluded.batch_id,expires=excluded.expires WHERE leases.expires<=?`)
      .bind(id,expires,detail,id,stamp,new Date(now-6*3600000).toISOString(),body.count,stamp)
  ]);
  const batch=(await listManualBatches(db,now)).find(b=>b.id===id);
  return {batch_id:id,expires:batch?.expires||expires,state:batch?.state||'expired',words:batch?.words||[],
    note:'Reserved for a visible manual registrar review only. No registrar lookup, purchase or domain reservation was performed.'};
}
export async function releaseManualBatch(db,id,now=Date.now()){
  if(!MANUAL_UUID.test(id))return false;
  const batch=(await listManualBatches(db,now)).find(b=>b.id===id);if(!batch)return false;
  const detail=id+'|'+JSON.stringify({expires:batch.expires});
  await db.batch([
    db.prepare("INSERT INTO history(happened,action,detail) SELECT ?,'Batch released',? WHERE NOT EXISTS(SELECT 1 FROM history WHERE action='Batch released' AND substr(detail,1,36)=?)").bind(new Date(now).toISOString(),detail,id),
    db.prepare('DELETE FROM leases WHERE batch_id=?').bind(id)
  ]);
  return true;
}
