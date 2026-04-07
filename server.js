const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};

// Helper: Generate a consistent map for a room
const MAP_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
function generateMap() {
    const map = {};
    const terrains = ['terrain-city', 'terrain-forest', 'terrain-water'];
    for (let y = 1; y <= 10; y++) {
        for (let x = 0; x < 10; x++) {
            // Generates a map layout everyone in the room will share
            map[`${MAP_COLS[x]}${y}`] = terrains[Math.floor(Math.random() * terrains.length)];
        }
    }
    return map;
}

// Helper: Sanitize state so Seekers cannot see the Hider's position via DevTools cheating
function getSanitizedState(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    const sanitizedPositions = { ...room.gameState.positions };

    // If the requesting player is a Seeker, delete the Hider's position from the network payload
    if (player && player.role === 'Seeker') {
        const hiderId = room.players.find(p => p.role === 'Hider')?.id;
        if (hiderId && sanitizedPositions[hiderId]) {
            delete sanitizedPositions[hiderId];
        }
    }

    return {
        turn: room.gameState.turn,
        round: room.gameState.round,
        map: room.gameState.map,
        positions: sanitizedPositions,
        logs: room.gameState.logs
    };
}

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // --- LOBBY LOGIC (Remains exactly the same) ---
    socket.on('createRoom', (playerName) => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let code = '';
        for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        
        rooms[code] = {
            id: code,
            host: socket.id,
            players: [{ id: socket.id, name: playerName || 'Player 1', role: 'Hider' }],
            status: 'waiting',
            gameState: null // Will hold the active game data
        };
        socket.join(code);
        io.to(code).emit('roomUpdated', rooms[code]);
    });

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = rooms[roomCode.toUpperCase()];
        if (!room) return socket.emit('errorMsg', 'Room not found.');
        if (room.status !== 'waiting') return socket.emit('errorMsg', 'Game already started.');
        
        room.players.push({ id: socket.id, name: playerName, role: 'Seeker' });
        socket.join(room.id);
        io.to(room.id).emit('roomUpdated', room);
    });

    // --- GAME INITIALIZATION ---
    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id && room.players.length >= 2) {
            room.status = 'playing';
            room.gameState = {
                turn: 'Hider', // Hider always moves first
                round: 1,
                map: generateMap(),
                positions: {}, // { 'socket.id': 'A1' }
                logs: ['Operation Commenced. Ghost, select your insertion point.']
            };
            
            io.to(roomCode).emit('gameStarted', room);
            
            // Send personalized state to each player immediately
            room.players.forEach(p => {
                io.to(p.id).emit('gameStateUpdated', getSanitizedState(room, p.id));
            });
        }
    });

    // --- GAME MOVEMENT LOGIC ---
    socket.on('submitMove', ({ roomCode, coord }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Validation 1: Is it their turn phase?
        if (room.gameState.turn !== player.role) {
            return socket.emit('errorMsg', "It is not your turn!");
        }

        // Apply Move
        room.gameState.positions[socket.id] = coord;

        // Turn Toggle Logic (Simplified: Hider moves -> All Seekers phase -> Hider moves)
        if (player.role === 'Hider') {
            room.gameState.logs.push(`The Ghost has moved in secret.`);
            room.gameState.turn = 'Seeker'; 
        } else {
            room.gameState.logs.push(`${player.name} moved to ${coord}.`);
            // If we only have 1 seeker for now, flip back to Hider
            // (Later we will add a check to make sure ALL seekers have moved)
            room.gameState.turn = 'Hider';
            room.gameState.round++;
        }

        // Broadcast sanitized state to everyone
        room.players.forEach(p => {
            io.to(p.id).emit('gameStateUpdated', getSanitizedState(room, p.id));
        });
    });

    socket.on('disconnect', () => { /* ... existing disconnect logic ... */ });
});

server.listen(process.env.PORT || 3000, () => console.log(`Server running`));