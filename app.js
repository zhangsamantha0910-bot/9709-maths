const byId = id => document.getElementById(id);
const topics = window.topics;
const bank = window.past;
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let paper = 'P1', selected = [];
try {
  const saved = JSON.parse(localStorage.getItem('9709-desk') || '{}');
  selected = [...new Set(saved.refs || [])].map(ref => bank.find(q => q.ref === ref)).filter(Boolean);
  byId('titleInput').value = saved.title || '';
} catch {}
function save() {
  try {localStorage.setItem('9709-desk', JSON.stringify({refs:selected.map(q=>q.ref),title:byId('titleInput').value}));} catch {}
}
function options(id, label, entries) {
  byId(id).replaceChildren(new Option(label,''),...entries.map(([key,text])=>new Option(text,key)));
}
function chapterLabel(key) {
  return topics[key] ? 'Chapter ' + key.split('.')[1] + ' · ' + topics[key] : 'Chapter pending review';
}
function chapters() {
  const entries = Object.keys(topics).filter(key => key.startsWith(paper + '.'));
  options('chapter', 'All coursebook chapters', entries.map(key => [key, chapterLabel(key)]));
  skills();
}
function skills() {
  const names = bank.filter(q=>q.paper===paper && (!byId('chapter').value || q.topic===byId('chapter').value)).map(q=>q.skill).filter(name => name && !['Topic pending review','Suggested topic'].includes(name));
  options('skill','All skills',[...new Set(names)].map(s=>[s,s]));
}
function filtered() {
  const query=byId('query').value.trim().toLowerCase();
  return bank.filter(q=>q.paper===paper && (!byId('chapter').value || q.topic===byId('chapter').value) && (!byId('skill').value || q.skill===byId('skill').value) && [q.ref,q.note,q.skill,q.chapterStatus,chapterLabel(q.topic)].join(' ').toLowerCase().includes(query));
}
let visibleCount = 40;
let previousFilter = '';
byId('more').onclick = () => { visibleCount += 40; render(); };
function render() {
  const rows=filtered(), e=escapeText;
  const currentFilter=JSON.stringify([paper,byId('chapter').value,byId('skill').value,byId('query').value]);
  if(currentFilter!==previousFilter) visibleCount=40;
  previousFilter=currentFilter;
  byId('more').hidden=rows.length<=visibleCount;
  byId('p1').className=paper==='P1'?'active':'';
  byId('s1').className=paper==='S1'?'active':'';
  byId('count').textContent=''+rows.length+' questions · '+selected.length+' selected';
  byId('cards').innerHTML=rows.slice(0,visibleCount).map(q=>`<article><small>Past paper · ${e(q.marks)} marks</small><h3>${e(q.ref)}</h3><b>${e(q.chapterStatus || chapterLabel(q.topic))}</b><span>${['Suggested topic','Topic pending review'].includes(q.skill) ? '' : e(q.skill)}</span><div class="stemPreview" data-entry="${bank.indexOf(q)}">Loading question…</div><details class="answerPreview"><summary>View mark scheme</summary><div data-entry="${bank.indexOf(q)}"></div></details><footer><button data-add="${bank.indexOf(q)}">${selected.includes(q)?'Remove':'Add to paper'}</button>${q.url?`<a href="source-pdfs/${e(q.url.split('/').pop())}" target="_blank" rel="noopener">Open original</a>`:`<details><summary>View answer</summary>${e(q.answer)}</details>`}</footer></article>`).join('') || 'No matching questions. Try another chapter or search term.';
  window.dispatchEvent(new Event('cardsupdated'));
  byId('basket').innerHTML=selected.map((q,i)=>`<li>${e(q.ref)} · ${q.marks} marks <button data-del="${i}" aria-label="Remove">×</button>${i?`<button data-up="${i}">Move up</button>`:''}</li>`).join('');
  byId('sum').textContent=selected.reduce((s,q)=>s+q.marks,0);
  byId('num').textContent=selected.length;
  byId('empty').hidden=!!selected.length;
  byId('printBtn').disabled=!selected.length;
  save();
}
function switchPaper(next) {paper=next;byId('query').value='';byId('status').textContent='';chapters();render();}
byId('p1').onclick=()=>switchPaper('P1');byId('s1').onclick=()=>switchPaper('S1');
byId('reset').onclick=()=>switchPaper(paper);
byId('chapter').onchange=()=>{skills();render();};
for(const id of ['query','skill']) byId(id).oninput=render;
byId('titleInput').oninput=save;
document.addEventListener('click',event=>{
  const d=event.target.dataset;
  if('add' in d){const q=bank[+d.add]; selected=selected.includes(q)?selected.filter(x=>x!==q):[...selected,q];}
  else if('del' in d)selected.splice(+d.del,1);
  else if('up' in d){const i=+d.up;[selected[i-1],selected[i]]=[selected[i],selected[i-1]];}
  else return;
  byId('status').textContent='';render();
});
byId('auto').onclick=()=>{
  const goal=Number(byId('target').value);
  if(!Number.isInteger(goal)||goal<1||goal>200){byId('status').textContent='Enter a whole number from 1 to 200.';return;}
  const pool=filtered();
  if(!pool.length){byId('status').textContent='No questions match these filters.';return;}
  const paths=Array(goal+1);paths[0]=[];
  for(const q of pool)for(let s=goal;s>=q.marks;s--) if(!paths[s]&&paths[s-q.marks])paths[s]=[...paths[s-q.marks],q];
  let best=goal;while(best>0&&!paths[best])best--;
  if(best)selected=paths[best];
  byId('status').textContent=best?'Selected '+best+' marks. Remaining to target: '+(goal-best)+' marks.':'Every matching question exceeds the target. Your selection has been kept.';render();
};
let enginePromise;
let engineAttempt=0;
function loadEngine(){
  if(!enginePromise){
    const suffix=engineAttempt++ ? '&retry='+Date.now() : '';
    enginePromise=import('./paper-export.js?v=pdf-ready-2'+suffix).catch(error=>{
      enginePromise=null;
      throw error;
    });
  }
  return enginePromise;
}
loadEngine().catch(()=>{}); // Warm up inline previews while the bank is being browsed.
byId('printBtn').onclick=async()=>{
  const button=byId('printBtn');
  const selection=selected.slice();
  button.disabled=true;
  byId('status').textContent='Opening PDF tools…';
  let timer;
  try{
    await Promise.race([loadEngine(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('The PDF tools are taking longer than expected to download. Please try again.')),25000);
    })]);
    clearTimeout(timer);
    byId('status').textContent='';
    await window.openPaperExport(selection);
  }catch(error){
    byId('status').textContent='Could not open PDF tools. '+error.message;
  }finally{
    clearTimeout(timer);
    button.disabled=!selected.length;
  }
};
chapters();render();

const years = [...new Set(window.paperDirectory.map(entry => entry.year))].sort((a,b)=>b-a);
for (const year of years) {
  const papers = window.paperDirectory.filter(entry=>entry.year===year);
  const group = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = year+' · '+papers.length+' papers · '+papers.reduce((n,p)=>n+p.count,0)+' indexed entries';
  group.append(summary);
  for (const p of papers) {
    const link = document.createElement('a');
    link.href='source-pdfs/'+p.url.split('/').pop();link.target='_blank';link.rel='noopener';
    link.textContent=p.ref+' · '+(p.count?p.count+' entries · '+p.indexedMarks+'/'+p.totalMarks+' marks':'Index pending');
    group.append(link);
  }
  byId('years').append(group);
}



