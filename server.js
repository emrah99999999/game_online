const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

// ---------- تنظیمات بازی ----------
const RACE_DURATION = 120; // ثانیه
const MAX_PLAYERS = 99;
const CAR_TOP_SPEED = 300;
const CAR_ACCELERATION = 400;
const CAR_BRAKE = 500;
const CAR_TURN_SPEED = 4;
const OFFROAD_SPEED_FACTOR = 0.4;

const TRACK_POINTS = [];
const TRACK_CX = 0, TRACK_CY = 0, TRACK_RX = 800, TRACK_RY = 500;
for (let a = 0; a < Math.PI * 2; a += 0.05) {
    TRACK_POINTS.push({
        x: TRACK_CX + TRACK_RX * Math.cos(a),
        y: TRACK_CY + TRACK_RY * Math.sin(a)
    });
}

function closestPointOnTrack(px, py) {
    let minDist = Infinity;
    let closest = { x: 0, y: 0 };
    for (const p of TRACK_POINTS) {
        const dx = p.x - px;
        const dy = p.y - py;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < minDist) {
            minDist = dist;
            closest = p;
        }
    }
    return { point: closest, dist: minDist };
}

let players = {};
let aiPlayers = [];
let raceStatus = 'waiting';
let raceStartTime = 0;
let gameLoopInterval = null;

function createAIPlayer(id) {
    const startAngle = Math.random() * Math.PI * 2;
    return {
        id: id,
        name: 'AI_' + id,
        color: `hsl(${Math.random() * 360}, 80%, 50%)`,
        x: TRACK_CX + 100 * Math.cos(startAngle),
        y: TRACK_CY + 100 * Math.sin(startAngle),
        angle: startAngle + Math.PI/2,
        speed: 0,
        distance: 0,
        input: { accelerate: false, brake: false, left: false, right: false },
        isAI: true
    };
}

function resetRace() {
    const humanPlayers = Object.values(players).filter(p => !p.isAI);
    humanPlayers.forEach((p, i) => {
        const angle = (i / humanPlayers.length) * Math.PI * 2;
        p.x = TRACK_CX + 200 * Math.cos(angle);
        p.y = TRACK_CY + 200 * Math.sin(angle);
        p.angle = angle + Math.PI/2;
        p.speed = 0;
        p.distance = 0;
    });
    aiPlayers = [];
    if (humanPlayers.length === 1) {
        for (let i = 0; i < 4; i++) {
            const ai = createAIPlayer('AI' + i);
            aiPlayers.push(ai);
            players[ai.id] = ai;
        }
    } else {
        Object.keys(players).forEach(id => {
            if (players[id].isAI) delete players[id];
        });
    }
    raceStatus = 'racing';
    raceStartTime = Date.now();
    io.emit('raceStart', { duration: RACE_DURATION });
}

function gameLoop() {
    if (raceStatus !== 'racing') return;
    const now = Date.now();
    const elapsed = (now - raceStartTime) / 1000;
    if (elapsed >= RACE_DURATION) {
        raceStatus = 'finished';
        io.emit('raceEnd', getLeaderboard());
        clearInterval(gameLoopInterval);
        gameLoopInterval = null;
        setTimeout(() => {
            resetRace();
            gameLoopInterval = setInterval(gameLoop, 16);
        }, 10000);
        return;
    }

    const dt = 0.016;
    const allPlayers = { ...players };
    for (const id in allPlayers) {
        const p = allPlayers[id];
        if (p.isAI) {
            const target = TRACK_POINTS[Math.floor(Math.random() * TRACK_POINTS.length)];
            const dx = target.x - p.x;
            const dy = target.y - p.y;
            const targetAngle = Math.atan2(dy, dx);
            let angleDiff = targetAngle - p.angle;
            while (angleDiff > Math.PI) angleDiff -= 2*Math.PI;
            while (angleDiff < -Math.PI) angleDiff += 2*Math.PI;
            p.input.left = angleDiff > 0.2;
            p.input.right = angleDiff < -0.2;
            p.input.accelerate = true;
            p.input.brake = false;
        }

        if (p.input.accelerate && p.speed < CAR_TOP_SPEED) {
            p.speed += CAR_ACCELERATION * dt;
        } else if (p.input.brake && p.speed > 0) {
            p.speed -= CAR_BRAKE * dt;
        } else if (!p.input.accelerate && p.speed > 0) {
            p.speed -= CAR_ACCELERATION * 0.5 * dt;
        }
        if (p.speed < 0) p.speed = 0;

        const turnAmount = CAR_TURN_SPEED * dt * (p.speed / CAR_TOP_SPEED);
        if (p.input.left) p.angle -= turnAmount;
        if (p.input.right) p.angle += turnAmount;

        p.x += Math.cos(p.angle) * p.speed * dt;
        p.y += Math.sin(p.angle) * p.speed * dt;

        const { dist } = closestPointOnTrack(p.x, p.y);
        if (dist > 120) {
            p.speed *= OFFROAD_SPEED_FACTOR;
        }
        p.distance += p.speed * dt;
    }

    const state = {};
    for (const id in players) {
        const p = players[id];
        state[id] = {
            x: p.x,
            y: p.y,
            angle: p.angle,
            speed: p.speed,
            distance: p.distance,
            name: p.name,
            color: p.color
        };
    }
    io.emit('gameState', state);
}

io.on('connection', (socket) => {
    console.log('کاربر متصل شد:', socket.id);

    socket.on('join', (data) => {
        const username = data.username || 'Guest';
        if (Object.keys(players).length >= MAX_PLAYERS) {
            socket.emit('error', 'ظرفیت تکمیل است');
            return;
        }
        const usedColors = Object.values(players).map(p => p.color);
        let color;
        do {
            color = `hsl(${Math.random() * 360}, 70%, 55%)`;
        } while (usedColors.includes(color));

        players[socket.id] = {
            id: socket.id,
            name: username,
            color: color,
            x: TRACK_CX,
            y: TRACK_CY,
            angle: 0,
            speed: 0,
            distance: 0,
            input: { accelerate: false, brake: false, left: false, right: false },
            isAI: false
        };

        socket.emit('joined', { id: socket.id, color: color });
        io.emit('playerList', Object.values(players).filter(p => !p.isAI).map(p => ({ name: p.name, color: p.color })));

        const humanCount = Object.values(players).filter(p => !p.isAI).length;
        if (raceStatus === 'waiting' && humanCount >= 1) {
            resetRace();
            if (!gameLoopInterval) gameLoopInterval = setInterval(gameLoop, 16);
        } else if (raceStatus === 'racing') {
            const angle = Math.random() * Math.PI * 2;
            players[socket.id].x = TRACK_CX + 200 * Math.cos(angle);
            players[socket.id].y = TRACK_CY + 200 * Math.sin(angle);
            players[socket.id].angle = angle + Math.PI/2;
        }
    });

    socket.on('input', (input) => {
        if (players[socket.id] && !players[socket.id].isAI) {
            players[socket.id].input = input;
        }
    });

    socket.on('disconnect', () => {
        console.log('کاربر قطع شد:', socket.id);
        delete players[socket.id];
        io.emit('playerList', Object.values(players).filter(p => !p.isAI).map(p => ({ name: p.name, color: p.color })));
        const humanCount = Object.values(players).filter(p => !p.isAI).length;
        if (humanCount === 1 && raceStatus === 'racing') {
            Object.keys(players).forEach(id => {
                if (players[id].isAI) delete players[id];
            });
            for (let i = 0; i < 4; i++) {
                const ai = createAIPlayer('AI' + i);
                aiPlayers.push(ai);
                players[ai.id] = ai;
            }
        } else if (humanCount === 0) {
            raceStatus = 'waiting';
            if (gameLoopInterval) clearInterval(gameLoopInterval);
            gameLoopInterval = null;
            players = {};
            aiPlayers = [];
        }
    });
});

function getLeaderboard() {
    const all = Object.values(players).map(p => ({ name: p.name, distance: p.distance, color: p.color }));
    all.sort((a, b) => b.distance - a.distance);
    return all.slice(0, 10);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`سرور روی پورت ${PORT} اجرا شد`);
});