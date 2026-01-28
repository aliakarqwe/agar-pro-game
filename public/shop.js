/* Premium Shop JS */
const socket = io();

const PRIZES = [
  { name: 'Gold x300', gold: 300 },
  { name: 'Gold x600', gold: 600 },
  { name: 'Gold x1200', gold: 1200 },
  { name: 'Gold x2500', gold: 2500 },
  { name: 'Gold x7000', gold: 7000 },
];

let user = null;
let spinning = false;

function $(id){ return document.getElementById(id); }

function toast(msg){
  const t = $('toast');
  if(!t) return;
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast._tm);
  toast._tm = setTimeout(()=>{ t.style.display='none'; }, 2600);
}

function goHome(){ window.location.href = '/'; }
window.goHome = goHome;

function buyPremium(){
  if(!user) return toast('Giriş yapmalısın.');
  if(!confirm('200.000 GOLD karşılığı 1 hafta Premium almak istiyor musun?')) return;
  socket.emit('buyPremium');
}
window.buyPremium = buyPremium;

function setCounts(ch){
  ch = ch || {common:0,rare:0,epic:0,legendary:0};
  $('c_common').textContent = ch.common || 0;
  $('c_rare').textContent = ch.rare || 0;
  $('c_epic').textContent = ch.epic || 0;
  $('c_legendary').textContent = ch.legendary || 0;
}

function setUserUI(data){
  if(!data) return;
  $('uName').textContent = data.nickname || '-';
  $('uGold').textContent = (data.gold ?? 0);
  if(data.chests) setCounts(data.chests);
  
  if(document.getElementById('spinCount')) {
      document.getElementById('spinCount').innerText = data.spins || 0;
  }
}

function ensureLogin(){
  try{
    const token = localStorage.getItem('agar_token');
    if(token) socket.emit('loginWithToken', { token });
  }catch(e){}
}
ensureLogin();

socket.on('authSuccess', (data)=>{
  user = data;
  $('locked').style.display='none';
  $('content').style.display='grid';
  setUserUI(data);
});

socket.on('authError', (msg)=>{
  if(!user){
    $('locked').style.display='flex';
    $('content').style.display='none';
  }
  toast(msg);
});

socket.on('updateUserData', (data)=>{
  if(!user) return;
  user.gold = (data.gold ?? user.gold);
  if(typeof data.isPremium !== 'undefined') user.isPremium = data.isPremium;
  if(data.chests) user.chests = data.chests;
  if(data.spins !== undefined) user.spins = data.spins;
  setUserUI({ ...user, ...data, nickname: user.nickname });
});

// ---------- Wheel ----------
const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');
let wheelAngle = 0;
let wheelAnim = null;

function drawWheel(){
  const w = canvas.width, h = canvas.height;
  const cx = w/2, cy = h/2;
  ctx.clearRect(0,0,w,h);

  ctx.beginPath();
  ctx.arc(cx,cy, 235, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fill();

  const seg = PRIZES.length;
  const segAngle = (Math.PI*2)/seg;

  for(let i=0;i<seg;i++){
    const a0 = wheelAngle + i*segAngle;
    const a1 = a0 + segAngle;

    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy, 220, a0, a1);
    ctx.closePath();

    ctx.fillStyle = (i%2===0) ? 'rgba(110,231,255,0.25)' : 'rgba(167,139,250,0.22)';
    ctx.fill();

    ctx.save();
    ctx.translate(cx,cy);
    ctx.rotate(a0 + segAngle/2);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(234,240,255,0.9)';
    ctx.font = 'bold 18px Ubuntu';
    ctx.fillText(PRIZES[i].name, 190, 8);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(cx,cy, 55, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle='rgba(234,240,255,0.95)';
  ctx.font='900 20px Ubuntu';
  ctx.textAlign='center';
  ctx.fillText('SPIN', cx, cy+7);

  ctx.beginPath();
  ctx.moveTo(cx, cy-240);
  ctx.lineTo(cx-14, cy-210);
  ctx.lineTo(cx+14, cy-210);
  ctx.closePath();
  ctx.fillStyle = 'rgba(251,191,36,0.9)';
  ctx.fill();
}
drawWheel();

socket.on('wheelResult', (data)=>{
  if(!data || !data.prize) return;
  const idx = PRIZES.findIndex(p => p.name === data.prize.name);
  animateWheelToIndex(idx >=0 ? idx : 0, ()=>{
    if(typeof data.gold !== 'undefined') $('uGold').textContent = data.gold;
    if(typeof data.spins !== 'undefined') $('spinCount').textContent = data.spins;
    toast(`Kazandın: ${data.prize.name}!`);
    spinning = false;
    document.getElementById('spinBtn').disabled = false;
  });
});

function spin(){
  if(!user) return toast('Giriş yapmalısın.');
  if(spinning) return;
  if(user.spins <= 0) return toast('Çark hakkın kalmadı!');
  
  spinning = true;
  document.getElementById('spinBtn').disabled = true;
  socket.emit('spinWheel');
}
window.spin = spin;

function animateWheelToIndex(index, done){
  cancelAnimationFrame(wheelAnim);
  const seg = PRIZES.length;
  const segAngle = (Math.PI*2)/seg;
  const targetCenter = -Math.PI/2;
  const current = wheelAngle;
  let target = targetCenter - (index+0.5)*segAngle;
  const spins = 6 + Math.floor(Math.random()*3);
  target -= spins * Math.PI*2;

  const start = performance.now();
  const dur = 3800;

  function easeOutCubic(t){ return 1 - Math.pow(1-t, 3); }

  function frame(ts){
    const t = Math.min(1, (ts-start)/dur);
    const e = easeOutCubic(t);
    wheelAngle = current + (target-current)*e;
    drawWheel();
    if(t<1) wheelAnim = requestAnimationFrame(frame);
    else done && done();
  }
  wheelAnim = requestAnimationFrame(frame);
}

// ---------- Chest Reel ----------
const REEL_ITEMS = {
  common: [150,200,250,300,350],
  rare: [300,350,400,450,500],
  epic: [500,600,700,800,900],
  legendary: [900,1100,1300,1500,1800],
};

const reelEl = document.getElementById('reel');
let reelBusy = false;

function buildReel(rarity){
  reelEl.innerHTML = '';
  const arr = REEL_ITEMS[rarity] || REEL_ITEMS.common;
  const seq = [];
  for(let r=0;r<18;r++){ for(const v of arr) seq.push(v); }
  for(let i=0;i<12;i++) seq.push(arr[Math.floor(Math.random()*arr.length)]);

  for(const v of seq){
    const item = document.createElement('div');
    item.className = 'reel-item';
    item.innerHTML = `<div class="t">+${v} GOLD</div><div class="d">Ödül</div>`;
    reelEl.appendChild(item);
  }
  reelEl.style.transform = 'translateX(0px)';
}

function openChest(rarity){
  if(!user) return toast('Giriş yapmalısın.');
  if(reelBusy) return;
  const count = (user.chests && user.chests[rarity]) ? user.chests[rarity] : 0;
  if(count <= 0) return toast('Bu sandıktan yok.');
  reelBusy = true;
  buildReel(rarity);
  socket.emit('openChest', { rarity });
}
window.openChest = openChest;

socket.on('chestOpened', (data)=>{
  if(!data) return;
  const rarity = data.rarity || 'common';
  const win = data.goldWon;
  animateReelToWin(rarity, win, ()=>{
    user.gold = data.gold;
    user.chests = data.chests;
    setUserUI(user);
    toast(`Sandık: +${win} GOLD`);
    reelBusy = false;
  });
});

function animateReelToWin(rarity, win, done){
  const items = Array.from(reelEl.children);
  let idx = -1;
  for(let i=items.length-1;i>=0;i--){
    if(items[i].querySelector('.t')?.textContent === `+${win} GOLD`){ idx = i; break; }
  }
  if(idx < 0) idx = Math.floor(items.length*0.85);

  const itemW = 170; 
  const center = document.querySelector('.reel-wrap').clientWidth/2;
  const targetX = -(idx*itemW) + center - (itemW/2);

  const start = performance.now();
  const dur = 3200;
  const from = 0;
  const to = targetX;

  function easeOutQuint(t){ return 1 - Math.pow(1-t, 5); }

  function frame(ts){
    const t = Math.min(1, (ts-start)/dur);
    const e = easeOutQuint(t);
    const x = from + (to-from)*e;
    reelEl.style.transform = `translateX(${x}px)`;
    if(t<1) requestAnimationFrame(frame);
    else done && done();
  }
  requestAnimationFrame(frame);
}