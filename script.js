(function(){
"use strict";

/* ================= helpers ================= */
const $  = (s,r)=> (r||document).querySelector(s);
const $$ = (s,r)=> Array.from((r||document).querySelectorAll(s));
const uid = ()=> Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-3);
const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
function shuffle(a){const x=a.slice();for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;}
function say(msg){ const l=$("#live"); if(l) l.textContent=msg; }
let toastT;
function toast(msg){
  clearTimeout(toastT);
  let t=$("#toast");
  if(!t){t=document.createElement("div");t.className="toast";t.id="toast";document.body.appendChild(t);}
  t.classList.remove("is-out");
  t.textContent=msg;
  toastT=setTimeout(()=>{
    t.classList.add("is-out");
    setTimeout(()=>t.remove(),280);
  },3200);
}

/* ================= state ================= */
const state = { decks:[], deckId:null, tab:"study" };
const study = { order:[], i:0, flipped:false, explain:"" };
let quiz = null;
let mounted = "";

const deck = ()=> state.decks.find(d=>d.id===state.deckId) || null;
const mastered = d => d.cards.filter(c=>c.known).length;

/* ================= storage ================= */
let DB=null, SAMPLE=null, migrated=false;
const dirty = new Map(), writing = new Set();
let flushTimer=null;

function loadLocal(){
  try{
    const raw = localStorage.getItem("repaso.decks");
    if(raw){ const d=JSON.parse(raw); if(Array.isArray(d)) state.decks=d; }
  }catch(e){ /* storage unavailable — run from memory */ }
}
function saveLocal(){
  try{ localStorage.setItem("repaso.decks", JSON.stringify(state.decks)); }catch(e){}
}
function touch(d){
  d.updated = Date.now();
  saveLocal();
  if(!DB) return;
  dirty.set(d.id, d);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 450);
}
async function flush(){
  if(!DB) return;
  for(const [id,d] of Array.from(dirty)){
    if(writing.has(id)) continue;
    dirty.delete(id); writing.add(id);
    try{
      const body = clone(d); delete body.id;
      await DB.doc("decks/"+id).set(body);
    }catch(e){
      if(e && e.code==="quota_exceeded") toast("Storage is full — delete a deck to make room.");
      else if(e && e.code!=="revoked") toast("That change didn't save. It's still on this device.");
    }finally{ writing.delete(id); }
  }
  if(dirty.size) flushTimer=setTimeout(flush,450);
}
async function removeDeck(id){
  state.decks = state.decks.filter(d=>d.id!==id);
  dirty.delete(id); saveLocal();
  if(state.deckId===id) state.deckId = state.decks[0] ? state.decks[0].id : null;
  render();
  if(DB){ try{ await DB.doc("decks/"+id).delete(); }catch(e){ toast("Couldn't delete that deck on the server."); } }
}

async function connect(){
  const use = (window.claude && window.claude.use) ? window.claude.use.bind(window.claude) : null;
  if(!use) return;
  try{ SAMPLE = await use("sample"); }catch(e){ SAMPLE=null; }
  if(SAMPLE && state.tab==="edit") render();
  let db=null;
  try{ db = await use("db"); }catch(e){ db=null; }
  if(!db) return;
  DB = db;
  DB.collection("decks").onSnapshot(snap=>{
    if(!migrated){
      migrated = true;
      if(snap.empty && state.decks.length){ state.decks.forEach(touch); return; }
    }
    const incoming = snap.docs.map(doc=>{
      const body = clone(doc.data()||{});
      body.id = doc.id;
      body.cards = Array.isArray(body.cards)? body.cards : [];
      return body;
    });
    // keep any deck whose write is still in flight
    const held = state.decks.filter(d=> dirty.has(d.id) || writing.has(d.id));
    const map = new Map(incoming.map(d=>[d.id,d]));
    held.forEach(d=> map.set(d.id,d));
    state.decks = Array.from(map.values()).sort((a,b)=>(b.updated||0)-(a.updated||0));
    if(!deck()) state.deckId = state.decks[0] ? state.decks[0].id : null;
    saveLocal();
    render();
  }, err=>{
    if(err && err.code!=="revoked") toast("Sync stopped. Your work stays on this device.");
  });
}

/* ================= deck actions ================= */
function makeDeck(name, cards){
  const d = { id:uid(), name:name||"Untitled deck", cards:(cards||[]).map(c=>({id:uid(),term:c.term,def:c.def,known:false})), created:Date.now(), updated:Date.now() };
  state.decks.unshift(d);
  state.deckId = d.id;
  touch(d);
  return d;
}
function newDeck(){
  const name = prompt("Name this deck", "New deck");
  if(name===null) return;
  makeDeck(name.trim()||"New deck", []);
  state.tab="edit"; mounted=""; render();
}
const STARTER = [
  {term:"Mitochondrion", def:"The organelle that produces most of a cell's ATP through cellular respiration."},
  {term:"Osmosis", def:"Movement of water across a semipermeable membrane from low to high solute concentration."},
  {term:"Photosynthesis", def:"The process plants use to turn light, water, and carbon dioxide into glucose and oxygen."},
  {term:"Homeostasis", def:"Keeping a stable internal environment despite changes outside the organism."},
  {term:"Enzyme", def:"A protein that speeds up a chemical reaction without being used up by it."},
  {term:"Mitosis", def:"Cell division that produces two identical daughter cells, each with the full chromosome set."},
  {term:"Meiosis", def:"Cell division that produces four gametes, each with half the chromosome number."},
  {term:"Diffusion", def:"Net movement of particles from an area of high concentration to low concentration."}
];

/* ================= render ================= */
function render(){
  renderSidebar();
  renderChip();
  $$("#tabs .tab").forEach(t=> t.setAttribute("aria-selected", String(t.dataset.tab===state.tab)));
  renderPanel();
}
function enterPanel(){
  const p=$("#panel"); if(!p) return;
  p.classList.remove("is-enter");
  void p.offsetWidth;
  p.classList.add("is-enter");
}
function renderSidebar(){
  const list = $("#deckList");
  $("#deckCount").textContent = state.decks.length ? state.decks.length : "";
  if(!state.decks.length){
    list.innerHTML = '<li style="padding:14px 12px;color:var(--ink-soft);font-size:15px">No decks yet.</li>';
    return;
  }
  list.innerHTML = state.decks.map(d=>`
    <li><button class="deck-item" data-deck="${d.id}" aria-current="${d.id===state.deckId}">
      ${esc(d.name)}
      <span class="meta">${d.cards.length} card${d.cards.length===1?"":"s"} · ${mastered(d)} known</span>
    </button></li>`).join("");
}
function renderChip(){
  const d = deck();
  $("#deckChip").innerHTML = d
    ? `<b>${esc(d.name)}</b>${d.cards.length} cards · ${mastered(d)} marked known`
    : "";
}
function renderPanel(){
  const key = state.tab+":"+(state.deckId||"none");
  if(mounted!==key){ mounted=key; buildPanel(); }
  else if(state.tab==="study") paintCard();
}
function buildPanel(){
  const p = $("#panel");
  const d = deck();
  if(!d){
    if(state.tab==="test"){ buildTest(null); enterPanel(); return; }
    p.innerHTML = `<div class="empty">
      <h2>Start with a deck</h2>
      <p>A deck is one subject or one exam. Add terms and their meanings, then flip through them or take a pre-test.</p>
      <div class="row" style="justify-content:center">
        <button class="btn primary" data-act="new-deck">New deck</button>
        <button class="btn" data-act="starter">Add a starter deck</button>
      </div></div>`;
    enterPanel();
    return;
  }
  if(state.tab==="study") buildStudy(d);
  else if(state.tab==="test") buildTest(d);
  else buildEdit(d);
  enterPanel();
}

/* ---------- flashcards ---------- */
function buildStudy(d){
  const p=$("#panel");
  if(!d.cards.length){
    p.innerHTML = `<div class="empty"><h2>This deck is empty</h2>
      <p>Add a few cards first — or paste your notes and let Claude draft them for you.</p>
      <button class="btn primary" data-act="go-edit">Add cards</button></div>`;
    return;
  }
  if(!study.order.length || study.order.some(id=>!d.cards.find(c=>c.id===id))){
    study.order = d.cards.map(c=>c.id); study.i=0; study.flipped=false;
  }
  p.innerHTML = `
    <div class="meter"><i id="meterFill"></i></div>
    <div class="meter-label"><span id="meterText"></span><span id="meterRight"></span></div>
    <div class="stage">
      <button class="card" id="card" aria-label="Flashcard — press to flip">
        <div class="face front">
          <span class="face-label">Term</span>
          <div class="term" id="cardTerm"></div>
          <span class="flip-hint">Click or press space to flip</span>
        </div>
        <div class="face back">
          <span class="face-label">Meaning</span>
          <div class="definition" id="cardDef"></div>
          <div class="explainer" id="cardExplain"></div>
          <span class="flip-hint">Press 1 to study again, 2 if you know it</span>
        </div>
      </button>
    </div>
    <div class="controls">
      <button class="btn" data-act="prev">Back</button>
      <span class="counter" id="counter"></span>
      <button class="btn" data-act="next">Next</button>
      <span class="grow"></span>
      <button class="btn" data-act="again">Study again</button>
      <button class="btn primary" data-act="got">I know this</button>
    </div>
    <div class="controls" style="margin-top:14px;justify-content:flex-start">
      <button class="btn ghost" data-act="shuffle">Shuffle</button>
      <button class="btn ghost" data-act="unknown-only">Only unknown cards</button>
      <button class="btn ghost" data-act="reset-known">Clear all "known" marks</button>
      ${SAMPLE?'<button class="btn ghost" data-act="explain">Explain this card</button>':''}
    </div>`;
  paintCard();
}
function currentCard(){
  const d=deck(); if(!d) return null;
  const id = study.order[study.i];
  return d.cards.find(c=>c.id===id) || null;
}
function paintCard(){
  const d=deck(); const c=currentCard();
  if(!d || !c) return;
  const card=$("#card"); if(!card) return;
  const apply=()=>{
    $("#cardTerm").innerHTML = `<span class="swipe">${esc(c.term||"(no term)")}</span>`;
    $("#cardDef").textContent = c.def || "(no meaning yet)";
    $("#cardExplain").textContent = study.explain || "";
  };
  if(card.classList.contains("is-flipped") && !study.flipped){
    card.classList.remove("is-flipped");
    setTimeout(apply, 300);
  }else{
    card.classList.toggle("is-flipped", study.flipped);
    apply();
  }
  $("#counter").textContent = (study.i+1)+" / "+study.order.length;
  const known = mastered(d), total = d.cards.length;
  $("#meterFill").style.width = total? Math.round(known/total*100)+"%" : "0%";
  $("#meterText").textContent = known+" of "+total+" marked known";
  $("#meterRight").textContent = c.known ? "You marked this one known" : "";
}
function moveCard(step){
  if(!study.order.length) return;
  study.i = (study.i + step + study.order.length) % study.order.length;
  study.flipped=false; study.explain="";
  paintCard();
  say("Card "+(study.i+1)+" of "+study.order.length);
}
function markCard(known){
  const d=deck(), c=currentCard(); if(!d||!c) return;
  c.known = known; touch(d);
  renderSidebar(); renderChip();
  moveCard(1);
}
async function explainCard(){
  const c=currentCard(); if(!c||!SAMPLE) return;
  study.flipped = true; paintCard();
  const box=$("#cardExplain"); if(!box) return;
  box.textContent = "Thinking…";
  try{
    const res = await SAMPLE(
      "Explain this study term to a student in two short sentences. Plain words, one concrete example. No preamble.\n\n"+
      "Term: "+c.term+"\nMeaning given: "+c.def,
      { modelTier:"quick", onText:({text})=>{ const b=$("#cardExplain"); if(b) b.textContent=text; } }
    );
    study.explain = res.text;
  }catch(e){
    study.explain = "";
    const b=$("#cardExplain"); if(b) b.textContent="";
    if(e.code==="not_granted"||e.code==="sampling_disabled") toast("Claude isn't available for this page.");
    else if(e.code==="rate_limited") toast("Too many requests — try again in a minute.");
    else if(e.code!=="cancelled") toast("Couldn't get an explanation just now.");
  }
}

/* ---------- pre-test ---------- */
function lessonBox(){
  if(!SAMPLE) return "";
  const opts=[5,10,15,20,25];
  return `<div class="box">
    <h3>Make a pre-test from your lesson</h3>
    <p>Paste your notes, a textbook section, or lesson text. Claude reads it and builds the pre-test straight away — no need to write flashcards first.</p>
    <textarea class="notes" id="lessonNotes" placeholder="Paste your lesson here…"></textarea>
    <div class="field" style="max-width:220px;margin-top:12px">
      <label for="lessonCount">Number of questions</label>
      <select id="lessonCount" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--canvas);width:100%">
        ${opts.map(n=>`<option value="${n}" ${n===10?"selected":""}>${n} questions</option>`).join("")}
      </select>
    </div>
    <div class="row" style="margin-top:6px">
      <button class="btn primary" data-act="gen-test">Generate pre-test</button>
      <span id="genStatus" style="color:var(--ink-soft);font-size:15px"></span>
    </div>
  </div>`;
}
function buildTest(d){
  const p=$("#panel");
  if(!d || d.cards.length<2){
    const heading = d ? "Add at least two cards" : "No deck yet";
    const body = d
      ? "A pre-test needs a few cards to build questions and wrong choices from. Add cards yourself, or paste a lesson above and Claude will build them."
      : SAMPLE
        ? "Paste a lesson above and Claude will build a deck and a pre-test from it. Or make a deck yourself first."
        : "Add a deck with a few cards first.";
    p.innerHTML = lessonBox() + `<div class="empty"><h2>${heading}</h2>
      <p>${body}</p>
      <button class="btn ${SAMPLE?'':'primary'}" data-act="${d?'go-edit':'new-deck'}">${d?'Add cards':'New deck'}</button></div>`;
    return;
  }
  if(!quiz || quiz.deckId!==d.id) quiz = { deckId:d.id, stage:"setup", cfg:{count:Math.min(10,d.cards.length), types:["mc","tf","written"]}, qs:[], i:0, results:[] };
  if(quiz.stage==="setup") return paintSetup(d);
  if(quiz.stage==="run") return paintQuestion();
  return paintResults(d);
}
async function generateTestFromLesson(){
  if(!SAMPLE) return;
  const ta = $("#lessonNotes");
  const notes = (ta && ta.value || "").trim();
  const status = $("#genStatus");
  const countSel = $("#lessonCount");
  const wanted = countSel ? Math.max(3, Math.min(30, Number(countSel.value)||10)) : 10;
  if(notes.length<40){ if(status) status.textContent="Paste a bit more text first."; return; }
  const btn = $('[data-act="gen-test"]');
  if(btn) btn.disabled=true;
  if(status) status.textContent="Reading your lesson…";
  try{
    const out = await SAMPLE.json(
      "You are building a pre-test from a student's lesson notes.\n"+
      "Write "+wanted+" flashcard-style term/definition pairs covering the most testable points in the notes — "+
      "as many distinct, well-supported pairs as the notes allow, up to "+wanted+". "+
      "Each pair has a \"term\" (a name, concept, date, or short question) and a \"definition\" (one or two plain "+
      "sentences answering it), using only facts stated in the notes. Write in the same language as the notes.\n"+
      "Reply with only a JSON array, like [{\"term\":\"Osmosis\",\"definition\":\"Movement of water across a membrane.\"}]\n\n"+
      "Notes:\n"+notes.slice(0,6000)
    );
    const rows = (Array.isArray(out)?out:[])
      .map(r=>({term:String(r&&r.term||"").trim(), def:String(r&&(r.definition||r.def)||"").trim()}))
      .filter(r=>r.term&&r.def);
    if(rows.length<2){
      if(status) status.textContent="Couldn't find enough testable points in that. Try a longer excerpt.";
      return;
    }
    let d = deck();
    if(!d) d = makeDeck("Pre-test from your notes", rows);
    else{ rows.forEach(r=> d.cards.push({id:uid(),term:r.term,def:r.def,known:false})); touch(d); }
    quiz = { deckId:d.id, stage:"setup", cfg:{count:Math.min(wanted,rows.length), types:["mc","tf","written"]}, qs:[], i:0, results:[] };
    startTest();
    toast(rows.length+" questions ready");
  }catch(e){
    if(!status) return;
    if(e.code==="not_granted"||e.code==="sampling_disabled") status.textContent="Claude isn't available for this page.";
    else if(e.code==="rate_limited") status.textContent="Too many requests — wait a minute and try again.";
    else if(e.code==="prompt_too_large") status.textContent="That's a lot of text. Paste a shorter excerpt.";
    else if(e.code==="invalid_json") status.textContent="The draft came back malformed. Try again.";
    else status.textContent="That didn't work. Try again.";
  }finally{
    const b=$('[data-act="gen-test"]'); if(b) b.disabled=false;
  }
}
function paintSetup(d){
  const raw = [5,10,15,20,25,30,40,50,d.cards.length];
  const counts = raw.filter(v=>v>0 && v<=d.cards.length).filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);
  const types = [["mc","Multiple choice"],["tf","True or false"],["written","Type the answer"]];
  $("#panel").innerHTML = `
    <h2 style="font-size:24px;margin-bottom:6px">Pre-test: ${esc(d.name)}</h2>
    <p style="color:var(--ink-soft);margin:0 0 22px;max-width:52ch">Questions are drawn at random from this deck. Wrong choices come from the other cards, so the test gets harder as your deck grows.</p>
    ${lessonBox()}
    <div class="box">
      <h3>How many questions</h3>
      <div class="chips" id="countChips">
        ${counts.map(n=>`<button class="chip" data-count="${n}" aria-pressed="${quiz.cfg.count===n}">${n===d.cards.length?"All "+n:n}</button>`).join("")}
      </div>
      <div class="field" style="max-width:160px;margin:14px 0 0">
        <label for="customCount">Or type a number</label>
        <input type="number" id="customCount" min="1" max="${d.cards.length}" step="1" value="${quiz.cfg.count}">
      </div>
    </div>
    <div class="box">
      <h3>Question styles</h3>
      <p>Pick at least one. Multiple choice needs four cards; typing is the strictest.</p>
      <div class="chips" id="typeChips">
        ${types.map(([k,label])=>`<button class="chip" data-type="${k}" aria-pressed="${quiz.cfg.types.includes(k)}">${label}</button>`).join("")}
      </div>
    </div>
    <button class="btn primary" data-act="start-test">Start pre-test</button>`;
}
function normalize(s){
  return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\b(a|an|the)\b/g," ").replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
}
function editDistance(a,b){
  const m=a.length,n=b.length; if(!m) return n; if(!n) return m;
  let prev=Array.from({length:n+1},(_,j)=>j), cur=new Array(n+1);
  for(let i=1;i<=m;i++){
    cur[0]=i;
    for(let j=1;j<=n;j++){
      cur[j]=Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+(a[i-1]===b[j-1]?0:1));
    }
    [prev,cur]=[cur,prev];
  }
  return prev[n];
}
function gradeWritten(given, expected){
  const g=normalize(given), e=normalize(expected);
  if(!g) return "wrong";
  if(g===e) return "right";
  const tol = e.length>12 ? 2 : e.length>6 ? 1 : 0;
  if(tol && editDistance(g,e)<=tol) return "close";
  return "wrong";
}
function buildQuestions(d){
  const cards=d.cards.filter(c=>c.term&&c.def);
  let types=quiz.cfg.types.slice();
  if(cards.length<4) types=types.filter(t=>t!=="mc");
  if(!types.length) types=["written"];
  const pool = shuffle(cards).slice(0, Math.min(quiz.cfg.count, cards.length));
  return pool.map(card=>{
    const kind = types[Math.floor(Math.random()*types.length)];
    if(kind==="mc"){
      const wrong = shuffle(cards.filter(c=>c.id!==card.id)).slice(0,3).map(c=>c.def);
      return { kind, card, prompt:card.term, options:shuffle([card.def].concat(wrong)), answer:card.def };
    }
    if(kind==="tf"){
      const flip = Math.random()<0.5;
      const other = shuffle(cards.filter(c=>c.id!==card.id))[0];
      const shown = flip && other ? other.def : card.def;
      return { kind, card, prompt:card.term, shown, options:["True","False"], answer:(flip&&other)?"False":"True" };
    }
    return { kind:"written", card, prompt:card.def, answer:card.term };
  });
}
function startTest(){
  const d=deck(); if(!d) return;
  quiz.qs = buildQuestions(d);
  if(!quiz.qs.length){ toast("Fill in both sides of at least one card first."); return; }
  quiz.i=0; quiz.results=[]; quiz.stage="run"; quiz.picked=null; quiz.checked=false;
  mounted=""; render();
}
function paintQuestion(){
  const q=quiz.qs[quiz.i];
  const label = q.kind==="mc" ? "Multiple choice" : q.kind==="tf" ? "True or false" : "Type the answer";
  const pct = Math.round(quiz.i/quiz.qs.length*100);
  let bodyHTML="";
  if(q.kind==="written"){
    bodyHTML = `<input class="answer-input" id="written" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your answer">
      <div class="row"><button class="btn primary" data-act="check">Check</button>
      <button class="btn ghost" data-act="skip">Skip</button></div>`;
  }else{
    const keys="ABCD";
    bodyHTML = `<div class="options" id="options">${q.options.map((o,n)=>
      `<button class="option" data-opt="${n}"><span class="key">${keys[n]}</span><span>${esc(o)}</span></button>`).join("")}</div>`;
  }
  const promptText = q.kind==="tf"
    ? `${esc(q.prompt)} — <em>${esc(q.shown)}</em>`
    : esc(q.prompt);
  $("#panel").innerHTML = `
    <div class="meter"><i style="width:${pct}%"></i></div>
    <div class="meter-label"><span>Question ${quiz.i+1} of ${quiz.qs.length}</span><span>${quiz.results.filter(r=>r.ok).length} right so far</span></div>
    <div class="q-kind" style="margin-top:20px">${label}</div>
    <div class="q-prompt">${promptText}</div>
    ${bodyHTML}
    <div id="feedback"></div>`;
  const w=$("#written"); if(w) w.focus();
}
function answerQuestion(value){
  if(quiz.checked) return;
  const q=quiz.qs[quiz.i];
  let ok=false, close=false;
  if(q.kind==="written"){
    const g=gradeWritten(value,q.answer);
    ok = g!=="wrong"; close = g==="close";
  }else{
    ok = value===q.answer;
  }
  quiz.checked=true;
  quiz.results.push({ q, given:value, ok });
  if(q.kind!=="written"){
    $$("#options .option").forEach(btn=>{
      const text=q.options[Number(btn.dataset.opt)];
      btn.disabled=true;
      if(text===q.answer) btn.classList.add("correct");
      else if(text===value) btn.classList.add("incorrect");
    });
  }else{
    const inp=$("#written"); if(inp) inp.disabled=true;
  }
  const last = quiz.i===quiz.qs.length-1;
  const detail = ok
    ? (close? `<span>Close enough — the exact term is “${esc(q.answer)}”.</span>` : (q.kind==="tf"? `<span>${esc(q.card.term)}: ${esc(q.card.def)}</span>`:""))
    : `<span>${esc(q.card.term)}: ${esc(q.card.def)}</span>`;
  $("#feedback").innerHTML = `
    <div class="verdict ${ok?"ok":"no"}">${ok?"Correct":"Not quite"} ${detail}</div>
    <button class="btn primary" data-act="next-q">${last?"See results":"Next question"}</button>`;
  say(ok?"Correct":"Not quite");
  $('[data-act="next-q"]').focus();
}
function nextQuestion(){
  const d=deck();
  if(quiz.i===quiz.qs.length-1){
    // fold results into what you know
    if(d){
      quiz.results.forEach(r=>{
        const c=d.cards.find(x=>x.id===r.q.card.id);
        if(c && !r.ok) c.known=false;
      });
      d.lastScore = { right:quiz.results.filter(r=>r.ok).length, total:quiz.results.length, at:Date.now() };
      touch(d);
    }
    quiz.stage="results";
  }else{
    quiz.i++; quiz.checked=false;
  }
  mounted=""; render();
}
function paintResults(d){
  const right = quiz.results.filter(r=>r.ok).length;
  const total = quiz.results.length;
  const pct = total? Math.round(right/total*100):0;
  const missed = quiz.results.filter(r=>!r.ok);
  const verdict = pct>=90? "You're ready for this one."
    : pct>=70? "Solid. Clean up the misses and you're set."
    : pct>=50? "Half way there — the missed cards are where the work is."
    : "Worth another pass through the flashcards before testing again.";
  $("#panel").innerHTML = `
    <div class="score">${pct}%<small> · ${right} of ${total}</small></div>
    <p style="max-width:44ch;margin:10px 0 22px;color:var(--ink-soft)">${verdict}</p>
    <div class="row" style="margin-bottom:26px">
      <button class="btn primary" data-act="retake">Take it again</button>
      ${missed.length?'<button class="btn" data-act="study-missed">Study the misses</button>':""}
      <button class="btn ghost" data-act="test-setup">Change settings</button>
    </div>
    ${missed.length? `<h3 style="font-size:17px;margin-bottom:6px">What you missed</h3>
      ${missed.map(r=>`<div class="review">
        <div class="r-term">${esc(r.q.card.term)}</div>
        <div class="r-def">${esc(r.q.card.def)}</div>
        ${r.given?`<div class="r-yours">You said: ${esc(r.given)}</div>`:'<div class="r-yours">Skipped</div>'}
      </div>`).join("")}` : `<p style="color:var(--right)">Nothing missed. Try a longer test or the typing style next.</p>`}`;
}

/* ---------- card editor ---------- */
function buildEdit(d){
  $("#panel").innerHTML = `
    <div class="field">
      <label for="deckName">Deck name</label>
      <input id="deckName" value="${esc(d.name)}">
    </div>
    ${SAMPLE? `<div class="box">
      <h3>Turn notes into cards</h3>
      <p>Paste a section of your reviewer or lecture notes. Claude drafts the cards; you edit anything that's off before you study.</p>
      <textarea class="notes" id="notes" placeholder="Paste notes here…"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" data-act="ai-cards">Draft cards</button>
        <span id="aiStatus" style="color:var(--ink-soft);font-size:15px"></span>
      </div>
    </div>`:""}
    <div class="box">
      <h3>Paste a list</h3>
      <p>One card per line, term and meaning separated by a tab, a semicolon, or " - ".</p>
      <textarea class="notes" id="bulk" style="min-height:96px" placeholder="Osmosis - movement of water across a membrane"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="bulk">Add these cards</button></div>
    </div>
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <h3 style="font-size:17px">${d.cards.length} card${d.cards.length===1?"":"s"}</h3>
      <button class="btn" data-act="add-card">Add a card</button>
    </div>
    <div id="cardRows">${d.cards.map(c=>cardRow(c)).join("") || '<p style="color:var(--ink-soft)">No cards yet.</p>'}</div>
    <div class="row" style="margin-top:28px;border-top:1px solid var(--line);padding-top:18px">
      <button class="btn danger" data-act="delete-deck">Delete this deck</button>
    </div>`;
}
function cardRow(c){
  return `<div class="card-row ${c.known?"known":""}" data-card="${c.id}">
    <textarea data-side="term" placeholder="Term" aria-label="Term">${esc(c.term)}</textarea>
    <textarea data-side="def" placeholder="Meaning" aria-label="Meaning">${esc(c.def)}</textarea>
    <div style="display:flex;align-items:flex-start;gap:4px">
      <span class="known-dot" title="${c.known?"Marked known":"Not yet known"}"></span>
      <button class="icon-btn" data-act="del-card" aria-label="Delete card">✕</button>
    </div>
  </div>`;
}
function parseBulk(text){
  return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(line=>{
    const m = line.split(/\t|;|\s+[-–—]\s+|\s*:\s+/);
    if(m.length<2) return null;
    const term=m[0].trim(), def=m.slice(1).join(" - ").trim();
    return (term&&def)? {term,def} : null;
  }).filter(Boolean);
}
async function aiCards(){
  const d=deck(); if(!d||!SAMPLE) return;
  const notes = ($("#notes").value||"").trim();
  const status = $("#aiStatus");
  if(notes.length<40){ status.textContent="Paste a bit more text first."; return; }
  const btn = $('[data-act="ai-cards"]');
  btn.disabled=true; status.textContent="Reading your notes…";
  try{
    const out = await SAMPLE.json(
      "You are making study flashcards from a student's notes.\n"+
      "Write up to 15 cards covering the most testable points. Each card has a \"term\" (a term, name, date, or short question) and a \"definition\" (one or two plain sentences answering it). Do not invent facts that are not in the notes. Write in the same language as the notes.\n"+
      "Reply with only a JSON array, like [{\"term\":\"Osmosis\",\"definition\":\"Movement of water across a membrane.\"}]\n\nNotes:\n"+
      notes.slice(0,6000)
    );
    const rows = (Array.isArray(out)? out : []).map(r=>({term:String(r&&r.term||"").trim(), def:String(r&&(r.definition||r.def)||"").trim()})).filter(r=>r.term&&r.def);
    if(!rows.length){ status.textContent="No cards came back. Try a clearer chunk of notes."; return; }
    rows.forEach(r=> d.cards.push({id:uid(),term:r.term,def:r.def,known:false}));
    touch(d);
    $("#notes").value="";
    status.textContent = rows.length+" cards added below — check them over.";
    study.order=[]; mounted=""; render();
    toast(rows.length+" cards drafted");
  }catch(e){
    if(e.code==="not_granted"||e.code==="sampling_disabled") status.textContent="Claude isn't available for this page.";
    else if(e.code==="rate_limited") status.textContent="Too many requests — wait a minute and try again.";
    else if(e.code==="prompt_too_large") status.textContent="That's a lot of text. Paste a smaller section.";
    else if(e.code==="invalid_json") status.textContent="The draft came back malformed. Try again.";
    else status.textContent="That didn't work. Try again.";
  }finally{ if(btn) btn.disabled=false; }
}

/* ================= events ================= */
document.addEventListener("click", e=>{
  const deckBtn = e.target.closest("[data-deck]");
  if(deckBtn){
    state.deckId = deckBtn.dataset.deck;
    study.order=[]; study.i=0; study.flipped=false; quiz=null;
    document.body.classList.remove("drawer");
    mounted=""; render(); return;
  }
  const opt = e.target.closest("[data-opt]");
  if(opt && !opt.disabled){ answerQuestion(quiz.qs[quiz.i].options[Number(opt.dataset.opt)]); return; }
  const chipC = e.target.closest("[data-count]");
  if(chipC){
    quiz.cfg.count=Number(chipC.dataset.count);
    mounted=""; render();
    const inp=$("#customCount"); if(inp) inp.value=quiz.cfg.count;
    return;
  }
  const chipT = e.target.closest("[data-type]");
  if(chipT){
    const k=chipT.dataset.type, list=quiz.cfg.types;
    if(list.includes(k)){ if(list.length>1) quiz.cfg.types=list.filter(x=>x!==k); }
    else quiz.cfg.types=list.concat(k);
    mounted=""; render(); return;
  }
  if(e.target.closest("#card")){ study.flipped=!study.flipped; paintCard(); return; }

  const act = e.target.closest("[data-act]");
  if(!act) return;
  const d=deck();
  switch(act.dataset.act){
    case "new-deck": newDeck(); break;
    case "starter": makeDeck("General Biology — starter", STARTER); study.order=[]; mounted=""; render(); toast("Starter deck added"); break;
    case "go-edit": state.tab="edit"; mounted=""; render(); break;
    case "prev": moveCard(-1); break;
    case "next": moveCard(1); break;
    case "again": markCard(false); break;
    case "got": markCard(true); break;
    case "shuffle": study.order=shuffle(study.order); study.i=0; study.flipped=false; study.explain=""; paintCard(); toast("Shuffled"); break;
    case "unknown-only": {
      if(!d) break;
      const left=d.cards.filter(c=>!c.known).map(c=>c.id);
      if(!left.length){ toast("Every card is marked known."); break; }
      study.order=left; study.i=0; study.flipped=false; study.explain=""; paintCard();
      toast(left.length+" cards left to learn"); break;
    }
    case "reset-known": {
      if(!d) break;
      d.cards.forEach(c=>c.known=false); touch(d);
      study.order=d.cards.map(c=>c.id); study.i=0; study.flipped=false;
      mounted=""; render(); toast("Marks cleared"); break;
    }
    case "explain": explainCard(); break;
    case "start-test": startTest(); break;
    case "gen-test": generateTestFromLesson(); break;
    case "check": answerQuestion($("#written").value); break;
    case "skip": answerQuestion(""); break;
    case "next-q": nextQuestion(); break;
    case "retake": startTest(); break;
    case "test-setup": quiz.stage="setup"; mounted=""; render(); break;
    case "study-missed": {
      const ids=quiz.results.filter(r=>!r.ok).map(r=>r.q.card.id);
      state.tab="study"; study.order=ids; study.i=0; study.flipped=false; mounted=""; render(); break;
    }
    case "add-card": {
      if(!d) break;
      d.cards.push({id:uid(),term:"",def:"",known:false}); touch(d);
      mounted=""; render();
      const rows=$$("#cardRows .card-row"); const last=rows[rows.length-1];
      if(last) last.querySelector("textarea").focus();
      break;
    }
    case "del-card": {
      if(!d) break;
      const row=act.closest("[data-card]");
      d.cards=d.cards.filter(c=>c.id!==row.dataset.card); touch(d);
      study.order=[]; mounted=""; render(); break;
    }
    case "bulk": {
      if(!d) break;
      const rows=parseBulk($("#bulk").value);
      if(!rows.length){ toast("Couldn't read any pairs from that."); break; }
      rows.forEach(r=> d.cards.push({id:uid(),term:r.term,def:r.def,known:false}));
      touch(d); study.order=[]; mounted=""; render(); toast(rows.length+" cards added"); break;
    }
    case "ai-cards": aiCards(); break;
    case "delete-deck": {
      if(!d) break;
      if(confirm('Delete "'+d.name+'" and all its cards? This cannot be undone.')) removeDeck(d.id);
      break;
    }
  }
});
document.addEventListener("input", e=>{
  if(e.target.id==="customCount"){
    const d=deck(); if(!d||!quiz) return;
    let n = Math.round(Number(e.target.value));
    if(!Number.isFinite(n)) return;
    n = Math.max(1, Math.min(d.cards.length, n));
    quiz.cfg.count = n;
    $$("#countChips .chip").forEach(c=> c.setAttribute("aria-pressed", String(Number(c.dataset.count)===n)));
    return;
  }
  const d=deck(); if(!d) return;
  if(e.target.id==="deckName"){ d.name=e.target.value; touch(d); renderSidebar(); renderChip(); return; }
  const row=e.target.closest("[data-card]");
  if(row && e.target.matches("textarea")){
    const c=d.cards.find(x=>x.id===row.dataset.card); if(!c) return;
    c[e.target.dataset.side==="term"?"term":"def"]=e.target.value;
    touch(d);
  }
});
document.addEventListener("keydown", e=>{
  if(e.target.matches("input,textarea")){
    if(e.key==="Enter" && e.target.id==="written"){ e.preventDefault(); answerQuestion(e.target.value); }
    return;
  }
  if(state.tab==="study" && deck() && deck().cards.length){
    if(e.code==="Space"){ e.preventDefault(); study.flipped=!study.flipped; paintCard(); }
    else if(e.key==="ArrowRight") moveCard(1);
    else if(e.key==="ArrowLeft") moveCard(-1);
    else if(e.key==="1") markCard(false);
    else if(e.key==="2") markCard(true);
  }
  if(state.tab==="test" && quiz && quiz.stage==="run" && !quiz.checked){
    const q=quiz.qs[quiz.i];
    if(q.kind!=="written"){
      const n="abcd".indexOf(e.key.toLowerCase());
      if(n>-1 && q.options[n]) answerQuestion(q.options[n]);
    }
  }
  if(state.tab==="test" && quiz && quiz.stage==="run" && quiz.checked && e.key==="Enter"){ e.preventDefault(); nextQuestion(); }
});
$("#tabs").addEventListener("click", e=>{
  const t=e.target.closest(".tab"); if(!t) return;
  state.tab=t.dataset.tab; mounted=""; render();
});
$("#newDeckBtn").addEventListener("click", newDeck);
$("#sampleDeckBtn").addEventListener("click", ()=>{ makeDeck("General Biology — starter", STARTER); study.order=[]; mounted=""; render(); toast("Starter deck added"); });
$("#drawerBtn").addEventListener("click", ()=> document.body.classList.toggle("drawer"));
$("#overlay").addEventListener("click", ()=> document.body.classList.remove("drawer"));

function applyTheme(mode){
  document.documentElement.setAttribute("data-theme", mode==="dark"?"dark":"light");
  try{ localStorage.setItem("repaso.theme", mode==="dark"?"dark":"light"); }catch(e){}
  const btn=$("#themeBtn");
  if(btn) btn.textContent = mode==="dark" ? "Daylight" : "Lights out";
}
try{
  const saved = localStorage.getItem("repaso.theme");
  applyTheme(saved==="dark"?"dark":"light");
}catch(e){ applyTheme("light"); }
$("#themeBtn").addEventListener("click", ()=>{
  const next = document.documentElement.getAttribute("data-theme")==="dark" ? "light" : "dark";
  applyTheme(next);
});

/* ================= boot ================= */
loadLocal();
if(state.decks.length) state.deckId = state.decks[0].id;
render();
connect();
})();
