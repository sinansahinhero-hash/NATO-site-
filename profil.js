let profilId=null;

function pAv(p){
  return `<div class="avatar">${p.avatar?`<img src="${esc(p.avatar)}" alt="">`:esc(((p.mcName||p.username||"?")[0]).toUpperCase())}</div>`;
}

function profilHtml(p,acts){
  const head=`<div class="card row">${pAv(p)}<div><h3>${esc(p.mcName||"—")}</h3><p style="margin:0">Discord: ${esc(p.username)}${p.mcEdition?" · "+(p.mcEdition==="bedrock"?"Bedrock":"Java"):""}</p></div></div>`;
  if(!p.groups.length)return head+`<div class="card"><p style="margin:0">Henüz bir grupta değil.</p></div>`;
  return head+p.groups.map(x=>`<div class="card">
    <div class="row sp"><h3>${esc(x.label)}</h3>${acts&&x.canKick?`<button class="danger sm" data-kick="${esc(x.key)}">Gruptan at</button>`:""}</div>
    <p style="margin:0 0 8px">${esc(x.branch)}</p>
    ${x.ranks.length?x.ranks.map(r=>`<div class="row sp line"><span><b>${esc(r.name)}</b> <small style="color:var(--mute)">· ${esc(r.guilds.join(", ")||"Tüm sunucular")}</small></span>${acts&&r.canTake?`<button class="rm" data-take="${r.id}" data-gk="${esc(x.key)}">Rütbeyi al</button>`:""}</div>`).join(""):`<p style="margin:0">Rütbe yok.</p>`}
  </div>`).join("");
}

function profilBagla(m,p,reload){
  m.querySelectorAll("[data-kick]").forEach(b=>b.onclick=async()=>{
    if(!confirm("Bu kişi gruptan atılsın mı? Rolleri, kişi /update yazınca alınır."))return;
    try{await api(`/api/groups/${b.dataset.kick}/kick`,{method:"POST",body:{userId:p.id}});reload()}catch(e){alert(e.message)}
  });
  m.querySelectorAll("[data-take]").forEach(b=>b.onclick=async()=>{
    if(!confirm("Rütbe alınsın mı? Rolü, kişi /update yazınca alınır."))return;
    try{await api("/api/manage/rank/take",{method:"POST",body:{target:p.id,groupKey:b.dataset.gk,rankIds:[Number(b.dataset.take)]}});reload()}catch(e){alert(e.message)}
  });
}

async function profilAra(m){
  if(profilId!==null){
    const p=await api("/api/profiles/"+encodeURIComponent(profilId));
    m.innerHTML=`<button id="pb">← Aramaya dön</button><div style="margin-top:14px">${profilHtml(p,true)}</div>`;
    $("#pb").onclick=()=>{profilId=null;render()};
    profilBagla(m,p,()=>render());
    return;
  }
  m.innerHTML=`<h2 class="t">Profil Ara</h2>
  <div class="card"><label style="margin-top:0">Minecraft adı, Discord adı veya Discord ID</label>
  <div class="row"><input id="pq" style="flex:1;min-width:180px" autocomplete="off"><button class="gold" id="ps">Ara</button></div></div>
  <div id="pr"></div>`;
  const ara=async()=>{
    const q=$("#pq").value.trim();
    if(q.length<2){$("#pr").innerHTML=`<div class="card"><p style="margin:0">En az 2 karakter yaz.</p></div>`;return}
    try{
      const l=await api("/api/profiles?q="+encodeURIComponent(q));
      $("#pr").innerHTML=l.length?l.map(p=>`<div class="card row sp"><span class="row">${pAv(p)}<span><b>${esc(p.mcName)}</b><br><small style="color:var(--mute)">${esc(p.username)}</small></span></span><button data-pid="${esc(p.id)}">Profili aç</button></div>`).join(""):`<div class="card"><p style="margin:0">Sonuç yok. Kişi siteye en az bir kez giriş yapmış olmalı.</p></div>`;
      $("#pr").querySelectorAll("[data-pid]").forEach(b=>b.onclick=()=>{profilId=b.dataset.pid;render()});
    }catch(e){$("#pr").innerHTML=`<div class="card"><p style="margin:0">${esc(e.message)}</p></div>`}
  };
  $("#ps").onclick=ara;
  $("#pq").onkeydown=e=>{if(e.key==="Enter")ara()};
                  }
