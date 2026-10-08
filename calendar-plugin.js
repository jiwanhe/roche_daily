/**
 * 日曆同步 — Roche Plugin v2
 * 拉取 Google 日曆 → 發訊息/寫記憶給 char
 * char 可以在聊天中用特定格式幫你新增行程
 */
(function(){
'use strict';
const app={
  id:'calendar-sync',name:'日曆同步',icon:'chat',iconImage:'',

  async mount(container,roche){
    const BG='#fff',T1='#1a1a1a',T2='#555',T3='#999',BD='#E8E4DF',
          ACC='#4285F4',ACCL='#E8F0FE',ACCD='#1967D2';
    const DAY_NAMES=['日','一','二','三','四','五','六'];

    // char 新增行程的格式標記（寫進 memory 讓 char 學會用）
    const ADD_TAG_OPEN='[CalAdd]';
    const ADD_TAG_CLOSE='[/CalAdd]';
    const ADD_FORMAT_EXAMPLE='[CalAdd]{"title":"牙醫回診","date":"2026-09-05","startTime":"2026-09-05T14:00","endTime":"2026-09-05T15:00","location":"台北長庚"}[/CalAdd]';

    // ── State ──
    const S={
      showSettings:false,
      cfg:{scriptUrl:'',secretKey:'',charId:'',charName:'',convId:'',userName:''},
      events:[],lastFetched:'',
      fetching:false,fetchMsg:'',fetchErr:false,
      syncMsg:'',syncErr:false,
      pendingAdds:[],   // 從對話掃描到的待新增事件
      scanning:false,
      addMsg:'',addErr:false,
      charList:[],convList:[],
    };

    const load=async k=>{try{const s=await roche.storage.get(k);return s?JSON.parse(s):null}catch(_){return null}};
    const sv=async(k,v)=>{try{await roche.storage.set(k,JSON.stringify(v))}catch(_){}};
    Object.assign(S.cfg,(await load('cal2_cfg'))||{});
    S.events=(await load('cal2_events'))||[];
    S.lastFetched=(await load('cal2_lastFetch'))||'';
    const saveCfg=()=>sv('cal2_cfg',S.cfg);
    const saveEvents=()=>{sv('cal2_events',S.events);sv('cal2_lastFetch',S.lastFetched);};

    try{S.charList=await roche.character.list()||[]}catch(_){}
    try{S.convList=await roche.conversation.list()||[]}catch(_){}
    if(!S.cfg.userName){try{const u=await roche.persona.getActiveUserPersona();if(u)S.cfg.userName=u.name||u.handle||'';}catch(_){}}
    if(!S.cfg.charId&&S.charList.length){S.cfg.charId=S.charList[0].id;S.cfg.charName=S.charList[0].name}
    if(!S.cfg.convId&&S.convList.length){
      const match=S.convList.find(c=>c.contactId===S.cfg.charId||c.name===S.cfg.charName);
      S.cfg.convId=(match||S.convList[0]).conversationId||(match||S.convList[0]).id;
    }

    // ── 日期工具 ──
    function ds(d){return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
    function fmtDate(iso){const d=new Date(iso);return`${d.getMonth()+1}/${d.getDate()}（${DAY_NAMES[d.getDay()]}）`}
    function fmtTime(iso){const d=new Date(iso);return`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
    function isToday(iso){return ds(new Date(iso))===ds(new Date())}
    function isTomorrow(iso){const t=new Date();t.setDate(t.getDate()+1);return ds(new Date(iso))===ds(t)}
    function isPast(iso){return new Date(iso)<new Date()}
    function toRocheUTC(d){const dt=d instanceof Date?d:new Date(d);return`${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')} ${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')} UTC`}

    function groupEvents(){
      const today=[],tomorrow=[],thisWeek=[],later=[],past=[];
      const now=new Date(),weekEnd=new Date(now);weekEnd.setDate(weekEnd.getDate()+(7-weekEnd.getDay()));
      S.events.forEach(ev=>{
        if(isPast(ev.endTime||ev.startTime)){past.push(ev);return;}
        if(isToday(ev.startTime)){today.push(ev);return;}
        if(isTomorrow(ev.startTime)){tomorrow.push(ev);return;}
        if(new Date(ev.startTime)<=weekEnd){thisWeek.push(ev);return;}
        later.push(ev);
      });
      return{today,tomorrow,thisWeek,later,past};
    }

    // ── 拉取 ──
    async function fetchCalendar(){
      const url=S.cfg.scriptUrl;
      if(!url){S.fetchMsg='請先到設定填入 Google Apps Script URL';S.fetchErr=true;render();return;}
      S.fetching=true;S.fetchMsg='';render();
      try{
        const res=await fetch(url);
        if(!res.ok)throw new Error('HTTP '+res.status);
        const data=await res.json();
        if(!data.success)throw new Error(data.error||'回應格式錯誤');
        S.events=data.events||[];
        S.lastFetched=new Date().toISOString();
        saveEvents();
        S.fetchMsg=`✅ ${S.events.length} 個事件`;S.fetchErr=false;
        toast('📅 已取得 '+S.events.length+' 個行程');
      }catch(e){S.fetchMsg='失敗：'+e.message;S.fetchErr=true;}
      S.fetching=false;render();
    }

    // ── 建構行程文字 ──
    function buildScheduleText(){
      if(!S.events.length)return null;
      const g=groupEvents();
      const today=ds(new Date());
      let t=`📅 ${S.cfg.userName||'我'}的近期日程（${today}）\n`;
      if(g.today.length){t+=`\n【今天】\n`;g.today.forEach(ev=>{t+=`• ${ev.isAllDay?'全天':fmtTime(ev.startTime)+'~'+fmtTime(ev.endTime)} ${ev.title}${ev.location?' @ '+ev.location:''}\n`;});}
      else t+=`\n【今天】沒有行程\n`;
      if(g.tomorrow.length){t+=`\n【明天】\n`;g.tomorrow.forEach(ev=>{t+=`• ${ev.isAllDay?'全天':fmtTime(ev.startTime)} ${ev.title}${ev.location?' @ '+ev.location:''}\n`;});}
      if(g.thisWeek.length){t+=`\n【本週】\n`;g.thisWeek.forEach(ev=>{t+=`• ${fmtDate(ev.startTime)} ${ev.isAllDay?'全天':fmtTime(ev.startTime)} ${ev.title}\n`;});}
      if(g.later.length){t+=`\n【之後】\n`;g.later.slice(0,15).forEach(ev=>{t+=`• ${fmtDate(ev.startTime)} ${ev.title}\n`;});}
      return t;
    }

    // ── 寫入記憶（含 char 新增行程的格式指令）──
    async function syncToMemory(){
      const text=buildScheduleText();
      if(!text){S.syncMsg='沒有事件，請先拉取日曆';S.syncErr=true;render();return;}
      const convId=S.cfg.convId;
      if(!convId){S.syncMsg='請到設定選擇對話';S.syncErr=true;render();return;}
      // 加上「char 可以幫 user 新增行程」的格式指令
      const fullText=text+`\n\n---\n[系統提示] 如果${S.cfg.userName||'User'}需要你幫忙新增行程到日曆，請用以下格式回覆，我的日曆系統會自動識別並新增：\n格式：${ADD_FORMAT_EXAMPLE}\n必要欄位：title、date（YYYY-MM-DD）。選填：startTime、endTime（ISO格式）、location。全天事件只需 title+date。`;
      try{
        const utcStr=toRocheUTC(new Date());
        await roche.memory.write({
          conversationId:convId,summaryText:fullText,
          who:[S.cfg.userName||'用戶',S.cfg.charName||'角色'],
          action:fullText,when:utcStr+' -> '+utcStr,where:'日曆同步',
          source:'plugin:calendar-sync'
        });
        S.syncMsg='✅ 已同步（含行程新增指令）';S.syncErr=false;toast('✨ 已同步');
      }catch(e){S.syncMsg='同步失敗：'+e.message;S.syncErr=true;}
      render();
    }

    // ── 複製到剪貼板（讓 user 直接貼到聊天裡）──
    async function copyAsMessage(){
      const text=buildScheduleText();
      if(!text){toast('沒有事件');return;}
      try{await navigator.clipboard.writeText(text);toast('📋 已複製，去聊天視窗貼上吧');}
      catch(_){
        // Fallback for environments where clipboard API is blocked
        const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;opacity:0';
        document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
        toast('📋 已複製');
      }
    }

    // ── 掃描對話：找 char 用 [CalAdd] 格式新增的行程 ──
    async function scanForAdds(){
      S.scanning=true;S.addMsg='';S.pendingAdds=[];render();
      try{
        // 抓所有相關對話的近期訊息
        const allMsgs=[];
        const convIds=S.convList.filter(c=>{const ci=c.contactId||'';const ps=c.participants||[];const cid=c.conversationId||c.id||'';return ci===S.cfg.charId||ps.includes(S.cfg.charId)||cid.startsWith('group_');}).map(c=>c.conversationId||c.id);
        if(convIds.length){
          for(const cid of convIds){
            try{const stm=await roche.memory.getShortTerm({conversationId:cid});if(Array.isArray(stm))allMsgs.push(...stm);}
            catch(_){try{const stm=await roche.memory.getShortTerm();if(Array.isArray(stm))allMsgs.push(...stm);}catch(_2){}break;}
          }
        }else{
          try{const stm=await roche.memory.getShortTerm();if(Array.isArray(stm))allMsgs.push(...stm);}catch(_){}
        }
        // 在 char 的訊息裡找 [CalAdd]...[/CalAdd]
        const re=/\[CalAdd\]([\s\S]*?)\[\/CalAdd\]/g;
        const found=[];
        allMsgs.filter(m=>!m.isMe&&m.text).forEach(m=>{
          let match;
          while((match=re.exec(m.text))!==null){
            try{
              const ev=JSON.parse(match[1].trim());
              if(ev.title)found.push({...ev,sourceMsg:m.text.slice(0,80),timestamp:m.timestamp});
            }catch(_){}
          }
        });
        // 去重（同 title+date 視為同一個）
        const seen=new Set();
        S.pendingAdds=found.filter(ev=>{const k=(ev.title||'')+(ev.date||ev.startTime||'');if(seen.has(k))return false;seen.add(k);return true;});
        S.addMsg=S.pendingAdds.length?`找到 ${S.pendingAdds.length} 個待新增行程`:'沒有找到 [CalAdd] 格式的行程';
        S.addErr=!S.pendingAdds.length;
      }catch(e){S.addMsg='掃描失敗：'+e.message;S.addErr=true;}
      S.scanning=false;render();
    }

    // ── 確認新增行程到 Google Calendar ──
    async function confirmAddEvents(){
      if(!S.pendingAdds.length)return;
      const url=S.cfg.scriptUrl;
      if(!url){S.addMsg='請先設定 Apps Script URL';S.addErr=true;render();return;}
      try{
        const body={events:S.pendingAdds};
        if(S.cfg.secretKey)body.key=S.cfg.secretKey;
        const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        // Google Apps Script redirects POST, need to handle
        const data=await res.json().catch(()=>({success:false,error:'回應不是 JSON'}));
        if(!data.success&&!data.created)throw new Error(data.error||'新增失敗');
        S.addMsg=`✅ 成功新增 ${data.created||0} 個行程${data.failed?' / '+data.failed+' 個失敗':''}`;
        S.addErr=false;
        S.pendingAdds=[];
        toast('📅 行程已新增到 Google 日曆');
        // 自動重新拉取以顯示新事件
        await fetchCalendar();
      }catch(e){S.addMsg='新增失敗：'+e.message;S.addErr=true;}
      render();
    }

    // ── Style ──
    const style=document.createElement('style');
    style.textContent=`
      .ca{width:100%;height:100%;position:relative;overflow:hidden;font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;background:${BG};display:flex;flex-direction:column;color:${T1}}
      .ca *{box-sizing:border-box}
      .ca-hdr{height:50px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid ${BD};flex-shrink:0}
      .ca-hdr-btn{width:34px;height:34px;display:flex;align-items:center;justify-content:center;background:none;border:none;border-radius:50%;cursor:pointer;color:${T1}}
      .ca-body{flex:1;overflow-y:auto;padding:0 0 20px}
      .ca-summary{margin:14px;padding:18px;border-radius:16px;background:linear-gradient(135deg,${ACC},${ACCD});color:#fff;position:relative;overflow:hidden}
      .ca-summary-title{font-size:20px;font-weight:800}
      .ca-summary-sub{font-size:13px;margin-top:6px;opacity:.85;line-height:1.5}
      .ca-summary-bg{position:absolute;right:14px;top:10px;font-size:48px;opacity:.15}
      .ca-section{margin:16px 14px 0}
      .ca-section-title{font-size:13px;font-weight:700;color:${ACC};margin-bottom:8px}
      .ca-ev{display:flex;gap:10px;padding:12px;background:#f8f8f8;border-radius:12px;margin-bottom:8px;border-left:4px solid ${ACC}}
      .ca-ev.past{opacity:.5;border-left-color:${T3}}
      .ca-ev-time{flex-shrink:0;width:56px;font-size:12px;font-weight:700;color:${ACC}}
      .ca-ev.past .ca-ev-time{color:${T3}}
      .ca-ev-body{flex:1;min-width:0}
      .ca-ev-title{font-size:14px;font-weight:600}
      .ca-ev-loc{font-size:11px;color:${T3};margin-top:2px}
      .ca-actions{display:flex;gap:8px;margin:14px;flex-wrap:wrap}
      .ca-abtn{padding:10px 14px;border-radius:12px;font-weight:600;font-size:13px;cursor:pointer;flex:1;text-align:center;min-width:0;border:1px solid}
      .ca-empty{text-align:center;padding:60px 20px;color:${T3}}
      .ca-pending{margin:14px;padding:14px;border-radius:12px;background:#FFF8E8;border:1px solid #F0E0B0}
      .ca-pending-title{font-weight:700;font-size:14px;margin-bottom:8px;color:#996600}
      .ca-pending-item{padding:8px 12px;background:#fff;border-radius:8px;margin-bottom:6px;border:1px solid #F0E0B0}
      .ca-pending-item .title{font-weight:600;font-size:13px}
      .ca-pending-item .meta{font-size:11px;color:${T3};margin-top:2px}
      .ca-sync{margin:14px;padding:14px;border-radius:12px;background:#f8f8f8;border:1px solid ${BD}}
      .ca-msg{margin:0 14px 8px;font-size:12px}
      .ca-mask{position:absolute;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:flex-end}
      .ca-set{width:100%;background:#fff;border-radius:16px 16px 0 0;padding:18px;max-height:80%;overflow-y:auto}
      .ca-sl{display:block;font-size:12px;font-weight:600;color:${T2};margin:10px 0 4px}
      .ca-si{width:100%;padding:9px 12px;border-radius:10px;border:1px solid ${BD};font-size:13px;outline:none;background:#FAFAFA;font-family:inherit}
      .ca-sbtn{width:100%;padding:11px 0;border-radius:24px;background:${ACC};color:#fff;border:none;font-weight:700;font-size:14px;margin-top:14px;cursor:pointer}
      .ca-help{margin:14px;padding:14px;border-radius:12px;background:#FFF8E8;border:1px solid #F0E0B0;font-size:12px;color:#996600;line-height:1.6}
      .ca-help ol{margin:8px 0 0;padding-left:18px}.ca-help li{margin-bottom:6px}
      .ca-toast{position:absolute;top:60px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;z-index:300;pointer-events:none;animation:cf .3s}
      @keyframes cf{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
    `;
    container.appendChild(style);

    function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}
    function toast(m){const t=document.createElement('div');t.className='ca-toast';t.textContent=m;root.appendChild(t);setTimeout(()=>t.remove(),2500)}

    // ── Render ──
    const root=document.createElement('div');root.className='ca';container.appendChild(root);
    function render(){
      let h='';
      h+=`<div class="ca-hdr"><button class="ca-hdr-btn" data-a="exit"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button><span style="font-weight:800;font-size:17px">📅 日曆同步</span><button class="ca-hdr-btn" data-a="settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${T2}" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button></div>`;
      h+=`<div class="ca-body">`;
      const g=groupEvents();const totalUp=g.today.length+g.tomorrow.length+g.thisWeek.length+g.later.length;
      if(S.events.length){
        h+=`<div class="ca-summary"><div class="ca-summary-title">${g.today.length?'今天 '+g.today.length+' 個行程':'今天沒有行程'}</div><div class="ca-summary-sub">${totalUp} 個即將到來${S.lastFetched?' · 更新：'+fmtDate(S.lastFetched):''}</div><div class="ca-summary-bg">📅</div></div>`;
      }
      // Action buttons
      h+=`<div class="ca-actions"><button class="ca-abtn" data-a="fetch" style="background:${ACCL};color:${ACC};border-color:${ACC}30" ${S.fetching?'disabled':''}>${S.fetching?'⏳':'🔄 拉取日曆'}</button><button class="ca-abtn" data-a="copy" style="background:#fff;color:${T1};border-color:${BD}">📋 複製訊息</button><button class="ca-abtn" data-a="sync" style="background:${ACCL};color:${ACC};border-color:${ACC}30">📤 寫入記憶</button></div>`;
      // Scan for char-added events
      h+=`<div class="ca-actions"><button class="ca-abtn" data-a="scan" style="background:#FFF8E8;color:#996600;border-color:#F0E0B0" ${S.scanning?'disabled':''}>${S.scanning?'⏳ 掃描中...':'🔍 掃描對話（找 char 幫你新增的行程）'}</button></div>`;
      // Messages
      if(S.fetchMsg)h+=`<div class="ca-msg" style="color:${S.fetchErr?'#CC3333':'#2d8a5f'}">${esc(S.fetchMsg)}</div>`;
      if(S.syncMsg)h+=`<div class="ca-msg" style="color:${S.syncErr?'#CC3333':'#2d8a5f'}">${esc(S.syncMsg)}</div>`;
      if(S.addMsg)h+=`<div class="ca-msg" style="color:${S.addErr?'#996600':'#2d8a5f'}">${esc(S.addMsg)}</div>`;
      // Pending adds from char
      if(S.pendingAdds.length){
        h+=`<div class="ca-pending"><div class="ca-pending-title">📌 ${S.cfg.charName||'角色'} 要幫你新增的行程</div>`;
        S.pendingAdds.forEach((ev,i)=>{
          h+=`<div class="ca-pending-item"><div class="title">${esc(ev.title)}</div><div class="meta">${esc(ev.date||ev.startTime||'')} ${ev.startTime&&!ev.isAllDay?fmtTime(ev.startTime):'全天'}${ev.location?' · '+esc(ev.location):''}</div></div>`;
        });
        h+=`<button data-a="confirm-add" style="width:100%;padding:10px;border-radius:12px;background:#2d8a5f;color:#fff;border:none;font-weight:700;font-size:14px;margin-top:8px;cursor:pointer">✅ 確認全部新增到 Google 日曆</button></div>`;
      }
      // Setup guide
      if(!S.cfg.scriptUrl){
        h+=`<div class="ca-help"><strong>📋 首次設定</strong><ol><li>打開 <strong>script.google.com</strong> → 新建專案</li><li>貼入 Google Apps Script 代碼</li><li>修改 CALENDAR_IDS 為你的日曆 ID</li><li>部署 → 網路應用程式 → 存取權「任何人」</li><li>複製 URL → 貼到設定裡</li></ol></div>`;
      }
      // Event list
      if(!S.events.length&&S.cfg.scriptUrl)h+=`<div class="ca-empty"><div style="font-size:48px;margin-bottom:12px">📅</div><p>點「拉取日曆」開始</p></div>`;
      [['📌 今天',g.today,false],['📎 明天',g.tomorrow,false],['📆 本週',g.thisWeek,false],['🗓️ 之後',g.later,false],['⏪ 已過',g.past.slice(-5),true]].forEach(([title,list,past])=>{
        if(!list.length)return;
        h+=`<div class="ca-section"><div class="ca-section-title">${title}</div>`;
        (past?list:list).forEach(ev=>{
          const timeStr=ev.isAllDay?'全天':fmtTime(ev.startTime);
          const dayStr=fmtDate(ev.startTime).replace(/.*（/,'').replace('）','');
          h+=`<div class="ca-ev${past?' past':''}"><div class="ca-ev-time">${dayStr}<br>${timeStr}</div><div class="ca-ev-body"><div class="ca-ev-title">${esc(ev.title)}</div>${ev.location?`<div class="ca-ev-loc">📍 ${esc(ev.location)}</div>`:''}</div></div>`;
        });
        h+=`</div>`;
      });
      h+=`</div>`;
      if(S.showSettings)h+=vSettings();
      root.innerHTML=h;
    }

    function vSettings(){
      const c=S.cfg;
      let h=`<div class="ca-mask"><div class="ca-set"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><span style="font-weight:700;font-size:15px">設定</span><button data-a="close-set" style="background:none;border:none;font-size:18px;color:${T3};cursor:pointer">✕</button></div>`;
      h+=`<label class="ca-sl">Google Apps Script URL</label><input class="ca-si" data-f="scriptUrl" value="${esc(c.scriptUrl)}" placeholder="https://script.google.com/macros/s/xxx/exec">`;
      h+=`<label class="ca-sl">密鑰（選填，跟 Apps Script 裡的 SECRET_KEY 對應）</label><input class="ca-si" data-f="secretKey" value="${esc(c.secretKey)}" placeholder="留空=不驗證" type="password">`;
      h+=`<label class="ca-sl">同步給誰？</label><select class="ca-si" data-f="charId">${S.charList.map(ch=>`<option value="${esc(ch.id)}" ${ch.id===c.charId?'selected':''}>${esc(ch.name||ch.handle)}</option>`).join('')}</select>`;
      h+=`<label class="ca-sl">寫入哪個對話？</label><select class="ca-si" data-f="convId">${S.convList.map(cv=>{const cid=cv.conversationId||cv.id;return`<option value="${esc(cid)}" ${cid===c.convId?'selected':''}>${esc(cv.name||cv.handle||cid)}</option>`}).join('')}</select>`;
      h+=`<label class="ca-sl">你的名字</label><input class="ca-si" data-f="userName" value="${esc(c.userName)}">`;
      h+=`<button data-a="save-set" class="ca-sbtn">儲存設定</button>`;
      h+=`<button data-a="clear" class="ca-sbtn" style="background:#fff;color:#CC3333;border:1px solid #CC3333;margin-top:8px">🗑️ 清除事件</button>`;
      h+=`</div></div>`;
      return h;
    }

    function onClick(e){
      const b=e.target.closest('[data-a]');if(!b)return;
      const a=b.dataset.a;
      if(a==='exit')roche.ui?.closeApp?.();
      else if(a==='settings'){S.showSettings=true;render();}
      else if(a==='close-set'){S.showSettings=false;render();}
      else if(a==='fetch'){fetchCalendar();}
      else if(a==='sync'){syncToMemory();}
      else if(a==='copy'){copyAsMessage();}
      else if(a==='scan'){scanForAdds();}
      else if(a==='confirm-add'){confirmAddEvents();}
      else if(a==='save-set'){
        root.querySelectorAll('[data-f]').forEach(el=>{S.cfg[el.dataset.f]=el.value;});
        const ch=S.charList.find(c=>c.id===S.cfg.charId);if(ch)S.cfg.charName=ch.name||ch.handle||'';
        saveCfg();S.showSettings=false;toast('已儲存');render();
      }
      else if(a==='clear'){S.events=[];S.lastFetched='';saveEvents();S.showSettings=false;toast('已清除');render();}
    }
    root.addEventListener('click',onClick);
    render();
    this._el=root;this._st=style;this._fn=onClick;
  },

  async unmount(container){
    if(this._el){this._el.removeEventListener('click',this._fn);this._el.remove();}
    if(this._st)this._st.remove();
    container.replaceChildren();
  }
};
window.RochePlugin.register({id:'roche-calendar-sync',name:'日曆同步',version:'2.0.0',description:'拉取 Google 日曆，讓角色幫你管理日程',author:'予佟',apps:[app]});
})();
