// The release gate: finished work stays locked until the studio releases it,
// by either an in-app switch or the Drive folder going public.
//   node test/release.mjs
import { startServer } from './helpers/server.mjs';
import { startFakeDrive } from './helpers/fakedrive.mjs';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const F='1ZZfolderIDfolderIDfolderID99';
const fake = await startFakeDrive({ folders:{[F]:[]}, folderMeta:{[F]:{name:'Smith Wedding'}} });
const server = await startServer({ env:{ GOOGLE_CLIENT_EMAIL:fake.clientEmail, GOOGLE_PRIVATE_KEY:fake.privateKey, GOOGLE_TOKEN_URL:fake.tokenUrl, GOOGLE_DRIVE_API:fake.apiBase }});
const jars={admin:new Map(),client:new Map()};
const absorb=(j,r)=>{for(const c of r.headers.getSetCookie()){const p=c.split(';')[0];const i=p.indexOf('=');if(i>0)j.set(p.slice(0,i).trim(),p.slice(i+1).trim());}};
async function call(path,{method='GET',body,raw,headers={},as='admin'}={}){const jar=as==='none'?new Map():jars[as];const h={...headers};const c=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');if(c)h.cookie=c;let pl=raw;if(body!==undefined){h['content-type']='application/json';pl=JSON.stringify(body);}const r=await fetch(server.base+path,{method,headers:h,body:pl,redirect:'manual'});absorb(jar,r);const t=r.headers.get('content-type')||'';return{status:r.status,data:t.includes('json')?await r.json().catch(()=>({})):null,res:r};}
let ok=0,n=0; const check=(name,c,d='')=>{n++;console.log(c?`  ✓ ${name}`:`  ✗ ${name} ${d}`);if(c)ok++;};

await call('/api/login',{method:'POST',body:{password:server.password}});
const g=(await call('/api/folders',{method:'POST',body:{title:'Smith Wedding'}})).data;
const tab=g.tabs[0];
await call(`/api/tabs/${tab.id}`,{method:'PATCH',body:{downloadable:true}});
await call(`/api/tabs/${tab.id}/images?w=1&h=1`,{method:'POST',raw:PNG,headers:{'content-type':'image/png','x-filename':'a.png'}});
await call(`/api/folders/${g.folder.id}`,{method:'PATCH',body:{downloadPin:'4821',status:'published',releaseTrigger:'drive-public',driveFolderId:F,driveFolderName:'Smith Wedding'}});
const link=g.folder.uniqueLink;
await call(`/api/g/${link}/unlock`,{method:'POST',body:{pin:'4821'},as:'client'});

console.log('\n— drive folder still private —');
const shut=await call(`/api/g/${link}/gallery.zip`,{as:'client'});
check('download is refused', shut.status===403, String(shut.status));
check('and says why, without blaming the client', /not been released/i.test(shut.data?.error||''), shut.data?.error);

console.log('\n— studio makes the drive folder public —');
fake.state.publicFolders.add(F);
await call(`/api/folders/${g.folder.id}`,{method:'PATCH',body:{releaseTrigger:'drive-public'}}); // clears the cache
const open=await call(`/api/g/${link}/gallery.zip`,{as:'client'});
check('download now works', open.status===200, String(open.status));

console.log('\n— google will not say —');
fake.state.hidePermissions=true;
await call(`/api/folders/${g.folder.id}`,{method:'PATCH',body:{releaseTrigger:'drive-public'}});
const unknown=await call(`/api/g/${link}/gallery.zip`,{as:'client'});
check('unknown fails closed, never open', unknown.status===403, String(unknown.status));
check('and does not claim the photos are unreleased', /try again shortly/i.test(unknown.data?.error||''), unknown.data?.error);

console.log('\n— manual switch —');
fake.state.hidePermissions=false;
await call(`/api/folders/${g.folder.id}`,{method:'PATCH',body:{releaseTrigger:'manual'}});
check('manual starts locked', (await call(`/api/g/${link}/gallery.zip`,{as:'client'})).status===403);
await call(`/api/folders/${g.folder.id}`,{method:'PATCH',body:{releasedAt:true}});
check('flipping the switch opens it', (await call(`/api/g/${link}/gallery.zip`,{as:'client'})).status===200);
await call(`/api/folders/${g.folder.id}`,{method:'PATCH',body:{releasedAt:false}});
check('and it can be pulled back', (await call(`/api/g/${link}/gallery.zip`,{as:'client'})).status===403);

console.log('\n— existing galleries are untouched —');
const plain=(await call('/api/folders',{method:'POST',body:{title:'Old Gallery'}})).data;
await call(`/api/tabs/${plain.tabs[0].id}`,{method:'PATCH',body:{downloadable:true}});
await call(`/api/tabs/${plain.tabs[0].id}/images?w=1&h=1`,{method:'POST',raw:PNG,headers:{'content-type':'image/png','x-filename':'b.png'}});
await call(`/api/folders/${plain.folder.id}`,{method:'PATCH',body:{downloadPin:'1111',status:'published'}});
await call(`/api/g/${plain.folder.uniqueLink}/unlock`,{method:'POST',body:{pin:'1111'},as:'client'});
check('a gallery with no delivery set up still downloads', (await call(`/api/g/${plain.folder.uniqueLink}/gallery.zip`,{as:'client'})).status===200);

await server.stop(); await fake.stop();
console.log(`\n${ok}/${n} checks passed`);
process.exit(ok===n?0:1);
