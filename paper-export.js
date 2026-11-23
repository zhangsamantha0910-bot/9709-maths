import * as pdfjs from './vendor/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
const $ = id => document.getElementById(id);
const files = new Map();
let jobs = [];
let previewUrl;
let studentUrl;
let teacherUrl;

function filename(q, type) {
  const match = q.ref.match(/^(9709)\/(\d{2})\/([FMO])\/[MJN]\/(\d{2}) Q/);
  if (!match) throw Error('Unrecognised source reference: '+q.ref);
  const [, subject, component, season, year] = match;
  return subject + '_' + ({'F':'m','M':'s','O':'w'}[season[0]]) + year + '_' + type + '_' + component + '.pdf';
}
function wholeRef(q) { return q.ref.match(/^(.+ Q\d+)/)[1]; }
function status(message) { $('exportStatus').textContent = message; }
function parseRegions(value, pages) {
  return value.split(',').map(part => {
    const m = part.trim().match(/^(\d+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (!m) throw Error('Use page:top-bottom, for example 2:55-780. Measurements are PDF points.');
    const [page, top, bottom] = m.slice(1).map(Number);
    if (page < 1 || page > pages.length || top < 0 || bottom > pages[page-1].height || top >= bottom) {
      throw Error('Crop coordinates fall outside the source page.');
    }
    return {page, top, bottom};
  });
}
function regionsText(regions) {return regions.map(r=>r.page+':'+r.top.toFixed(1)+'-'+r.bottom.toFixed(1)).join(', ');}

async function readSource(name) {
  if (!files.has(name)) return null;
  return parseSource(files.get(name));
}
async function parseSource(source) {
  if (source.pages) return source;
  source.document = await pdfjs.getDocument({
    data: source.bytes.slice(), standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href, cMapPacked: true
  }).promise;
  source.pages = [];
  for (let n=1; n<=source.document.numPages; n++) {
    const page=await source.document.getPage(n);
    const viewport=page.getViewport({scale:1});
    const text=await page.getTextContent();
    const lines=text.items.filter(t=>t.str?.trim()).map(t=>{
      const xy=viewport.convertToViewportPoint(t.transform[4],t.transform[5]);
      return {text:t.str, x:xy[0], top:xy[1]-Math.abs(t.height || 10), height:Math.abs(t.height || 10)};
    });
    source.pages.push({width:viewport.width,height:viewport.height,lines});
  }
  return source;
}
function findRegions(source, number, type) {
  const starts=[];
  let expected=1;
  for (let p=0;p<source.pages.length;p++) {
    const page=source.pages[p];
    if(p===0) continue;
    if(type==='ms' && !page.lines.some(l=>/^Marks$/i.test(l.text.trim()))) continue;
    const candidates=page.lines.filter(l=>l.top>38 && l.top<page.height-40 && l.x<(type==='ms'?150:80))
      .sort((a,b)=>a.top-b.top || a.x-b.x);
    for (const line of candidates) {
      const match=line.text.trim().match(/^(\d{1,2})(?:\s|\(|$)/);
      if (match && Number(match[1])===expected) {
        starts.push({number:expected,page:p+1,top:Math.max(38,line.top-8)});
        expected++;
      }
    }
  }
  const start=starts.find(s=>s.number===number), end=starts.find(s=>s.number===number+1);
  if (!start) return [];
  const last=end?end.page:source.pages.length;
  const regions=[];
  for(let p=start.page;p<=last;p++) {
    const top=p===start.page?start.top:(type==='ms'?80:42);
    const bottom=p===end?.page?end.top:source.pages[p-1].height-45;
    const page=source.pages[p-1];
    // Omit blank continuation pages after the last question.
    if(bottom>top+24 && page.lines.some(l=>l.top>=top && l.top<bottom && !/^\.+$/.test(l.text.trim()))) {
      regions.push({page:p,top,bottom});
    }
  }
  return regions;
}
async function embedCrop(output, source, input, r) {
  const original=input.getPage(r.page-1);
  const {width,height}=source.pages[r.page-1];
  const box={left:28,right:width-28,top:height-r.top,bottom:height-r.bottom};
  if(original.getRotation().angle%360===0) {
    return {asset:await output.embedPage(original,box),width:width-56,height:r.bottom-r.top,image:false};
  }
  const page=await source.document.getPage(r.page);
  const scale=2, viewport=page.getViewport({scale});
  const canvas=document.createElement('canvas');
  canvas.width=Math.ceil((width-56)*scale);canvas.height=Math.ceil((r.bottom-r.top)*scale);
  await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[1,0,0,1,-28*scale,-r.top*scale]}).promise;
  return {asset:await output.embedPng(canvas.toDataURL('image/png')),width:width-56,height:r.bottom-r.top,image:true};
}
function placeCrop(page,crop,x,y,scale) {
  if(crop.image) page.drawImage(crop.asset,{x,y,width:crop.width*scale,height:crop.height*scale});
  else page.drawPage(crop.asset,{x,y,xScale:scale,yScale:scale});
}
async function cropPdf(source, regions) {
  const input = await PDFDocument.load(source.bytes);
  const output = await PDFDocument.create();
  for (const r of regions) {
    const crop=await embedCrop(output,source,input,r);
    const page=output.addPage([crop.width,crop.height]);
    placeCrop(page,crop,0,0,1);
  }
  return output.save();
}
async function showPreview(job, type) {
  try {
    const source=await readSource(filename(job.q,type));
    if(!source) throw Error('Retry loading this paper.');
    const input=job.inputs[type];
    const regions=parseRegions(input.value,source.pages);
    const bytes=await cropPdf(source,regions);
    if(previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    $('pdfPreview').src=previewUrl;
    $('previewLabel').textContent=job.ref+' · '+(type==='qp'?'Question':'Mark scheme');
  } catch(error) {status(error.message);}
}
async function refresh() {
  $('exportJobs').replaceChildren();
  for(const job of jobs) {
    const article=document.createElement('article');
    const heading=document.createElement('h3');heading.textContent=job.ref;
    article.append(heading);
    job.inputs={};
    for(const type of ['qp','ms']) {
      const name=filename(job.q,type);
      const source=await readSource(name);
      const row=document.createElement('div'); row.className='sourceRow';
      const label=document.createElement('label');label.textContent=type==='qp'?'Question crop':'Mark scheme crop';
      const input=document.createElement('input');input.setAttribute('aria-label',job.ref+' '+label.textContent);
      input.placeholder='page:top-bottom, page:top-bottom';
      const previous=job.regions?.[type];
      input.value=previous || (source?regionsText(findRegions(source,job.number,type)):'');
      input.oninput=()=>{job.regions??={};job.regions[type]=input.value;};
      job.inputs[type]=input;
      const text=document.createElement('p'); text.textContent=source?'Loaded '+name:'Paper temporarily unavailable';
      const preview=document.createElement('button');preview.textContent='Preview crop';preview.onclick=()=>showPreview(job,type);
      const link=document.createElement('a');link.textContent='Open source';link.target='_blank';link.rel='noopener';
      link.href='source-pdfs/'+name;
      row.append(label,text,input,preview,link);article.append(row);
    }
    $('exportJobs').append(article);
  }
}
async function getPaperBytes(name) {
  const address=new URL('source-pdfs/'+name,document.baseURI);
  for(let attempt=0;attempt<3;attempt++){
    try {
      const response=await fetch(address,{cache:attempt?'reload':'default',signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw Error('HTTP '+response.status);
      const bytes=new Uint8Array(await response.arrayBuffer());
      await PDFDocument.load(bytes);
      return bytes;
    } catch(error) {
      if(attempt===2)throw error;
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
  }
}

async function loadSelection(){
  const retry=$('retryPapers');
  retry.hidden=true;
  const buttons=[$('downloadStudent'),$('downloadTeacher')];
  buttons.forEach(button=>button.disabled=true);
  const names=[...new Set(jobs.flatMap(job=>['qp','ms'].map(type=>filename(job.q,type))))].filter(name=>!files.has(name));
  let next=0,completed=0;
  status('Loading papers…');
  async function worker(){
    while(next<names.length){
      const name=names[next++];
      try{files.set(name,{bytes:await getPaperBytes(name)});}catch{ /* Retried from the dialog if the network remains unavailable. */ }
      status('Loading papers: '+(++completed)+' / '+names.length);
    }
  }
  try{
    await Promise.all(Array.from({length:Math.min(4,names.length)},worker));
    await refresh();
    const studentReady=jobs.every(job=>files.has(filename(job.q,'qp')));
    const teacherReady=studentReady && jobs.every(job=>files.has(filename(job.q,'ms')));
    buttons[0].disabled=!studentReady;
    buttons[1].disabled=!teacherReady;
    retry.hidden=teacherReady;
    status(teacherReady?'Ready. Preview your questions or download an edition.':'Some papers could not be loaded. Check your connection and retry.');
  }catch(error){status(error.message);retry.hidden=false;}
}
window.openPaperExport=async selection=>{
  jobs=[...new Map(selection.map(q=>[wholeRef(q),q])).values()].map(q=>({q,ref:wholeRef(q),number:Number(q.ref.match(/ Q(\d+)/)[1])}));
  $('exportDialog').showModal();
  await loadSelection();
};
$('retryPapers').onclick=loadSelection;
$('closeExport').onclick=()=>{$('exportDialog').close();if(previewUrl)URL.revokeObjectURL(previewUrl);$('pdfPreview').removeAttribute('src');};
async function createEdition(teacher) {
  const sourceDocs=new Map();
  const prepared=[];
  for(const job of jobs) {
    const item={job,parts:[]};
    for(const type of (teacher?['qp','ms']:['qp'])) {
      const name=filename(job.q,type);
      const source=await readSource(name);
      if(!source)throw Error('Retry loading this paper.');
      const regions=parseRegions(job.inputs[type].value,source.pages);
      if(!sourceDocs.has(name))sourceDocs.set(name,await PDFDocument.load(source.bytes));
      item.parts.push({type,source,document:sourceDocs.get(name),regions});
    }
    prepared.push(item);
  }
  const doc=await PDFDocument.create();
  const regular=await doc.embedFont(StandardFonts.Helvetica);
  const bold=await doc.embedFont(StandardFonts.HelveticaBold);
  const draw=(page,text,x,y,size=11,font=regular)=>page.drawText(text,{x,y,size,font,color:rgb(0,0,0)});
  const title=($('titleInput').value || 'Mathematics Practice').replace(/[^\x20-\x7e]/g,'').slice(0,75);
  const cover=doc.addPage([595.28,841.89]);
  draw(cover,'MATHEMATICS',48,770,23,bold); draw(cover,'9709',484,770,20,bold);
  draw(cover,teacher?'TEACHER EDITION':'STUDENT EDITION',48,739,13,bold);
  const words=title.split(' ');let line='', y=710;
  for(const word of words){if(regular.widthOfTextAtSize(line+word,13)>490){draw(cover,line,48,y,13);line='';y-=18;}line+=word+' ';}
  draw(cover,line.trim(),48,y,13);
  cover.drawLine({start:{x:48,y:665},end:{x:547,y:665},thickness:1});
  if(!teacher) {
    draw(cover,'Candidate name',48,630);cover.drawRectangle({x:150,y:617,width:397,height:30,borderWidth:.7,borderColor:rgb(0,0,0),color:rgb(1,1,1)});
    draw(cover,'Class / Centre',48,586);cover.drawRectangle({x:150,y:573,width:397,height:30,borderWidth:.7,borderColor:rgb(0,0,0),color:rgb(1,1,1)});
  }
  draw(cover,'INSTRUCTIONS',48,520,12,bold);
  const instructions=teacher?['This edition contains the original questions and their mark schemes.','Match each question to the source reference printed above it.','Apply the marking instructions from the original source paper.']:
    ['Answer all questions and show all necessary working.','Use a black or dark blue pen. Use a pencil for diagrams.','Use a calculator where appropriate.','Give non-exact answers to 3 significant figures, unless otherwise stated.'];
  instructions.forEach((text,i)=>draw(cover,text,48,492-i*24,11));
  draw(cover,'INFORMATION',48,355,12,bold);
  draw(cover,'This paper contains '+jobs.length+' whole questions, including all their parts.',48,328);
  draw(cover,'The marks for each part are shown in the original question.',48,304);
  draw(cover,'Source question numbers are retained within the original extracts.',48,280);
  draw(cover,'Independently assembled practice paper.',48,90,10);
  draw(cover,'Source materials retain their original copyright.',48,74,10);
  for(let i=0;i<prepared.length;i++) {
    const {job,parts}=prepared[i];
    for(const part of parts) {
      for(let n=0;n<part.regions.length;n++) {
        const region=part.regions[n];
        const page=doc.addPage([595.28,841.89]);
        draw(page,part.type==='ms'?'MARK SCHEME':'MATHEMATICS',42,804,11,bold);
        draw(page,'Question '+(i+1)+(n?' (continued)':''),42,781,11,bold);
        draw(page,job.ref,330,781,10);
        page.drawLine({start:{x:42,y:770},end:{x:553,y:770},thickness:.6});
        const crop=await embedCrop(doc,part.source,part.document,region);
        const scale=Math.min(511/crop.width,686/crop.height,1.15);
        placeCrop(page,crop,42,756-crop.height*scale,scale);
      }
    }
  }
  for(const [i,page] of doc.getPages().entries()) {
    draw(page,String(i+1),291,23,10);
    if(i)draw(page,'9709 / '+(teacher?'Teacher':'Student'),42,23,9);
  }
  doc.setTitle(title+' - '+(teacher?'Teacher':'Student'));
  const bytes=await doc.save();
  const blob=new Blob([bytes],{type:'application/pdf'});
  const url=URL.createObjectURL(blob);
  if(teacher){if(teacherUrl)URL.revokeObjectURL(teacherUrl);teacherUrl=url;}
  else {if(studentUrl)URL.revokeObjectURL(studentUrl);studentUrl=url;}
  const link=document.createElement('a');link.href=url;link.download='9709-'+(teacher?'teacher':'student')+'.pdf';link.click();
}
for(const [id,teacher] of [['downloadStudent',false],['downloadTeacher',true]]) {
  $(id).onclick=async()=>{
    const buttons=[$('downloadStudent'),$('downloadTeacher')];
    buttons.forEach(b=>b.disabled=true);
    try{status('Building PDF…');await createEdition(teacher);status((teacher?'Teacher':'Student')+' PDF created.');}
    catch(error){status(error.message);}
    finally{buttons.forEach((b,i)=>b.disabled=!jobs.every(job=>files.has(filename(job.q,'qp')) && (!i || files.has(filename(job.q,'ms')))));}
  };
}




const cardSources = new Map();
function localCardSource(name) {
  if (cardSources.has(name)) return cardSources.get(name);
  const pending = (async () => {
    const source = {bytes: await getPaperBytes(name)};
    return parseSource(source);
  })();
  cardSources.set(name,pending);
  if (cardSources.size>6) cardSources.delete(cardSources.keys().next().value);
  pending.catch(()=>{if (cardSources.get(name)===pending) cardSources.delete(name);});
  return pending;
}

async function paintSource(panel,type) {
  const q=window.past[Number(panel.dataset.entry)];
  const name=filename(q,type);
  const token=Symbol();
  panel.previewToken=token;
  panel.textContent='Loading…';
  try {
    const source=await localCardSource(name);
    const regions=findRegions(source,Number(q.ref.match(/ Q(\d+)/)[1]),type);
    if (!regions.length) throw Error('Page boundaries need review');
    const body=document.createElement('div');
    for(const r of regions) {
      if(!panel.isConnected || panel.previewToken!==token)return;
      const page=await source.document.getPage(r.page);
      const scale=1.4, viewport=page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=Math.ceil(viewport.width-56*scale);
      canvas.height=Math.ceil((r.bottom-r.top)*scale);
      await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[1,0,0,1,-28*scale,-r.top*scale]}).promise;
      canvas.setAttribute('aria-label',q.ref+' · '+(type==='ms'?'Mark scheme':'Question')+' · page '+r.page);
      body.append(canvas);
    }
    if(panel.isConnected && panel.previewToken===token)panel.replaceChildren(body);
  } catch {
    if(panel.previewToken!==token)return;
    const link=document.createElement('a');
    link.href='source-pdfs/'+name+(type==='qp'?(q.url.match(/#page=\d+/)?.[0] || ''):'');
    link.target='_blank';link.rel='noopener';
    link.textContent='Open the local PDF to locate '+q.ref.split(' Q')[1]+' (crop needs review)';
    panel.replaceChildren(link);
  }
}
const previewQueue=[];
let runningPreviews=0;
function schedulePreview(panel,type){
  previewQueue.push([panel,type]);
  while(runningPreviews<2 && previewQueue.length){
    const [next,kind]=previewQueue.shift();
    if(!next.isConnected)continue;
    runningPreviews++;
    paintSource(next,kind).finally(()=>{runningPreviews--;drainQueue();});
  }
}
function drainQueue(){
  if(previewQueue.length){const [panel,type]=previewQueue.shift();schedulePreview(panel,type);}
}
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){
    observer.unobserve(entry.target);schedulePreview(entry.target,'qp');
  }
},{rootMargin:'80px'});
function observeCards(){
  observer.disconnect();
  for(const panel of document.querySelectorAll('.stemPreview'))observer.observe(panel);
}
window.addEventListener('cardsupdated',observeCards);
document.addEventListener('toggle',event=>{
  const details=event.target;
  if(details.matches?.('.answerPreview') && details.open && !details.dataset.loaded){
    details.dataset.loaded='1';schedulePreview(details.querySelector('[data-entry]'),'ms');
  }
},true);
observeCards();

