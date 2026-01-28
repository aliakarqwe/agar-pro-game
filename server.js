require('dotenv').config(); // Gizli verileri yükle
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const path = require('path');
const compression = require('compression');
const mongoose = require('mongoose'); // Veritabanı aracı

app.use(compression());

// --- MONGODB BAĞLANTISI ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Bağlantısı BAŞARILI! Veriler bulutta.'))
    .catch(err => console.error('❌ MongoDB Bağlantı Hatası:', err));

// --- OYUNCU ŞEMASI (Veritabanı Tablosu) ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    nickname: { type: String, default: "Adsız" },
    gold: { type: Number, default: 0 },
    spins: { type: Number, default: 0 },
    isPremium: { type: Boolean, default: false },
    premiumUntil: { type: Number, default: 0 },
    lastWheelSpin: { type: Number, default: 0 },
    chests: {
        common: { type: Number, default: 0 },
        rare: { type: Number, default: 0 },
        epic: { type: Number, default: 0 },
        legendary: { type: Number, default: 0 }
    },
    token: { type: String }
});
const User = mongoose.model('User', UserSchema);

const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingInterval: 2000, 
    pingTimeout: 5000 
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/shop', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'shop.html')); });

function makeToken() { return (Date.now().toString(36) + Math.random().toString(36).substr(2)).substr(0, 64); }

// --- OYUN AYARLARI ---
const MAP_WIDTH = 25000;
const MAP_HEIGHT = 25000;
const MAX_FOOD = 6000;
const MAX_VIRUS = 180;
const TICK_RATE = 40; 
const TARGET_BOTS = 30;
const MERGE_COOLDOWN = 15000;
const MAGNET_COOLDOWN = 60000;
const PREMIUM_COST = 200000;
const MAX_VIRUS_SIZE = 220;
const ROUND_DURATION = 60 * 60 * 1000;
const MAX_CELLS_PER_PLAYER = 25;
const VIEW_DIST = 3500; 

// --- EKONOMİ ---
const START_SIZE = 173;
const SPAWN_PROTECTION_TIME = 10000;
const FOOD_MASS = 8;
const FOOD_MASS_PREMIUM = 18;
const DECAY_RATE = 0.9998;
const DECAY_START_SIZE = 250;
const GOLD_PER_1000_SCORE = 6;
const GOLD_PER_1000_SCORE_PREMIUM = 18;
const VIRUS_EAT_GOLD = 150;

// --- SİSTEMLER ---
const MAX_CHESTS = 40;
const WHEEL_COOLDOWN = 300000;
const ARENA_PRIZE = 2500;
const TOURNAMENT_DURATION = 3600000;

let players = {}, foods = [], viruses = [], ejectedMasses = [];
let jackpot = 0;
let roundEndTime = Date.now() + ROUND_DURATION;
let chests = [], arenas = [], arenaQueue = [];
let tournament = { active: false, startTime: 0, endTime: 0, leaderboard: {}, prizePool: 0 };

let parties = {}; 
let socketPartyMap = {}; 

const botNames = ["Ejderha", "Gölge", "Aslan_TR", "BordoBereli", "Reis", "YalnızKurt", "Fırtına", "Zehir", "Kartal", "DeliYürek", "Akıncı", "Pusat", "Komutan", "Savaşçı", "Ayyıldız", "Efe", "Zeybek", "Bozkurt_06", "Anadolu", "Paşa"];

const MISSION_TYPES = [
    { type: 'eatPlayers', name: 'Oyuncu Avla', targetMin: 3, targetMax: 7, rewardMin: 1000, rewardMax: 2000 },
    { type: 'collectFood', name: 'Yem Topla', targetMin: 150, targetMax: 300, rewardMin: 800, rewardMax: 1500 },
    { type: 'survive', name: 'Hayatta Kal', targetMin: 180, targetMax: 420, rewardMin: 1200, rewardMax: 2500 },
    { type: 'eatViruses', name: 'Virüs Ye', targetMin: 2, targetMax: 5, rewardMin: 1000, rewardMax: 1800 },
    { type: 'reachSize', name: 'Büyüklüğe Ulaş', targetMin: 5000, targetMax: 15000, rewardMin: 1500, rewardMax: 3000 }
];

const WHEEL_PRIZES = [
    { name: 'Gold x300', gold: 300, chance: 0.32 }, { name: 'Gold x600', gold: 600, chance: 0.25 },
    { name: 'Gold x1200', gold: 1200, chance: 0.20 }, { name: 'Gold x2500', gold: 2500, chance: 0.15 },
    { name: 'Gold x7000', gold: 7000, chance: 0.08 }
];

function getRandomColor() { return `hsl(${Math.random() * 360}, 100%, 50%)`; }
function generateId() { return Math.random().toString(36).substr(2, 9); }
function getVirusColor(size) {
    const ratio = Math.min(1, Math.max(0, (size - 100) / (MAX_VIRUS_SIZE - 100)));
    return `hsl(${120 - (ratio * 60)}, ${100 - (ratio * 30)}%, 45%)`;
}

function spawnVirus() {
    let attempts = 0, x, y, valid;
    do {
        x = Math.random() * MAP_WIDTH; y = Math.random() * MAP_HEIGHT; valid = true;
        for (const v of viruses) { if (Math.hypot(x - v.x, y - v.y) < 800) { valid = false; break; } }
        attempts++;
    } while (!valid && attempts < 15);
    viruses.push({ x: x, y: y, id: generateId(), size: 100, color: getVirusColor(100), vx: 0, vy: 0 });
}
for (let i = 0; i < MAX_VIRUS; i++) spawnVirus();

function spawnChest() {
    if (chests.length >= MAX_CHESTS) return;
    const rand = Math.random();
    let rarity = 'common';
    if (rand < 0.05) rarity = 'legendary'; else if (rand < 0.20) rarity = 'epic'; else if (rand < 0.50) rarity = 'rare';
    chests.push({ x: Math.random() * MAP_WIDTH, y: Math.random() * MAP_HEIGHT, size: 60, id: generateId(), rarity: rarity });
}
for (let i = 0; i < MAX_CHESTS; i++) spawnChest();

function createMission() {
    const mt = MISSION_TYPES[Math.floor(Math.random() * MISSION_TYPES.length)];
    const t = Math.floor(Math.random() * (mt.targetMax - mt.targetMin + 1)) + mt.targetMin;
    const r = Math.floor(Math.random() * (mt.rewardMax - mt.rewardMin + 1)) + mt.rewardMin;
    return { type: mt.type, name: mt.name, target: t, progress: 0, reward: r, startTime: Date.now() };
}

class Bot {
    constructor(id) {
        this.id = id; this.name = botNames[Math.floor(Math.random() * botNames.length)]; this.isBot = true; this.mouseAngle = 0; this.spawnTime = Date.now();
        this.cells = [{ x: Math.random()*MAP_WIDTH, y: Math.random()*MAP_HEIGHT, size: START_SIZE, color: getRandomColor(), boostX: 0, boostY: 0, canMergeTime: 0 }];
    }
    tick() { if (Math.random() < 0.05) this.mouseAngle = Math.random() * Math.PI * 2; }
}

function checkBotCount() {
    const realCount = Object.values(players).filter(p => !p.isBot && !p.inArena).length;
    const req = Math.max(0, TARGET_BOTS - realCount);
    const currentBots = Object.values(players).filter(p => p.isBot);
    if (currentBots.length < req) { let id = 'bot_' + generateId(); players[id] = new Bot(id); } 
    else if (currentBots.length > req && currentBots.length > 0) { delete players[currentBots[0].id]; }
}

async function resetRound() {
    let winnerId = null, maxScore = -1;
    for(const id in players) {
        if(players[id].inArena) continue;
        const score = players[id].cells.reduce((acc, c) => acc + (c.size * c.size / 100), 0);
        if(score > maxScore) { maxScore = score; winnerId = id; }
    }
    if(winnerId && players[winnerId] && !players[winnerId].isBot && players[winnerId].email) {
        try {
            const user = await User.findOne({ email: players[winnerId].email });
            if(user) {
                user.gold += jackpot;
                await user.save();
                io.to(winnerId).emit('updateUserData', { gold: user.gold });
            }
            io.emit('newChat', { name: "SUNUCU", message: `TUR BİTTİ! KAZANAN: ${players[winnerId].name} (+${jackpot} Gold)` });
        } catch(e) { console.error(e); }
    } else { io.emit('newChat', { name: "SUNUCU", message: `TUR BİTTİ! Kazanan yok.` }); }
    
    jackpot = 0; roundEndTime = Date.now() + ROUND_DURATION;
    foods = []; viruses = []; ejectedMasses = [];
    while(viruses.length < MAX_VIRUS) spawnVirus();
    for(const id in players) { 
        if(players[id].inArena) continue;
        players[id].cells = [{ x: Math.random()*MAP_WIDTH, y: Math.random()*MAP_HEIGHT, size: START_SIZE, color: getRandomColor(), boostX: 0, boostY: 0, canMergeTime: 0 }];
        players[id].spawnTime = Date.now();
    }
}

function startTournament() {
    tournament.active = true; tournament.startTime = Date.now(); tournament.endTime = Date.now() + TOURNAMENT_DURATION; tournament.leaderboard = {}; tournament.prizePool = 0;
    io.emit('tournamentStart', { duration: TOURNAMENT_DURATION });
    io.emit('newChat', { name: "🏆 TURNUVA", message: `TURNUVA BAŞLADI! 1 SAAT - JACKPOT KAZANILACAK!` });
}
async function endTournament() {
    let winner = null, maxScore = 0;
    for(let email in tournament.leaderboard) { if(tournament.leaderboard[email] > maxScore) { maxScore = tournament.leaderboard[email]; winner = email; } }
    const finalPrize = tournament.prizePool;
    if(winner && finalPrize > 0) {
        try {
            const user = await User.findOne({ email: winner });
            if(user) {
                user.gold += finalPrize;
                await user.save();
                io.emit('newChat', { name: "🏆 TURNUVA", message: `KAZANAN: ${user.nickname} - ÖDÜL: ${finalPrize} GOLD!` });
            }
        } catch(e) {}
    } else { io.emit('newChat', { name: "🏆 TURNUVA", message: "Turnuva bitti! Kazanan yok." }); }
    tournament.active = false; tournament.prizePool = 0; io.emit('tournamentEnd', { winner: winner, prize: finalPrize });
}
setTimeout(() => startTournament(), 60000);

async function completeMission(player, socketId) {
    if(!player.mission || !player.email) return;
    try {
        const user = await User.findOne({ email: player.email });
        if(user) {
            user.gold += player.mission.reward;
            await user.save();
            io.to(socketId).emit('missionComplete', { reward: player.mission.reward, total: user.gold, missionName: player.mission.name });
            io.to(socketId).emit('updateUserData', { gold: user.gold });
            io.emit('newChat', { name: "🎯 GÖREV", message: `${player.name} görevi tamamladı! +${player.mission.reward} GOLD` });
        }
    } catch(e){}
    player.mission = createMission(); player.killCount = 0; player.surviveStartTime = Date.now();
    io.to(socketId).emit('newMission', player.mission);
}

function broadcastParty(code) {
    if(!parties[code]) return;
    const p = parties[code];
    const ioSockets = io.sockets.sockets; 
    
    const membersData = p.members.map(mid => {
        const sock = ioSockets.get(mid);
        let displayName = "Bekleniyor...";
        if (players[mid]) displayName = players[mid].email || players[mid].name;
        else if (sock && sock.userEmail) displayName = sock.userEmail;
        else if (sock) displayName = "Misafir";
        return { name: displayName, id: mid, isLeader: mid === p.leader };
    });

    p.members.forEach(mid => { io.to(mid).emit('partyUpdate', { code: code, members: membersData }); });
}

io.on('connection', (socket) => {
    socket.on('register', async (data) => {
        try {
            const existing = await User.findOne({ email: data.email });
            if (existing) return socket.emit('authError', 'Bu mail zaten kayıtlı!');
            
            const newUser = new User({
                email: data.email,
                password: Buffer.from(data.password).toString('base64'),
                nickname: data.nickname || "Adsız",
                token: makeToken()
            });
            await newUser.save();
            
            socket.emit('authSuccess', { nickname: newUser.nickname, email: newUser.email, token: newUser.token, gold: 0, spins: 0, isPremium: false, chests: newUser.chests });
            socket.userEmail = newUser.email;
        } catch(e) { socket.emit('authError', 'Kayıt hatası'); }
    });
    
    socket.on('login', async (data) => {
        try {
            const pass = Buffer.from(data.password).toString('base64');
            const user = await User.findOne({ email: data.email, password: pass });
            
            if (user) {
                if(user.premiumUntil && Date.now() > user.premiumUntil) { user.isPremium = false; user.premiumUntil = 0; await user.save(); }
                if(!user.token) { user.token = makeToken(); await user.save(); }
                
                socket.emit('authSuccess', { nickname: user.nickname, email: user.email, token: user.token, gold: user.gold, spins: user.spins, isPremium: user.isPremium, chests: user.chests }); 
                socket.userEmail = user.email; 
            } else socket.emit('authError', 'Hatalı bilgiler!');
        } catch(e) { socket.emit('authError', 'Giriş hatası'); }
    });

    socket.on('loginWithToken', async (data) => {
        try {
            const user = await User.findOne({ token: data.token });
            if(!user) return socket.emit('authError', 'Oturum süresi doldu');
            
            if(user.premiumUntil && Date.now() > user.premiumUntil) { user.isPremium = false; user.premiumUntil = 0; await user.save(); }
            
            socket.userEmail = user.email;
            socket.emit('authSuccess', { nickname: user.nickname, email: user.email, token: user.token, gold: user.gold, spins: user.spins, isPremium: user.isPremium, chests: user.chests });
        } catch(e) { socket.emit('authError', 'Token hatası'); }
    });

    // --- PARTİ ---
    socket.on('createParty', () => {
        if(!socket.userEmail) return socket.emit('authError', 'Parti için giriş yapmalısın!');
        if(socketPartyMap[socket.id]) return; 
        let code = Math.floor(100000 + Math.random() * 900000).toString();
        while(parties[code]) code = Math.floor(100000 + Math.random() * 900000).toString();
        parties[code] = { leader: socket.id, members: [socket.id] };
        socketPartyMap[socket.id] = code;
        if(players[socket.id]) players[socket.id].partyCode = code;
        socket.emit('partyJoined', { code, isLeader: true });
        broadcastParty(code);
    });

    socket.on('joinParty', (code) => {
        if(!socket.userEmail) return socket.emit('authError', 'Giriş yapmalısın!');
        if(!parties[code]) return socket.emit('partyError', 'Parti bulunamadı!');
        if(parties[code].members.length >= 5) return socket.emit('partyError', 'Parti dolu!');
        if(socketPartyMap[socket.id]) return socket.emit('partyError', 'Zaten bir partidesin!');
        parties[code].members.push(socket.id);
        socketPartyMap[socket.id] = code;
        if(players[socket.id]) players[socket.id].partyCode = code;
        socket.emit('partyJoined', { code, isLeader: false });
        broadcastParty(code);
    });

    socket.on('leaveParty', () => {
        if(socketPartyMap[socket.id]) {
            let code = socketPartyMap[socket.id];
            if(parties[code]) {
                parties[code].members = parties[code].members.filter(id => id !== socket.id);
                delete socketPartyMap[socket.id];
                if(players[socket.id]) players[socket.id].partyCode = null;
                socket.emit('partyLeft');
                if(parties[code].members.length === 0) delete parties[code];
                else {
                    if(parties[code].leader === socket.id) parties[code].leader = parties[code].members[0];
                    broadcastParty(code);
                }
            }
        }
    });

    socket.on('buyPremium', async () => {
        if(!socket.userEmail) return;
        const user = await User.findOne({ email: socket.userEmail });
        if (user) {
            if (user.gold >= PREMIUM_COST) {
                user.gold -= PREMIUM_COST; user.isPremium = true; user.premiumUntil = Date.now() + (7 * 24 * 60 * 60 * 1000); 
                await user.save();
                socket.emit('updateUserData', { gold: user.gold, isPremium: user.isPremium });
            } else { socket.emit('authError', 'Yetersiz GOLD!'); }
        }
    });
    
    socket.on('joinGame', async (data) => {
        const safeName = (data && data.nickname) ? data.nickname : "Misafir";
        let isPrem = false;
        if(socket.userEmail) { 
            const user = await User.findOne({ email: socket.userEmail });
            if(user && user.isPremium) isPrem = true;
        }
        const mission = createMission();
        let pCode = socketPartyMap[socket.id] || null;

        players[socket.id] = { 
            id: socket.id, name: safeName.substring(0,12), email: socket.userEmail, isPremium: isPrem, mouseAngle: 0, 
            cells: [{ x: Math.random()*MAP_WIDTH, y: Math.random()*MAP_HEIGHT, size: START_SIZE, color: getRandomColor(), boostX: 0, boostY: 0, canMergeTime: 0 }], 
            spawnTime: Date.now(), mission: mission, killCount: 0, surviveStartTime: Date.now(), lastBoostTime: 0, boostEndTime: 0,
            partyCode: pCode
        }; 
        socket.emit('newMission', mission);
        if(pCode) broadcastParty(pCode);
        checkBotCount();
    });

    socket.on('mouseInput', (angle) => { 
        if(players[socket.id] && !isNaN(angle)) {
            players[socket.id].mouseAngle = angle;
        }
    });

    socket.on('mergeInput', (val) => { if(players[socket.id]) players[socket.id].wantToMerge = val; });
    socket.on('activateBoost', () => { 
        const p = players[socket.id]; if (!p) return; 
        if (Date.now() - (p.lastBoostTime || 0) > 30000) { p.lastBoostTime = Date.now(); p.boostEndTime = Date.now() + 3000; } 
    });
    
    // --- W EJECT (Odaklı Nişan) ---
    socket.on('eject', (angle) => {
        const p = players[socket.id]; if (!p) return;
        if (angle !== undefined && !isNaN(angle)) p.mouseAngle = angle;

        let cx = 0, cy = 0; p.cells.forEach(c => { cx += c.x; cy += c.y; });
        cx /= p.cells.length; cy /= p.cells.length;

        const aimDist = 800;
        let tx = cx + Math.cos(p.mouseAngle) * aimDist;
        let ty = cy + Math.sin(p.mouseAngle) * aimDist;

        p.cells.forEach(cell => {
            if (cell.size > 35) {
                const ejectSize = 15; 
                cell.size = Math.sqrt(cell.size * cell.size - ejectSize * ejectSize); 
                let uniqueAngle = Math.atan2(ty - cell.y, tx - cell.x);
                const dist = cell.size + 5;
                ejectedMasses.push({ 
                    x: cell.x + Math.cos(uniqueAngle) * dist, 
                    y: cell.y + Math.sin(uniqueAngle) * dist, 
                    size: ejectSize, color: cell.color, 
                    vx: Math.cos(uniqueAngle) * 55, vy: Math.sin(uniqueAngle) * 55, 
                    id: generateId() 
                });
            }
        });
    });
    
    // SPLIT
    socket.on('split', () => {
        const p = players[socket.id]; if (!p || p.cells.length >= MAX_CELLS_PER_PLAYER) return;
        let newCells = []; const now = Date.now();
        p.cells.forEach(cell => {
            if (cell.size >= 45 && p.cells.length + newCells.length < MAX_CELLS_PER_PLAYER) {
                const newSize = cell.size / 1.4142; cell.size = newSize; cell.canMergeTime = now + MERGE_COOLDOWN;
                newCells.push({ x: cell.x + Math.cos(p.mouseAngle)*40, y: cell.y + Math.sin(p.mouseAngle)*40, size: newSize, color: cell.color, boostX: Math.cos(p.mouseAngle)*50, boostY: Math.sin(p.mouseAngle)*50, canMergeTime: now + MERGE_COOLDOWN });
            }
        });
        p.cells = p.cells.concat(newCells);
    });
    
    socket.on('sendChat', (msg) => { const p = players[socket.id]; if (p && msg.trim().length > 0) io.emit('newChat', { name: p.name, message: msg.substring(0, 50) }); });
    
    // ÇARK HAKKI TALEP
    socket.on('claimSpin', async () => {
        if(!socket.userEmail) return socket.emit('authError', 'Çark hakkı için giriş yapmalısın!');
        const now = Date.now();
        const user = await User.findOne({ email: socket.userEmail });
        if(user) {
            if(!user.lastWheelSpin) user.lastWheelSpin = 0;
            if(now - user.lastWheelSpin < WHEEL_COOLDOWN) {
                socket.emit('wheelCooldown', { timeLeft: WHEEL_COOLDOWN - (now - user.lastWheelSpin) });
                return;
            }
            user.lastWheelSpin = now;
            user.spins = (user.spins || 0) + 1;
            await user.save();
            socket.emit('spinClaimed', { spins: user.spins, nextSpin: WHEEL_COOLDOWN });
            socket.emit('updateUserData', { gold: user.gold, spins: user.spins });
        }
    });

    // MARKETTE ÇARK
    socket.on('spinWheel', async () => {
        if(!socket.userEmail) return socket.emit('authError', 'Çark için giriş yapmalısın!');
        const user = await User.findOne({ email: socket.userEmail });
        if(user) {
            if(!user.spins || user.spins <= 0) return socket.emit('authError', 'Çark hakkın yok! Oyunda (E) ile kazan.');
            user.spins -= 1;
            let rand = Math.random(), cumulative = 0, wonPrize = WHEEL_PRIZES[0];
            for(const prize of WHEEL_PRIZES) { cumulative += prize.chance; if(rand <= cumulative) { wonPrize = prize; break; } }
            user.gold = (user.gold || 0) + (wonPrize.gold || 0);
            await user.save();
            socket.emit('wheelResult', { prize: wonPrize, gold: user.gold, spins: user.spins });
            socket.emit('updateUserData', { gold: user.gold, spins: user.spins });
        }
    });

    socket.on('openChest', async (data) => {
        if(!socket.userEmail) return socket.emit('authError', 'Giriş yapmalısın!');
        let rarity = data.rarity || 'common';
        const user = await User.findOne({ email: socket.userEmail });
        if(user) {
            if(!user.chests || !user.chests[rarity] || user.chests[rarity] <= 0) return socket.emit('authError', 'Sandık yok!');
            const rewards = { common: [150,250,350], rare: [300,450,500], epic: [500,700,900], legendary: [900,1300,1800] };
            const arr = rewards[rarity] || rewards.common; const goldWon = arr[Math.floor(Math.random()*arr.length)];
            user.chests[rarity] -= 1; user.gold = (user.gold||0) + goldWon;
            await user.save();
            socket.emit('chestOpened', { rarity, goldWon, gold: user.gold, chests: user.chests });
            socket.emit('updateUserData', { gold: user.gold, chests: user.chests });
            io.emit('newChat', { name:"🎁 SANDIK", message:`${user.nickname} ${rarity.toUpperCase()} sandık açtı! +${goldWon} GOLD` });
        }
    });

    socket.on('joinArena', () => {
        const p = players[socket.id]; if(!p || p.inArena || arenaQueue.includes(socket.id)) return;
        arenaQueue.push(socket.id); socket.emit('arenaQueued');
        if(arenaQueue.length >= 2) {
            const p1 = arenaQueue.shift(), p2 = arenaQueue.shift();
            if(!players[p1] || !players[p2]) return;
            const arena = { id: generateId(), players: [p1, p2], startTime: Date.now(), prize: ARENA_PRIZE, bounds: { x: MAP_WIDTH-4000, y: MAP_HEIGHT-4000, width: 3000, height: 3000 } };
            arenas.push(arena);
            [p1, p2].forEach(pid => { if(players[pid]) { players[pid].inArena = arena.id; players[pid].cells=[{x:arena.bounds.x+1500,y:arena.bounds.y+1500,size:START_SIZE,color:getRandomColor(),boostX:0,boostY:0,canMergeTime:0}]; players[pid].spawnTime=Date.now(); } });
            io.to(p1).emit('arenaStart', { opponent: players[p2]?.name||'Rakip', prize: ARENA_PRIZE, bounds: arena.bounds });
            io.to(p2).emit('arenaStart', { opponent: players[p1]?.name||'Rakip', prize: ARENA_PRIZE, bounds: arena.bounds });
            io.emit('newChat', { name: "⚔️ ARENA", message: `${players[p1]?.name} vs ${players[p2]?.name} - DÜELLO!` });
        }
    });
    
    socket.on('playerDied', async (score) => {
        if (!socket.userEmail) return;
        const user = await User.findOne({ email: socket.userEmail });
        if (user) { 
            if (score >= 1000) { 
                let earned = Math.floor(score / 1000) * (user.isPremium ? GOLD_PER_1000_SCORE_PREMIUM : GOLD_PER_1000_SCORE); 
                user.gold += earned; jackpot += Math.floor(earned * 0.1); if(tournament.active) tournament.prizePool += Math.floor(earned * 0.1); 
                await user.save();
                socket.emit('goldEarned', { earned: earned, total: user.gold }); 
                socket.emit('updateUserData', { gold: user.gold }); 
            } 
        }
    });
    socket.on('disconnect', () => { 
        arenaQueue = arenaQueue.filter(id => id !== socket.id);
        const p = players[socket.id];
        
        if(socketPartyMap[socket.id]) {
            let code = socketPartyMap[socket.id];
            delete socketPartyMap[socket.id];
            
            if(parties[code]) {
                parties[code].members = parties[code].members.filter(id => id !== socket.id);
                if(parties[code].members.length === 0) delete parties[code];
                else {
                    if(parties[code].leader === socket.id) parties[code].leader = parties[code].members[0];
                    broadcastParty(code);
                }
            }
        }

        if(p && p.inArena) {
            let arena = arenas.find(a => a.id === p.inArena);
            if(arena) {
                let winner = arena.players.find(pid => pid !== socket.id);
                if(winner && players[winner]) {
                    players[winner].inArena = null; players[winner].cells = [{x:Math.random()*MAP_WIDTH,y:Math.random()*MAP_HEIGHT,size:START_SIZE*2,color:getRandomColor(),boostX:0,boostY:0,canMergeTime:0}];
                    io.to(winner).emit('arenaWin', { prize: arena.prize });
                    if(players[winner].email) { 
                        User.findOne({email:players[winner].email}).then(u => { if(u){ u.gold+=arena.prize; u.save(); io.to(winner).emit('updateUserData',{gold:u.gold}); } });
                    }
                }
                arenas = arenas.filter(a => a.id !== arena.id);
            }
        }
        delete players[socket.id]; checkBotCount(); 
    });
});

setInterval(() => {
    const now = Date.now(); 
    if (now > roundEndTime) resetRound();
    while (foods.length < MAX_FOOD) foods.push({ x: Math.random()*MAP_WIDTH, y: Math.random()*MAP_HEIGHT, color: getRandomColor(), id: generateId(), size: 12 });
    while (viruses.length < MAX_VIRUS) spawnVirus();
    while (chests.length < MAX_CHESTS) spawnChest();
    
    checkBotCount();
    if(tournament.active && now > tournament.endTime) { endTournament(); setTimeout(() => startTournament(), 7200000); }
    if(tournament.active) { for(const id in players) { if(players[id].email && !players[id].isBot && !players[id].inArena) { const s = players[id].cells.reduce((a,c)=>a+c.size*c.size/100,0); if(!tournament.leaderboard[players[id].email] || tournament.leaderboard[players[id].email] < s) tournament.leaderboard[players[id].email]=s; } } }
    
    viruses.forEach(v => { if(v.vx) { v.x+=v.vx; v.y+=v.vy; v.vx*=0.9; v.vy*=0.9; if(Math.abs(v.vx)<0.1){v.vx=0;v.vy=0;} v.x=Math.max(0,Math.min(MAP_WIDTH,v.x)); v.y=Math.max(0,Math.min(MAP_HEIGHT,v.y)); } });
    for (let i = ejectedMasses.length - 1; i >= 0; i--) {
        const m = ejectedMasses[i]; m.x+=m.vx; m.y+=m.vy; m.vx*=0.9; m.vy*=0.9;
        if (m.x<0 || m.x>MAP_WIDTH || m.y<0 || m.y>MAP_HEIGHT) { ejectedMasses.splice(i, 1); continue; }
        for (let j = 0; j < viruses.length; j++) {
            let v = viruses[j];
            if (Math.hypot(m.x - v.x, m.y - v.y) < v.size) {
                v.size += m.size * 0.4; v.color = getVirusColor(v.size); ejectedMasses.splice(i, 1);
                if (v.size >= MAX_VIRUS_SIZE) { v.size = 100; v.color = getVirusColor(100); let a = Math.atan2(m.vy, m.vx); viruses.push({ x:v.x, y:v.y, id:generateId(), size:100, color:getVirusColor(100), vx:Math.cos(a)*25, vy:Math.sin(a)*25 }); } break;
            }
        }
    }

    for (const id in players) {
        const p = players[id]; 
        if (p.isBot) p.tick();
        const canUseMagnet = (now - (p.lastMagnetTime || 0) > MAGNET_COOLDOWN);
        
        let cx=0, cy=0; 
        if(p.cells.length>0){ 
            p.cells.forEach(c=>{cx+=c.x; cy+=c.y}); cx/=p.cells.length; cy/=p.cells.length; 
        }
        
        const angle = (!isNaN(p.mouseAngle)) ? p.mouseAngle : 0;
        let tx = cx + Math.cos(angle)*800;
        let ty = cy + Math.sin(angle)*800;

        p.cells.forEach(cell => {
            if (cell.size > DECAY_START_SIZE) cell.size *= DECAY_RATE;
            let moveAngle = Math.atan2(ty - cell.y, tx - cell.x);
            let speed = Math.max(2, 70 / Math.pow(cell.size || START_SIZE, 0.4)) * ((p.boostEndTime > now) ? 2 : 1);
            if(isNaN(speed)) speed = 5;

            if(Math.abs(cell.boostX) > 0.1 || Math.abs(cell.boostY) > 0.1){ 
                cell.x += (Math.cos(moveAngle) * speed) + cell.boostX; 
                cell.y += (Math.sin(moveAngle) * speed) + cell.boostY; 
                cell.boostX *= 0.9; 
                cell.boostY *= 0.9; 
            } 
            else { 
                cell.x += Math.cos(moveAngle)*speed; 
                cell.y += Math.sin(moveAngle)*speed; 
            }
            
            for(let other of p.cells) { 
                if(cell===other) continue; 
                let d=Math.hypot(cell.x-other.x, cell.y-other.y); 
                if(d < cell.size+other.size && (now < cell.canMergeTime || now < other.canMergeTime)){ 
                    if(d === 0) d = 0.1; 
                    let pen = cell.size+other.size-d; 
                    cell.x += (cell.x-other.x)/d*pen*0.1; 
                    cell.y += (cell.y-other.y)/d*pen*0.1; 
                } 
            }
            cell.x = Math.max(cell.size, Math.min(MAP_WIDTH-cell.size, cell.x)); 
            cell.y = Math.max(cell.size, Math.min(MAP_HEIGHT-cell.size, cell.y));

            for(let i=foods.length-1; i>=0; i--) {
                if(Math.hypot(cell.x-foods[i].x, cell.y-foods[i].y) < cell.size) { 
                    let gain = p.isPremium ? FOOD_MASS_PREMIUM : FOOD_MASS;
                    cell.size = Math.sqrt(cell.size*cell.size + (p.isPremium?FOOD_MASS_PREMIUM:FOOD_MASS)*100); 
                    foods.splice(i,1); 
                    if(p.mission && p.mission.type === 'collectFood' && !p.isBot) { p.mission.progress++; if(p.mission.progress >= p.mission.target) completeMission(p, id); }
                }
            }
            
            for(let i=ejectedMasses.length-1; i>=0; i--) {
                const m = ejectedMasses[i];
                if(Math.hypot(cell.x - m.x, cell.y - m.y) < cell.size) {
                    cell.size = Math.sqrt(cell.size * cell.size + 225);
                    ejectedMasses.splice(i, 1);
                }
            }

            for(let i=viruses.length-1; i>=0; i--){ 
                if(cell.size > viruses[i].size * 1.1 && Math.hypot(cell.x-viruses[i].x, cell.y-viruses[i].y) < cell.size){ 
                    if (p.cells.length >= MAX_CELLS_PER_PLAYER) { cell.size=Math.sqrt(cell.size*cell.size+10000); viruses.splice(i,1); if(p.mission && p.mission.type==='eatViruses' && !p.isBot){p.mission.progress++; if(p.mission.progress>=p.mission.target)completeMission(p,id);} }
                    else { viruses.splice(i,1); for(let k=0; k<8; k++){ if(p.cells.length>=MAX_CELLS_PER_PLAYER)break; if(cell.size>30){cell.size/=1.414; let a=Math.random()*6.28; p.cells.push({x:cell.x,y:cell.y,size:cell.size,color:cell.color,boostX:Math.cos(a)*20,boostY:Math.sin(a)*20,canMergeTime:now+MERGE_COOLDOWN});} } if(p.mission && p.mission.type==='eatViruses' && !p.isBot){p.mission.progress++; if(p.mission.progress>=p.mission.target)completeMission(p,id);} }
                } 
            }
            for(let i=chests.length-1; i>=0; i--) {
                if(Math.hypot(cell.x-chests[i].x, cell.y-chests[i].y) < cell.size) {
                    let c=chests[i]; if(p.email){ 
                        User.findOne({email:p.email}).then(u=>{
                            if(u){
                                if(!u.chests)u.chests={};
                                u.chests[c.rarity]=(u.chests[c.rarity]||0)+1;
                                u.save();
                                io.to(id).emit('chestCollected', {rarity:c.rarity, chests:u.chests});
                            }
                        });
                    } else io.to(id).emit('chestCollectedGuest', {rarity:c.rarity});
                    chests.splice(i,1); spawnChest();
                }
            }
        });

        for(const vid in players){
            if(id===vid || p.inArena!==players[vid].inArena || now-players[vid].spawnTime<SPAWN_PROTECTION_TIME) continue;
            if(socketPartyMap[id] && socketPartyMap[vid] && socketPartyMap[id] === socketPartyMap[vid]) continue;

            p.cells.forEach(h=>{ for(let i=players[vid].cells.length-1; i>=0; i--){ let pre=players[vid].cells[i]; 
                if(h.size>pre.size*1.1 && Math.hypot(h.x-pre.x, h.y-pre.y)<h.size-pre.size*0.4){ 
                    h.size=Math.sqrt(h.size*h.size+pre.size*pre.size); players[vid].cells.splice(i,1); 
                    if(!players[vid].isBot && p.mission && p.mission.type==='eatPlayers' && !p.isBot) p.killCount=(p.killCount||0)+1; 
                } 
            }});
            if(players[vid].cells.length===0){ 
                if(players[vid].isBot && tournament.active) tournament.prizePool+=500;
                if(!players[vid].isBot && p.mission && p.mission.type==='eatPlayers' && !p.isBot){ p.mission.progress=p.killCount||0; if(p.mission.progress>=p.mission.target)completeMission(p,id); }
                delete players[vid]; if(!players[vid]?.isBot)io.to(vid).emit('gameOver'); checkBotCount();
            }
        }
        if(p.cells.length>1){ for(let i=0;i<p.cells.length;i++){ for(let j=i+1;j<p.cells.length;j++){ let c1=p.cells[i], c2=p.cells[j]; if(now>c1.canMergeTime && now>c2.canMergeTime && Math.hypot(c1.x-c2.x, c1.y-c2.y)<c1.size+c2.size){ c1.size=Math.sqrt(c1.size*c1.size+c2.size*c2.size); c2.dead=true; } } } p.cells=p.cells.filter(c=>!c.dead); }
        
        if(p.mission && p.mission.type === 'reachSize' && !p.isBot) { 
            const currentScore = Math.floor(p.cells.reduce((a,c)=>a+c.size*c.size/100,0));
            p.mission.progress = currentScore; 
            if(currentScore >= p.mission.target) completeMission(p, id); 
        }
        if(p.mission && p.mission.type === 'survive' && !p.isBot) { const sec = Math.floor((now - p.surviveStartTime) / 1000); p.mission.progress = sec; if(sec >= p.mission.target) completeMission(p, id); }
    }

    const leaderboard = Object.values(players).filter(p => !p.inArena).map(p => ({ name: p.name, score: Math.floor(p.cells.reduce((a,c)=>a+c.size*c.size/100,0)) })).sort((a,b)=>b.score-a.score).slice(0,5);
    
    const socketIds = Object.keys(players);
    if(socketIds.length === 0) return;

    const baseData = {
        players: players,
        ejectedMasses, chests, leaderboard, jackpot, 
        timeLeft: roundEndTime-now, 
        tournamentActive: tournament.active, 
        tournamentTimeLeft: tournament.active ? tournament.endTime-now : 0, 
        tournamentPrizePool: tournament.prizePool
    };

    socketIds.forEach(sid => {
        const p = players[sid];
        if(!p) return;
        const px = p.cells[0].x;
        const py = p.cells[0].y;
        
        const visibleFoods = foods.filter(f => Math.abs(f.x - px) < VIEW_DIST && Math.abs(f.y - py) < VIEW_DIST);
        const visibleViruses = viruses.filter(v => Math.abs(v.x - px) < VIEW_DIST && Math.abs(v.y - py) < VIEW_DIST);

        io.to(sid).emit('stateUpdate', { 
            ...baseData,
            foods: visibleFoods,
            viruses: visibleViruses
        });
    });

}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Sunucu ${PORT} portunda aktif! (Visibility Chunking Aktif)`));