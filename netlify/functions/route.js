const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter'
];

const json = (statusCode, body) => ({statusCode, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}, body:JSON.stringify(body)});
const rad = d => d*Math.PI/180;
function distKm(a,b){
  const R=6371, dLat=rad(b.lat-a.lat), dLon=rad(b.lon-a.lon);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function surfaceClass(tags={}){
  const s=(tags.surface||'').toLowerCase(), tt=(tags.tracktype||'').toLowerCase(), h=(tags.highway||'').toLowerCase();
  const smooth=(tags.smoothness||'').toLowerCase(), wd=(tags['4wd_only']||'').toLowerCase();
  if(wd==='yes'||['grade4','grade5'].includes(tt)||['bad','very_bad','horrible','very_horrible','impassable'].includes(smooth)) return 'difficult';
  if(['dirt','earth','ground','mud','sand','grass'].includes(s)||tt==='grade3') return 'difficult';
  if(['gravel','fine_gravel','compacted','unpaved','pebblestone'].includes(s)||['grade1','grade2'].includes(tt)||h==='track') return 'dirt';
  return 'paved';
}
function multiplier(tags, pref){
  const cls=surfaceClass(tags), h=(tags.highway||'').toLowerCase();
  if(cls==='dirt') return pref==='strong'?0.42:0.68;
  if(cls==='difficult') return pref==='strong'?0.78:1.05;
  if(['primary','secondary'].includes(h)) return pref==='strong'?5.0:2.7;
  if(h==='tertiary') return pref==='strong'?3.8:2.2;
  return pref==='strong'?2.5:1.65;
}
function blocked(tags={}){
  const vals=[tags.access,tags.vehicle,tags.motor_vehicle,tags.motorcar].map(v=>(v||'').toLowerCase());
  return vals.some(v=>['no','private'].includes(v));
}
async function overpass(query){
  let last='Routing data servers unavailable';
  for(const endpoint of ENDPOINTS){
    const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),24000);
    try{
      const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8','accept':'application/json','user-agent':'Xoma-Cyprus-Offroad/1.1'},body:'data='+encodeURIComponent(query),signal:ctrl.signal});
      if(!r.ok){last=`OpenStreetMap server returned ${r.status}`;continue;}
      return await r.json();
    }catch(e){last=e.name==='AbortError'?'Routing request timed out':String(e.message||e);}finally{clearTimeout(timer);}
  }
  throw new Error(last);
}
class Heap{
  constructor(){this.a=[];} push(x){this.a.push(x);let i=this.a.length-1;while(i){let p=(i-1)>>1;if(this.a[p][0]<=x[0])break;this.a[i]=this.a[p];i=p;}this.a[i]=x;}
  pop(){if(!this.a.length)return null;const root=this.a[0],x=this.a.pop();if(this.a.length){let i=0;while(true){let l=i*2+1,r=l+1,c=l;if(r<this.a.length&&this.a[r][0]<this.a[l][0])c=r;if(l>=this.a.length||this.a[c][0]>=x[0])break;this.a[i]=this.a[c];i=c;}this.a[i]=x;}return root;}
}
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST') return json(405,{error:'Method not allowed'});
  let body={}; try{body=JSON.parse(event.body||'{}');}catch(_){return json(400,{error:'Invalid request'});}
  const from=body.from,to=body.to,pref=body.preference==='balanced'?'balanced':'strong';
  if(!from||!to||![from.lat,from.lon,to.lat,to.lon].every(Number.isFinite)) return json(400,{error:'Invalid route points'});
  const direct=distKm(from,to); if(direct>95) return json(400,{error:'This experimental planner supports trips up to about 95 km.'});
  const pad=Math.min(0.12,0.045+direct/900);
  const south=Math.min(from.lat,to.lat)-pad,north=Math.max(from.lat,to.lat)+pad,west=Math.min(from.lon,to.lon)-pad,east=Math.max(from.lon,to.lon)+pad;
  const query=`[out:json][timeout:35];way["highway"~"^(primary|secondary|tertiary|unclassified|residential|service|track|road|living_street|path)$"](${south},${west},${north},${east});out body;>;out skel qt;`;
  try{
    const data=await overpass(query), nodes=new Map(), ways=[];
    for(const e of data.elements||[]){if(e.type==='node')nodes.set(e.id,{lat:e.lat,lon:e.lon});else if(e.type==='way'&&e.nodes&&e.nodes.length>1&&!blocked(e.tags||{}))ways.push(e);}
    const graph=new Map();
    const add=(a,b,edge)=>{if(!graph.has(a))graph.set(a,[]);graph.get(a).push({to:b,...edge});};
    for(const w of ways){const tags=w.tags||{},oneway=(tags.oneway||'').toLowerCase();for(let i=1;i<w.nodes.length;i++){const a=w.nodes[i-1],b=w.nodes[i],A=nodes.get(a),B=nodes.get(b);if(!A||!B)continue;const km=distKm(A,B),cls=surfaceClass(tags),cost=km*multiplier(tags,pref);const edge={km,cost,cls,name:tags.name||tags.ref||'',highway:tags.highway||''};if(oneway!=='-1')add(a,b,edge);if(oneway!=='yes'&&oneway!=='1')add(b,a,edge);}}
    const nearest=(p)=>{let id=null,d=Infinity;for(const [nid,n] of nodes){if(!graph.has(nid))continue;const x=distKm(p,n);if(x<d){d=x;id=nid;}}return {id,d};};
    const s=nearest(from),t=nearest(to); if(!s.id||!t.id||s.d>5||t.d>5) return json(422,{error:'Could not connect one of the places to the mapped driving network.'});
    const heap=new Heap(),d=new Map([[s.id,0]]),prev=new Map();heap.push([0,s.id]);let visited=0;
    while(heap.a.length){const [du,u]=heap.pop();if(du!==d.get(u))continue;if(u===t.id)break;if(++visited>450000)throw new Error('Route graph was too large');for(const e of graph.get(u)||[]){const nd=du+e.cost;if(nd<(d.get(e.to)??Infinity)){d.set(e.to,nd);prev.set(e.to,{u,e});heap.push([nd,e.to]);}}}
    if(!d.has(t.id)) return json(422,{error:'No connected mixed-surface route was found. Try Balanced mode or closer places.'});
    const ids=[];let cur=t.id;while(cur!==s.id){ids.push(cur);const p=prev.get(cur);if(!p)break;cur=p.u;}ids.push(s.id);ids.reverse();
    const coords=ids.map(id=>[nodes.get(id).lat,nodes.get(id).lon]);let total=0,dirt=0,difficult=0,paved=0;
    for(let i=1;i<ids.length;i++){const e=prev.get(ids[i]).e;total+=e.km;if(e.cls==='dirt')dirt+=e.km;else if(e.cls==='difficult')difficult+=e.km;else paved+=e.km;}
    return json(200,{coords,stats:{totalKm:total,dirtKm:dirt,difficultKm:difficult,pavedKm:paved,dirtPercent:total?Math.round((dirt+difficult)*100/total):0,snapStartKm:s.d,snapEndKm:t.d},warning:'Experimental route based on OpenStreetMap tags. Verify gates, closures, access and actual conditions locally.'});
  }catch(e){return json(502,{error:String(e.message||e)});}
};
