window.socket = io(); 
const socket = window.socket;

try { const t = localStorage.getItem('agar_token'); if(t) socket.emit('loginWithToken', { token: t }); } catch(e) {}

let canvas, ctx, loginOverlay, chatInput, chatList;
let isGameRunning = false, leaderboard = [];
let clientPlayers = {}, serverPlayers = {}, foods = [], viruses = [], ejectedMasses = [], chests = [];
let floatingTexts = [];

const MAP_WIDTH = 25000; 
const MAP_HEIGHT = 25000;
let myCamera = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }; 
let viewScale = 1;
let currentUser = null; 
let myLastScore = 0; 
let userZoom = 1; 
let currentJackpot = 0; 
let roundTimeLeft = 0; 
let hasSnappedCamera = false;
let currentMission = null;
let inArena = false;
let arenaQueued = false;
let tournamentActive = false;
let tournamentTimeLeft = 0;
let tournamentPrizePool = 0;
let wheelCooldown = 0;
let myPartyCode = null;

// --- W TUŞU KONTROLÜ VE FARE AÇISI ---
let wPressed = false;
let currentMouseAngle = 0; 

// --- PARTİ FONKSİYONLARI ---
window.createParty = function() { socket.emit('createParty'); };
window.joinParty = function() { const c = document.getElementById('partyCodeInput').value; if(c) socket.emit('joinParty', c); };
window.leaveParty = function() { socket.emit('leaveParty'); };

// --- E TUŞU / ÇARK FONKSİYONU ---
window.claimSpin = function(){ 
    socket.emit('claimSpin'); 
};

class FloatingText {
    constructor(x, y, text, color, size) {
        this.x = x; this.y = y; this.text = text; this.color = color; this.size = size; this.alpha = 1; this.life = 0;
    }
    draw(ctx, viewScale) {
        this.y -= 1 / viewScale; this.life++; this.alpha -= 0.015; if(this.alpha <= 0) return false;
        ctx.globalAlpha = this.alpha; ctx.fillStyle = this.color; ctx.font = `bold ${this.size}px Ubuntu`;
        ctx.strokeStyle = 'black'; ctx.lineWidth = 3; ctx.strokeText(this.text, this.x, this.y); ctx.fillText(this.text, this.x, this.y);
        ctx.globalAlpha = 1; return true;
    }
}

window.onload = function() {
    canvas = document.getElementById('gameCanvas'); 
    ctx = canvas.getContext('2d');
    loginOverlay = document.getElementById('loginOverlay');
    chatInput = document.getElementById('chatInput'); 
    chatList = document.getElementById('chatList');
    resizeCanvas(); 
    window.addEventListener('resize', resizeCanvas);

    window.addEventListener('wheel', (e) => { 
        if (!isGameRunning) return; e.preventDefault(); 
        if (e.deltaY < 0) userZoom *= 1.1; else userZoom *= 0.9; 
        userZoom = Math.max(0.05, Math.min(10.0, userZoom)); 
    }, { passive: false });
    
    window.addEventListener('keydown', (e) => { 
        if (document.activeElement === chatInput) { 
            if (e.key === 'Enter') { if(chatInput.value) socket.emit('sendChat', chatInput.value); chatInput.value = ''; chatInput.blur(); } return; 
        } 
        if (e.key === 'Enter' && isGameRunning) { chatInput.focus(); return; } 
        if (!isGameRunning) return; 
        
        if (e.code === 'Space') socket.emit('split'); 
        if (e.key === 'Shift') socket.emit('activateBoost'); 
        if (e.key.toLowerCase() === 'q') socket.emit('mergeInput', true); 
        
        // W TUŞU: AÇIYI GÖNDER VE KİLİTLE
        if (e.key.toLowerCase() === 'w') { 
            if (!wPressed) { 
                socket.emit('eject', currentMouseAngle); 
                wPressed = true; 
            } 
        }

        if (e.key.toLowerCase() === 'e') { 
            window.claimSpin();
        }
        
        if (e.key.toLowerCase() === 'r') joinArena();
    });
    
    window.addEventListener('keyup', (e) => { 
        if (e.key.toLowerCase() === 'q') socket.emit('mergeInput', false); 
        if (e.key.toLowerCase() === 'w') wPressed = false;
    });
    
    window.addEventListener('mousemove', (e) => { 
        if (!isGameRunning) return; 
        // FARE AÇISINI SÜREKLİ GÜNCELLE
        currentMouseAngle = Math.atan2(e.clientY - canvas.height/2, e.clientX - canvas.width/2);
        socket.emit('mouseInput', currentMouseAngle); 
    });
};

window.playGame = function() {
    const nick = document.getElementById('nickname').value || (currentUser ? currentUser.nickname : document.getElementById('guestNick')?.value || "Misafir");
    const server = document.getElementById('serverSelect') ? document.getElementById('serverSelect').value : 'ffa1';
    if (!currentUser) currentUser = { nickname: nick }; else currentUser.nickname = nick;
    startGame(server);
};

window.submitLogin = function() { 
    const email = document.getElementById('email').value; const password = document.getElementById('password').value; 
    if(!email || !password) return alert("E-posta ve şifre girin!"); socket.emit('login', { email, password }); 
};
window.submitRegister = function() { 
    const email = document.getElementById('email').value; const password = document.getElementById('password').value; const nick = document.getElementById('nickname').value || "Oyuncu"; 
    if(!email || !password) return alert("E-posta ve şifre girin!"); socket.emit('register', { email, password, nickname: nick }); 
};
function buyPremium() { if(confirm("500 Gold'a Premium?")) socket.emit('buyPremium'); }
window.buyPremium = buyPremium;
window.goShop = function(){ window.location.href = '/shop'; };
window.joinArena = function() { socket.emit('joinArena'); arenaQueued = true; };
window.logout = function() { currentUser = null; localStorage.removeItem('agar_token'); location.reload(); };

function updateUI(data) { 
    if(data.gold!==undefined && document.getElementById('pGold')) document.getElementById('pGold').innerText = data.gold; 
    if(document.getElementById('vipTag')) { document.getElementById('vipTag').style.display = data.isPremium ? 'inline-block' : 'none'; document.getElementById('vipTag').innerText = data.isPremium ? 'VIP' : ''; }
    if(data.nickname && document.getElementById('pName')) document.getElementById('pName').innerText = data.nickname;
}

// --- PARTİ UI EVENTLERİ ---
socket.on('partyJoined', (data) => {
    if(document.getElementById('partyControls')) document.getElementById('partyControls').classList.add('hidden');
    if(document.getElementById('partyLobby')) document.getElementById('partyLobby').classList.remove('hidden');
    if(document.getElementById('displayPartyCode')) document.getElementById('displayPartyCode').innerText = data.code;
});

socket.on('partyLeft', () => {
    if(document.getElementById('partyControls')) document.getElementById('partyControls').classList.remove('hidden');
    if(document.getElementById('partyLobby')) document.getElementById('partyLobby').classList.add('hidden');
    if(document.getElementById('partyMembersList')) document.getElementById('partyMembersList').innerHTML = '';
    myPartyCode = null;
});

socket.on('partyUpdate', (data) => {
    myPartyCode = data.code;
    const list = document.getElementById('partyMembersList');
    if(list) {
        list.innerHTML = '';
        data.members.forEach(m => {
            const li = document.createElement('li');
            li.innerHTML = `<span>${m.name}</span> ${m.isLeader ? '<i class="fas fa-crown" style="color:#f1c40f;"></i>' : ''}`;
            list.appendChild(li);
        });
    }
    if(document.getElementById('displayPartyCode')) document.getElementById('displayPartyCode').innerText = data.code;
    if(document.getElementById('partyControls')) document.getElementById('partyControls').classList.add('hidden');
    if(document.getElementById('partyLobby')) document.getElementById('partyLobby').classList.remove('hidden');
});
socket.on('partyError', (msg) => showNotification(msg, '#e74c3c'));

socket.on('authSuccess', (data) => {
    currentUser = { nickname: data.nickname, email: data.email, token: data.token, isPremium: !!data.isPremium, chests: data.chests || null };
    try { if(data.token) localStorage.setItem('agar_token', data.token); } catch(e) {}
    if(document.getElementById('guestView')) document.getElementById('guestView').classList.add('hidden');
    if(document.getElementById('memberView')) document.getElementById('memberView').classList.remove('hidden');
    if(document.getElementById('authBox')) document.getElementById('authBox').classList.add('hidden');
    if(document.getElementById('partyCard')) document.getElementById('partyCard').classList.remove('hidden');
    if(document.getElementById('nickname')) document.getElementById('nickname').value = data.nickname || '';
    updateUI(data);
});

socket.on('authError', (msg) => { 
    if(document.getElementById('errorMsg')) document.getElementById('errorMsg').innerText = msg;
    showNotification(msg, '#e74c3c');
});
socket.on('updateUserData', (data) => updateUI(data));

socket.on('newMission', (mission) => { 
    currentMission = mission; 
    if(isGameRunning) floatingTexts.push(new FloatingText(myCamera.x, myCamera.y - 100, "YENİ GÖREV!", "#3498db", 40));
});

socket.on('chestCollected', (data) => {
    if(currentUser) currentUser.chests = data.chests;
    showNotification(`🎁 ${data.rarity.toUpperCase()} sandık topladın!`, '#3498db');
    floatingTexts.push(new FloatingText(myCamera.x, myCamera.y - 100, `+1 ${data.rarity} SANDIK`, "#9b59b6", 30));
    updateUI({ chests: data.chests });
});
socket.on('chestCollectedGuest', () => showNotification('🎁 Sandık topladın! Giriş yap.', '#95a5a6'));
socket.on('missionComplete', (data) => {
    showNotification(`🎯 GÖREV TAMAMLANDI! +${data.reward} GOLD`, '#2ecc71');
    floatingTexts.push(new FloatingText(myCamera.x, myCamera.y - 150, "GÖREV TAMAMLANDI!", "#2ecc71", 50));
    floatingTexts.push(new FloatingText(myCamera.x, myCamera.y - 100, `+${data.reward} GOLD`, "#f1c40f", 40));
});
socket.on('goldEarned', (data) => {
    if(document.getElementById('goldEarnedMsg')) document.getElementById('goldEarnedMsg').innerText = `+${data.earned} GOLD KAZANDIN!`;
    if(isGameRunning && data.earned > 0) floatingTexts.push(new FloatingText(myCamera.x, myCamera.y - 50, `+${data.earned} G`, "#f1c40f", 25));
});
socket.on('arenaStart', (data) => { inArena = true; arenaQueued = false; showNotification(`⚔️ DÜELLO! Rakip: ${data.opponent}`, '#e74c3c'); });
socket.on('arenaWin', (data) => { inArena = false; showNotification(`🏆 ARENA KAZANDIN! +${data.prize} GOLD`, '#f39c12'); });
socket.on('tournamentStart', () => { tournamentActive = true; showNotification(`🏆 TURNUVA BAŞLADI!`, '#f39c12'); });

// --- YENİ ÇARK EVENTLERİ ---
socket.on('spinClaimed', (data) => {
    showNotification(`🎰 ÇARK HAKKI KAZANDIN! (Toplam: ${data.spins})`, '#f1c40f');
    if(isGameRunning) floatingTexts.push(new FloatingText(myCamera.x, myCamera.y - 100, "+1 SPIN", "#f1c40f", 40));
    wheelCooldown = Date.now() + data.nextSpin;
});

socket.on('wheelCooldown', (data) => {
    const minutes = Math.floor(data.timeLeft / 60000);
    const seconds = Math.floor((data.timeLeft % 60000) / 1000);
    showNotification(`⏰ Çark ${minutes}:${seconds.toString().padStart(2, '0')} sonra!`, '#95a5a6');
});

function startGame(server = 'ffa1') {
    loginOverlay.style.display = 'none'; document.getElementById('restartScreen').classList.add('hidden');
    if(document.getElementById('ingameLeaderboard')) document.getElementById('ingameLeaderboard').classList.remove('hidden');
    
    socket.emit('joinGame', { nickname: currentUser.nickname, server: server }); 
    isGameRunning = true; userZoom = 1; hasSnappedCamera = false; inArena = false; arenaQueued = false;
    requestAnimationFrame(loop);
}

window.restartGame = function() { startGame(); };

socket.on('gameOver', () => { 
    isGameRunning = false; inArena = false; loginOverlay.style.display = 'flex'; 
    document.getElementById('mainForm').classList.add('hidden'); 
    if(document.getElementById('ingameLeaderboard')) document.getElementById('ingameLeaderboard').classList.add('hidden');
    document.getElementById('restartScreen').classList.remove('hidden'); 
    document.getElementById('finalScore').innerText = Math.floor(myLastScore); 
    document.getElementById('goldEarnedMsg').innerText = ""; 
    socket.emit('playerDied', Math.floor(myLastScore)); 
});
socket.on('newChat', (d) => { const li = document.createElement('li'); li.innerHTML=`<b style="color:#88ce02">${d.name}:</b> ${d.message}`; chatList.appendChild(li); chatList.scrollTop=chatList.scrollHeight; });

socket.on('stateUpdate', (data) => {
    serverPlayers = data.players; foods = data.foods; viruses = data.viruses; 
    leaderboard = data.leaderboard || []; 
    const lbContent = document.getElementById('lbContent');
    if(lbContent && leaderboard) {
        lbContent.innerHTML = '';
        leaderboard.forEach((p, i) => {
            lbContent.innerHTML += `<div class="lb-item"><span>${i+1}. ${p.name}</span><b>${p.score}</b></div>`;
        });
    }

    ejectedMasses = data.ejectedMasses || []; chests = data.chests || []; currentJackpot = data.jackpot || 0; 
    roundTimeLeft = data.timeLeft || 0; tournamentActive = data.tournamentActive; tournamentTimeLeft = data.tournamentTimeLeft; tournamentPrizePool = data.tournamentPrizePool;
    
    if(serverPlayers[socket.id] && serverPlayers[socket.id].mission) currentMission = serverPlayers[socket.id].mission;

    for (const id in serverPlayers) {
        if(!clientPlayers[id]) clientPlayers[id] = JSON.parse(JSON.stringify(serverPlayers[id]));
        else {
            clientPlayers[id].lastBoostTime = serverPlayers[id].lastBoostTime; 
            clientPlayers[id].isPremium = serverPlayers[id].isPremium;
            clientPlayers[id].inArena = serverPlayers[id].inArena;
            clientPlayers[id].partyCode = serverPlayers[id].partyCode; 
            
            if(clientPlayers[id].cells.length !== serverPlayers[id].cells.length) {
                clientPlayers[id].cells = JSON.parse(JSON.stringify(serverPlayers[id].cells));
            } else {
                for(let i=0; i<clientPlayers[id].cells.length; i++) { 
                    clientPlayers[id].cells[i].targetX = serverPlayers[id].cells[i].x; 
                    clientPlayers[id].cells[i].targetY = serverPlayers[id].cells[i].y; 
                    clientPlayers[id].cells[i].size = serverPlayers[id].cells[i].size; 
                    clientPlayers[id].cells[i].color = serverPlayers[id].cells[i].color; 
                } 
            }
        }
    }
    for (const id in clientPlayers) { if (!serverPlayers[id]) delete clientPlayers[id]; }
});

function loop() {
    if (!isGameRunning) return;
    const me = clientPlayers[socket.id];
    if(me) myLastScore = me.cells.reduce((a,c)=>a + c.size*c.size/100, 0);

    if (me && me.cells.length > 0) {
        let minX=99999, maxX=-99999, minY=99999, maxY=-99999;
        me.cells.forEach(c => { const tx=c.targetX||c.x, ty=c.targetY||c.y; minX=Math.min(minX,tx-c.size); maxX=Math.max(maxX,tx+c.size); minY=Math.min(minY,ty-c.size); maxY=Math.max(maxY,ty+c.size); });
        const viewSize = Math.max(maxX-minX, maxY-minY);
        let targetScale = Math.max(canvas.width/1920, Math.min(1, 1000/(Math.max(1, viewSize)*1.2))) * userZoom;
        const targetX = (minX + maxX) / 2; const targetY = (minY + maxY) / 2;
        if (!hasSnappedCamera) { myCamera.x = targetX; myCamera.y = targetY; hasSnappedCamera = true; } 
        else { myCamera.x += (targetX - myCamera.x) * 0.1; myCamera.y += (targetY - myCamera.y) * 0.1; }
        if(!isNaN(targetScale)) viewScale += (targetScale - viewScale)*0.05;
    }
    if (!viewScale || viewScale < 0.001) viewScale = 0.1;

    for(let id in clientPlayers) { 
        clientPlayers[id].cells.forEach(c => { 
            if(c.targetX === undefined) { c.targetX = c.x; c.targetY = c.y; }
            c.x += (c.targetX - c.x) * 0.3; c.y += (c.targetY - c.y) * 0.3; 
        }); 
    }

    const visibleWidth = canvas.width / viewScale; const visibleHeight = canvas.height / viewScale;
    const viewLeft = myCamera.x - visibleWidth / 2 - 200; const viewRight = myCamera.x + visibleWidth / 2 + 200;
    const viewTop = myCamera.y - visibleHeight / 2 - 200; const viewBottom = myCamera.y + visibleHeight / 2 + 200;

    ctx.fillStyle = "#111111"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(canvas.width/2, canvas.height/2); ctx.scale(viewScale, viewScale); ctx.translate(-myCamera.x, -myCamera.y);
    
    ctx.strokeStyle = '#222'; ctx.lineWidth = 5; 
    for (let x = 0; x <= MAP_WIDTH; x += 250) { if (x > viewLeft && x < viewRight) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP_HEIGHT); ctx.stroke(); } }
    for (let y = 0; y <= MAP_HEIGHT; y += 250) { if (y > viewTop && y < viewBottom) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP_WIDTH, y); ctx.stroke(); } }
    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 100; ctx.strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    chests.forEach(c => {
        if (c.x > viewLeft && c.x < viewRight && c.y > viewTop && c.y < viewBottom) {
            let color = c.rarity==='legendary'?'#f1c40f':c.rarity==='epic'?'#9b59b6':c.rarity==='rare'?'#3498db':'#95a5a6';
            ctx.shadowBlur=20; ctx.shadowColor=color; ctx.fillStyle=color; ctx.fillRect(c.x-c.size/2, c.y-c.size/2, c.size, c.size);
            ctx.shadowBlur=0; ctx.fillStyle='#2c3e50'; ctx.font='30px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('🔒', c.x, c.y);
        }
    });
    foods.forEach(f => { if (f.x>viewLeft && f.x<viewRight && f.y>viewTop && f.y<viewBottom) { ctx.beginPath(); ctx.arc(f.x, f.y, 10, 0, Math.PI*2); ctx.fillStyle=f.color; ctx.fill(); } });
    ejectedMasses.forEach(m => { if (m.x>viewLeft && m.x<viewRight && m.y>viewTop && m.y<viewBottom) { ctx.beginPath(); ctx.arc(m.x, m.y, m.size, 0, Math.PI*2); ctx.fillStyle=m.color; ctx.fill(); ctx.strokeStyle='white'; ctx.lineWidth=2; ctx.stroke(); } });
    viruses.forEach(v => { 
        if (v.x>viewLeft-v.size && v.x<viewRight+v.size && v.y>viewTop-v.size && v.y<viewBottom+v.size) { 
            ctx.beginPath(); ctx.fillStyle=v.color||'#33ff33'; ctx.strokeStyle='#22aa22'; ctx.lineWidth=4; 
            for (let i=0; i<40; i++) { const a=(Math.PI*2*i)/40; const r=(i%2===0)?v.size:v.size-12; ctx.lineTo(v.x+Math.cos(a)*r, v.y+Math.sin(a)*r); } 
            ctx.closePath(); ctx.fill(); ctx.stroke(); 
        } 
    });

    const now = Date.now();
    for (const id in clientPlayers) {
        let p = clientPlayers[id];
        let isProtected = (now - p.spawnTime) < 10000;
        let isTeammate = (myPartyCode && p.partyCode && myPartyCode === p.partyCode); 

        if(isProtected) ctx.globalAlpha = 0.5;
        p.cells.forEach(cell => {
            let sCol = 'white'; let lW = 2;
            if (me && id !== socket.id) {
                if(isTeammate) { sCol = '#3498db'; lW = 8; } 
                else if (me.cells[0] && me.cells[0].size > cell.size * 1.1) { sCol = '#2ecc71'; lW=5; } 
                else if (me.cells[0] && cell.size > me.cells[0].size * 1.1) { sCol = '#e74c3c'; lW=5; } 
            }
            
            ctx.beginPath(); ctx.arc(cell.x, cell.y, cell.size, 0, Math.PI*2); ctx.fillStyle = cell.color; ctx.fill(); ctx.strokeStyle = sCol; ctx.lineWidth = lW; ctx.stroke();
            
            if(p.isPremium) { ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 5; ctx.stroke(); } 
            else { ctx.strokeStyle = 'black'; ctx.lineWidth = 3; }

            ctx.fillStyle = 'white'; ctx.font = `bold ${Math.max(12, cell.size/3)}px Ubuntu`; ctx.textAlign = 'center'; ctx.textBaseline='middle'; 
            ctx.strokeText(p.name, cell.x, cell.y); ctx.fillText(p.name, cell.x, cell.y);
            
            if(isTeammate && id !== socket.id) {
                ctx.fillStyle = '#3498db'; ctx.font = `bold ${Math.max(10, cell.size/4)}px Ubuntu`;
                ctx.fillText("TEAM", cell.x, cell.y - cell.size - 10);
            }
            
            let mass = Math.floor(cell.size * cell.size / 100); 
            ctx.fillStyle = 'white'; ctx.font = `bold ${Math.max(10, cell.size/4)}px Ubuntu`; ctx.strokeText(mass, cell.x, cell.y+cell.size/2.5); ctx.fillText(mass, cell.x, cell.y+cell.size/2.5);
        });
        ctx.globalAlpha = 1.0;
    }

    floatingTexts = floatingTexts.filter(ft => ft.draw(ctx, viewScale));
    ctx.restore();
    if(me && me.cells[0]) { drawMinimap(me); drawInfoPanel(me); drawMissionPanel(); drawWheelButton(); drawArenaButton(); }
    drawTournamentInfo();
    requestAnimationFrame(loop);
}

function drawMinimap(me) { 
    let cX=0, cY=0; me.cells.forEach(c=>{cX+=c.x; cY+=c.y}); cX/=me.cells.length; cY/=me.cells.length; 
    const size=150, margin=10, scale=size/MAP_WIDTH; 
    ctx.fillStyle='rgba(20,20,20,0.6)'; ctx.fillRect(margin, margin, size, size); 
    ctx.strokeStyle='#555'; ctx.strokeRect(margin, margin, size, size); 
    
    for(const id in clientPlayers) {
        if(id !== socket.id && myPartyCode && clientPlayers[id].partyCode === myPartyCode) {
            let p = clientPlayers[id];
            if(p.cells.length > 0) {
                let px = p.cells[0].x * scale;
                let py = p.cells[0].y * scale;
                ctx.fillStyle = '#3498db'; 
                ctx.beginPath(); ctx.arc(margin + px, margin + py, 4, 0, Math.PI*2); ctx.fill();
            }
        }
    }

    ctx.fillStyle='red'; ctx.beginPath(); ctx.arc(margin+cX*scale, margin+cY*scale, 4, 0, Math.PI*2); ctx.fill(); 
}

function drawInfoPanel(me) { 
    const margin=10, startY=180; 
    ctx.textAlign='left'; ctx.font='bold 14px Ubuntu'; ctx.fillStyle='#bbb'; ctx.fillText("Mevcut Kazanç:", margin, startY); 
    ctx.font='bold 18px Ubuntu'; ctx.fillStyle='#f1c40f'; ctx.fillText(`+${Math.floor(myLastScore>=1000?myLastScore/1000*15:0)} GOLD`, margin, startY+20); 
    ctx.font='bold 14px Ubuntu'; ctx.fillStyle='#bbb'; ctx.fillText("JACKPOT:", margin, startY+50); 
    ctx.font='bold 20px Ubuntu'; ctx.fillStyle='#e74c3c'; ctx.fillText(`${currentJackpot} G`, margin, startY+75); 
    let sec=Math.floor(roundTimeLeft/1000), min=Math.floor(sec/60); 
    ctx.font='bold 14px Ubuntu'; ctx.fillStyle='#bbb'; ctx.fillText("Tur Bitişi:", margin, startY+105); 
    ctx.font='bold 18px Ubuntu'; ctx.fillStyle='white'; ctx.fillText(`${min}:${(sec%60).toString().padStart(2,'0')}`, margin, startY+125); 
}

function drawMissionPanel() {
    if(!currentMission) return;
    const x = canvas.width - 230, y = canvas.height - 180;
    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)'; ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, 220, 160, 15); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f39c12'; ctx.font = 'bold 16px Ubuntu'; ctx.textAlign = 'center'; ctx.fillText('🎯 GÖREV', x + 110, y + 30);
    ctx.fillStyle = '#ecf0f1'; ctx.font = '14px Ubuntu'; ctx.fillText(currentMission.name, x + 110, y + 55);
    const barW = 180, barH = 12, barX = x + 20, barY = y + 80;
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 6); ctx.fill();
    const pct = Math.min(1, currentMission.progress / currentMission.target);
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0); grad.addColorStop(0, '#2ecc71'); grad.addColorStop(1, '#27ae60');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.roundRect(barX, barY, barW * pct, barH, 6); ctx.fill();
    if(pct > 0.9) { ctx.shadowBlur = 10; ctx.shadowColor = '#2ecc71'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.roundRect(barX, barY, barW * pct, barH, 6); ctx.fill(); ctx.shadowBlur = 0; }
    ctx.fillStyle = '#bdc3c7'; ctx.font = '12px Ubuntu'; ctx.fillText(`${Math.floor(currentMission.progress)} / ${currentMission.target}`, x + 110, y + 110);
    ctx.fillStyle = '#f1c40f'; ctx.font = 'bold 15px Ubuntu'; ctx.fillText(`Ödül: ${currentMission.reward} GOLD`, x + 110, y + 140);
}

function drawWheelButton() {
    const now = Date.now(), canSpin = now > wheelCooldown;
    const x = 20, y = canvas.height - 70;
    ctx.fillStyle = canSpin ? 'rgba(243, 156, 18, 0.9)' : 'rgba(127, 140, 141, 0.7)'; ctx.beginPath(); ctx.roundRect(x, y, 180, 50, 10); ctx.fill();
    ctx.fillStyle = 'white'; ctx.font = 'bold 14px Ubuntu'; ctx.textAlign = 'center'; ctx.fillText('🎰 ÇARK (E)', x + 90, y + 20);
    ctx.font = '11px Ubuntu'; if(canSpin) ctx.fillText('Hazır!', x + 90, y + 38); else { const t = wheelCooldown - now; ctx.fillText(`${Math.floor(t/60000)}:${Math.floor((t%60000)/1000).toString().padStart(2,'0')}`, x + 90, y + 38); }
}

function drawArenaButton() {
    if(inArena) return;
    const x = 20, y = canvas.height - 135;
    ctx.fillStyle = arenaQueued ? 'rgba(230, 126, 34, 0.9)' : 'rgba(231, 76, 60, 0.9)'; ctx.beginPath(); ctx.roundRect(x, y, 180, 50, 10); ctx.fill();
    ctx.fillStyle = 'white'; ctx.font = 'bold 14px Ubuntu'; ctx.textAlign = 'center'; ctx.fillText('⚔️ ARENA (R)', x + 90, y + 20);
    ctx.font = '11px Ubuntu';
    if(arenaQueued) ctx.fillText('Rakip bekleniyor...', x + 90, y + 38);
    else ctx.fillText('1v1 Düello', x + 90, y + 38);
}

function drawTournamentInfo() {
    if(!tournamentActive) return;
    const x = canvas.width/2 - 150, y = 10;
    ctx.fillStyle = 'rgba(241, 196, 15, 0.85)'; ctx.beginPath(); ctx.roundRect(x, y, 300, 60, 10); ctx.fill();
    ctx.fillStyle = 'white'; ctx.font = 'bold 18px Ubuntu'; ctx.textAlign = 'center'; ctx.fillText('🏆 TURNUVA', x + 150, y + 25);
    const m = Math.floor(tournamentTimeLeft / 60000), s = Math.floor((tournamentTimeLeft % 60000) / 1000);
    ctx.font = '14px Ubuntu'; ctx.fillText(`Kalan: ${m}:${s.toString().padStart(2, '0')} | Ödül: ${tournamentPrizePool} G`, x + 150, y + 45);
}

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
function showNotification(msg, col = '#2ecc71') {
    const n = document.createElement('div');
    n.style.cssText = `position:fixed;top:100px;left:50%;transform:translateX(-50%);background:${col};color:white;padding:15px 30px;border-radius:10px;font-weight:bold;z-index:1000;box-shadow:0 4px 15px rgba(0,0,0,0.3);animation:slideDown 0.5s ease-out;`;
    n.innerText = msg; document.body.appendChild(n);
    setTimeout(() => { n.style.opacity='0'; n.style.transition='opacity 0.5s'; setTimeout(() => n.remove(), 500); }, 3000);
}
const style = document.createElement('style'); style.innerHTML = `@keyframes slideDown { from { top: -100px; opacity: 0; } to { top: 100px; opacity: 1; } }`; document.head.appendChild(style);