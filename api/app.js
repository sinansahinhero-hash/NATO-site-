const BRANSLAR = [
 {ad:"Kara Kuvvetleri",acik:"Karadan sorumlu branştır.",birim:["BÖRÜ","KHO","MUHABERE ARAMA KURTARMA"]},
 {ad:"Sınır Müfettişleri",acik:"Sınırdan sorumlu branştır.",birim:["GARDİYAN MUHAFIZLAR","DENETİM BİRİMİ"]},
 {ad:"Askerî İnzibat",acik:"Asayişten sorumlu branştır.",birim:["YILDIRIM ORDULARI","KIZIL SAĞ EL"]},
 {ad:"Özel Kuvvetler",acik:"Operasyonlardan sorumlu branştır.",birim:["SAT","ÖZEL KORUMA BİRLİĞİ","OMEGA"]}
];
const EMEK = [
 ["Herobrine_sinan","NATO Başkomutanı","NATO’nun askerî olmasını sağlayan lider."],
 ["Yusufg","Kurucu ve Yönetim Kurulu Başkanlarından biri","Ulusun ilk kurucularından biridir."],
 ["Omer_salih","Kurucu","Ulusun kurucularından biridir."],
 ["Tahirg","Kurucu","Ulusun kurucularından biridir."]
];
const BOTLAR = [["NATO","Ana bot. /update komutuyla onaylanan rolleri verir."],["NATO Moderasyon","Sunucu moderasyonu ve kayıtlar için kullanılır."]];
const DOCS = {
 tos:["Hizmet Şartları","Bu metin yer tutucudur. Kuralları, yaptırımları ve hesap kullanım şartlarını buraya yaz."],
 privacy:["Gizlilik Politikası","Bu metin yer tutucudur. Discord (kullanıcı adı, avatar, e-posta, sunucu listesi) ve Minecraft adı verisinin neden alındığını, profillerin diğer kullanıcılara görünebildiğini ve verilerin nasıl saklandığını buraya yaz."]
};
const KAT = {ban:"Ban Affı",destek:"Discord Destek",askeri:"Askerî Şikayet",ulusal:"Ulusal Şikayet"};
const PERM_ETIKET = {...KAT,gruplar:"Grup istekleri"};
const DURUM = {open:"Açık",locked:"Kilitli",closed:"Kapalı"};
const GDURUM = {pending:"Beklemede",approved:"Onaylandı",rejected:"Reddedildi"};

const $=s=>document.querySelector(s);
const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dt=t=>new Date(t).toLocaleString("tr-TR",{dateStyle:"short",timeStyle:"short"});
async function api(path,opt={}){
  const r=await fetch(path,{method:opt.method||"GET",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:opt.body?JSON.stringify(opt.body):undefined});
  let d=null;try{d=await r.json()}catch(e){}
  if(!r.ok){const e=new Error(d&&d.error||"Bir hata oluştu.");e.status=r.status;throw e}
  return d;
}

let me=null,view="home",ticketId=null,timer=null;
const isStaff=()=>me&&me.perms.length>0;

/* ---- Menü ---- */
function bolumler(){
  const l=[["home","Ana Sayfa"],["destek","Destek"],["bransl","Branşlar"],["emek","Emeği Geçenler"],["gruplar","Gruplar"],["profil","Profil Ara"],["hesap","Hesap"],["botlar","Botlar"]];
  if(me&&(me.isOwner||me.canManage))l.push(["yonetim","Yönetim"]);
  return l;
}
function buildDrawer(){$("#drawer").innerHTML="<h2>NATO</h2>"+bolumler().map(([k,a])=>`<button data-go="${k}" class="${view===k?"cur":""}">${a}</button>`).join("")}
function drawer(on){$("#drawer").classList.toggle("on",on);$("#scrim").classList.toggle("on",on)}
$("#homeBtn").onclick=()=>{buildDrawer();drawer(!$("#drawer").classList.contains("on"))};
$("#scrim").onclick=()=>drawer(false);
$("#drawer").onclick=e=>{const b=e.target.closest("[data-go]");if(b){go(b.dataset.go);drawer(false)}};
document.addEventListener("keydown",e=>{if(e.key==="Escape")drawer(false)});
const dlg=$("#dlg");
function modal(h,lock){dlg.innerHTML=h;dlg.oncancel=lock?e=>e.preventDefault():null;if(!dlg.open)dlg.showModal()}
document.querySelectorAll("[data-doc]").forEach(b=>b.onclick=()=>{const d=DOCS[b.dataset.doc];modal(`<h3 style="font-size:24px;color:var(--gold)">${d[0]}</h3><p style="color:var(--mute)">${d[1]}</p><button onclick="dlg.close()">Kapat</button>`)});

/* ---- Üst şerit ---- */
function authSlot(){
  const s=$("#authSlot");
  if(me){s.innerHTML=`<button class="icon" id="av" aria-label="Hesap">${me.avatar?`<img src="${esc(me.avatar)}" alt="">`:esc(me.username[0].toUpperCase())}</button>`;$("#av").onclick=()=>go("hesap")}
  else{s.innerHTML=`<button class="primary" id="loginBtn">Giriş Yap</button>`;$("#loginBtn").onclick=loginModal}
}
function loginModal(){
  modal(`<h3 style="font-size:24px;color:var(--gold)">Giriş Yap</h3>
  <p style="color:var(--mute)">Discord hesabınla giriş yap. İlk girişte Minecraft adını da yazacaksın.</p>
  <button class="oauth discord" id="bd">Discord ile giriş yap</button>
  <div class="row" style="margin-top:16px"><button onclick="dlg.close()">İptal</button></div>`);
  $("#bd").onclick=()=>{location.href="/api/auth/discord"};
}
function mcModal(){
  modal(`<h3 style="font-size:24px;color:var(--gold)">Minecraft adın</h3>
  <p style="color:var(--mute)">Sunucu takma adın bu isim olacak. Kaydedince kendin değiştiremezsin, dikkatli yaz.</p>
  <label>Sürüm</label><select id="me"><option value="java">Java Edition</option><option value="bedrock">Bedrock Edition</option></select>
  <label>Minecraft adı</label><input id="mn" maxlength="16" autocomplete="off">
  <div class="err" id="er"></div>
  <div class="row sp" style="margin-top:8px"><button id="mo">Çıkış yap</button><button class="gold" id="ms">Kaydet</button></div>`,true);
  $("#mo").onclick=logout;
  $("#ms").onclick=async()=>{
    $("#ms").disabled=true;
    try{await api("/api/minecraft",{method:"POST",body:{edition:$("#me").value,name:$("#mn").value}});me=await api("/api/me");dlg.close();authSlot();go(view)}
    catch(e){$("#er").textContent=e.message;$("#ms").disabled=false}
  };
}
async function logout(){try{await api("/api/logout",{method:"POST"})}catch(e){}me=null;if(dlg.open)dlg.close();authSlot();go("home")}

/* ---- Yönlendirme ---- */
function go(v){view=v;ticketId=null;profilId=null;clearInterval(timer);buildDrawer();render();window.scrollTo(0,0)}
function needLogin(t){$("#main").innerHTML=`<h2 class="t">${t}</h2><div class="card"><p>Bu bölümü kullanmak için giriş yapmalısın.</p><button class="primary" id="l2">Giriş Yap</button></div>`;$("#l2").onclick=loginModal}
function fail(e){if(e.status===401){me=null;authSlot();needLogin("Oturum süresi doldu");return}$("#main").innerHTML=`<div class="card"><p style="margin:0">${esc(e.message)}</p></div>`}

async function render(){
  const m=$("#main");
  try{
  if(view==="home"){
    m.innerHTML=`<section class="hero"><h1>NATO</h1><p>Hiyerarşi, disiplin ve operasyonel mükemmellik ilkesiyle hareket eden elit askerî topluluk.</p></section>
    <div class="card"><h3>Biz kimiz?</h3><p>NATO; Minecraft ve Discord üzerinde örgütlü, branşlara ve birimlere ayrılmış bir askerî topluluktur. Sol üstteki ev düğmesinden branşlara, destek taleplerine ve gruplara ulaşabilirsin.</p></div>
    <div class="row"><button class="gold" data-go3="bransl">Branşları gör</button><button data-go3="destek">Destek al</button></div>`;
    document.querySelectorAll("[data-go3]").forEach(b=>b.onclick=()=>go(b.dataset.go3));
  }
  else if(view==="bransl")m.innerHTML=`<h2 class="t">Askerî Branşlar ve Birimler</h2>`+BRANSLAR.map(b=>`<div class="card"><h3>${b.ad}</h3><p>${b.acik}</p><div class="tags">${b.birim.map(x=>`<span class="tag">${x}</span>`).join("")}</div></div>`).join("");
  else if(view==="emek")m.innerHTML=`<h2 class="t">Emeği Geçenler</h2>`+EMEK.map(e=>`<div class="card row"><div class="avatar">${e[0][0]}</div><div><h3>${e[0]}</h3><b>${e[1]}</b><p style="margin:0">${e[2]}</p></div></div>`).join("");
  else if(view==="botlar")m.innerHTML=`<h2 class="t">Botlar</h2>`+BOTLAR.map(b=>`<div class="card row"><div class="avatar">${b[0][0]}</div><div><h3>${b[0]}</h3><p style="margin:0">${b[1]}</p></div></div>`).join("");
  else if(!me)needLogin({destek:"Destek",gruplar:"Gruplar",profil:"Profil Ara",hesap:"Hesap",yonetim:"Yönetim"}[view]||"");
  else if(view==="destek")await destek(m);
  else if(view==="gruplar")await gruplar(m);
  else if(view==="profil")await profilAra(m);
  else if(view==="hesap")await hesap(m);
  else if(view==="yonetim")await yonetim(m);
  }catch(e){fail(e)}
}

/* ---- Destek ---- */
async function destek(m){
  if(ticketId!==null)return ticketView(m);
  const list=await api("/api/tickets");
  m.innerHTML=`<h2 class="t">Destek</h2>
  <div class="card"><h3>Yeni talep aç</h3>
   <label>Kategori</label><select id="tc">${Object.entries(KAT).map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}</select>
   <label>Konu</label><input id="ts" maxlength="80">
   <label>Açıklama</label><textarea id="td" rows="4" maxlength="2000"></textarea>
   <p style="margin:10px 0;font-size:14px">Talebi açtığında bulunduğun Discord sunucuları yalnızca yetkililere görünür.</p>
   <button class="gold" id="tn">Talebi aç</button><div class="err" id="er"></div></div>
  <h3 style="margin:22px 0 10px;font-size:22px">${isStaff()?"Talepler":"Taleplerim"}</h3>
  ${list.length?list.map(t=>`<div class="card"><div class="row sp"><b>#${t.id} ${esc(t.subject)}</b><span class="badge b-${t.status}">${DURUM[t.status]}</span></div><p style="margin:4px 0 10px">${esc(t.categoryName)} · ${esc(t.owner)} (${esc(t.mcName)})${t.claimedBy?" · Sahiplenen: "+esc(t.claimedBy):""} · ${dt(t.createdAt)}</p><button data-t="${t.id}">Aç</button></div>`).join(""):`<div class="card"><p style="margin:0">Henüz talep yok.</p></div>`}`;
  $("#tn").onclick=async()=>{
    $("#tn").disabled=true;
    try{const r=await api("/api/tickets",{method:"POST",body:{category:$("#tc").value,subject:$("#ts").value,body:$("#td").value}});ticketId=r.id;render()}
    catch(e){$("#er").textContent=e.message;$("#tn").disabled=false}
  };
  m.querySelectorAll("[data-t]").forEach(b=>b.onclick=()=>{ticketId=+b.dataset.t;render()});
}
async function ticketView(m){
  const d=await api("/api/tickets/"+ticketId);
  const t=d.ticket,st=d.canStaff;
  const typing=document.activeElement&&document.activeElement.id==="mt"&&document.activeElement.value;
  if(typing)return;
  const canWrite=t.status==="open"||(t.status==="locked"&&st);
  m.innerHTML=`<button id="bk">← Taleplere dön</button>
  <div class="card" style="margin-top:14px"><div class="row sp"><h3>#${t.id} ${esc(t.subject)}</h3><span class="badge b-${t.status}">${DURUM[t.status]}</span></div><p style="margin:0">${esc(t.categoryName)} · ${esc(t.owner)}${t.claimedBy?" · Sahiplenen: "+esc(t.claimedBy):""}</p></div>
  ${st?`<div class="card"><h3>Yetkili bölümü</h3>
    <div class="row"><button class="gold" data-a="${t.claimedBy?"unclaim":"claim"}">${t.claimedBy?"Sahiplenmeyi bırak":"Sahiplen"}</button>
    <button data-a="${t.status==="locked"?"unlock":"lock"}" ${t.status==="closed"?"disabled":""}>${t.status==="locked"?"Kilidi aç":"Kilitle"}</button>
    <button class="danger" data-a="${t.status==="closed"?"reopen":"close"}">${t.status==="closed"?"Yeniden aç":"Kapat"}</button></div>
    <p style="margin:14px 0 6px">Talep sahibi: <b>${esc(d.ownerInfo.username)}</b> (Discord ID ${esc(d.ownerInfo.id)}) · Minecraft: <b>${esc(d.ownerInfo.mcName)}</b> (${esc(d.ownerInfo.mcEdition)})</p>
    <p style="margin:0 0 6px">Bulunduğu Discord sunucuları:</p><div class="tags">${(d.ownerInfo.guilds||[]).map(g=>`<span class="tag">${esc(g.name)}</span>`).join("")||"<span style='color:var(--mute)'>Bilgi yok</span>"}</div></div>`:""}
  <div class="card"><h3>Yazışma</h3>${d.messages.map(x=>`<div class="msg ${x.isStaff?"staff":""}"><small>${esc(x.author)}${x.isStaff?" (yetkili)":""} · ${dt(x.at)}</small><br>${esc(x.body)}</div>`).join("")}
   ${canWrite?`<textarea id="mt" rows="3" maxlength="2000" placeholder="Mesajını yaz"></textarea><button class="primary" id="ms" style="margin-top:8px">Gönder</button><div class="err" id="er"></div>`:`<p style="margin:10px 0 0">Bu talebe mesaj yazılamıyor.</p>`}</div>`;
  $("#bk").onclick=()=>{ticketId=null;clearInterval(timer);render()};
  const ms=$("#ms");
  if(ms)ms.onclick=async()=>{const v=$("#mt").value.trim();if(!v)return;ms.disabled=true;try{await api(`/api/tickets/${t.id}/messages`,{method:"POST",body:{body:v}});$("#mt").value="";render()}catch(e){$("#er").textContent=e.message;ms.disabled=false}};
  m.querySelectorAll("[data-a]").forEach(b=>b.onclick=async()=>{try{await api(`/api/tickets/${t.id}/action`,{method:"POST",body:{action:b.dataset.a}});render()}catch(e){alert(e.message)}});
  clearInterval(timer);timer=setInterval(()=>{if(view==="destek"&&ticketId!==null)render();else clearInterval(timer)},8000);
}

/* ---- Gruplar ---- */
async function gruplar(m){
  const g=await api("/api/groups");
  const branches=[...new Set(g.map(x=>x.branch))];
  let h=`<h2 class="t">Gruplar</h2><div class="note">Bir gruba istek at. Yetkililer onaylayınca, Discord’da NATO botuna <b>/update</b> yazdığında o grubun rolleri verilir.</div>`;
  h+=branches.map(b=>`<div class="card"><h3>${esc(b)}</h3>${g.filter(x=>x.branch===b).map(x=>`<div class="row sp line"><span>${esc(x.label)}</span>${x.status?`<span class="badge b-${x.status}">${GDURUM[x.status]}</span>`:""}${(!x.status||x.status==="rejected")?`<button data-g="${x.key}">${x.status?"Tekrar istek at":"İstek at"}</button>`:""}</div>`).join("")}</div>`).join("");
  if(me.perms.includes("gruplar")||me.canManage){
    const p=await api("/api/groups/pending");
    h+=`<h3 style="margin:22px 0 10px;font-size:22px">Bekleyen istekler</h3>`+(p.length?p.map(r=>`<div class="card row sp"><span><b>${esc(r.username)}</b> (${esc(r.mcName)}) → ${esc(r.group)}</span><span class="row"><button class="ok" data-d="approved" data-i="${r.id}">Onayla</button><button class="danger" data-d="rejected" data-i="${r.id}">Reddet</button></span></div>`).join(""):`<div class="card"><p style="margin:0">Bekleyen istek yok.</p></div>`);
  }
  m.innerHTML=h;
  m.querySelectorAll("[data-g]").forEach(b=>b.onclick=async()=>{try{await api(`/api/groups/${b.dataset.g}/request`,{method:"POST"});render()}catch(e){alert(e.message)}});
  m.querySelectorAll("[data-d]").forEach(b=>b.onclick=async()=>{try{await api("/api/groups/requests/"+b.dataset.i,{method:"POST",body:{decision:b.dataset.d}});render()}catch(e){alert(e.message)}});
}

/* ---- Hesap ---- */
async function hesap(m){
  m.innerHTML=`<h2 class="t">Hesap</h2><div id="hp"></div>
  ${me.perms.length?`<div class="card"><h3>Yetkilerin</h3><div class="tags">${me.perms.map(p=>`<span class="tag">${esc(PERM_ETIKET[p]||p)}</span>`).join("")}</div></div>`:""}
  <button class="danger" id="lo">Çıkış yap</button>`;
  $("#lo").onclick=logout;
  try{const p=await api("/api/profiles/me");$("#hp").innerHTML=profilHtml(p,false)}
  catch(e){$("#hp").innerHTML=`<div class="card"><p style="margin:0">${esc(e.message)}</p></div>`}
}

/* ---- Başlangıç ---- */
authSlot();buildDrawer();render();
api("/api/me").then(u=>{me=u;authSlot();buildDrawer();render();if(me&&!me.mcName)mcModal()}).catch(()=>{});
