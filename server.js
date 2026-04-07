const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Central state to store all active rooms
const rooms = {};

// Helper: Generates a random 4-letter room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create a new room
    socket.on('createRoom', (playerName) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            id: roomCode,
            host: socket.id,
            // The first player to join is automatically the Hider
            players: [{ id: socket.id, name: playerName || 'Player 1', role: 'Hider' }],
            status: 'waiting'
        };
        
        socket.join(roomCode);
        io.to(roomCode).emit('roomUpdated', rooms[roomCode]);
    });

    // Join an existing room
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = rooms[roomCode.toUpperCase()];
        
        if (!room) return socket.emit('errorMsg', 'Room not found.');
        if (room.status !== 'waiting') return socket.emit('errorMsg', 'Game already started.');
        if (room.players.length >= 5) return socket.emit('errorMsg', 'Room is full (Max 5).');

        // Subsequent players are Seekers
        const newPlayer = { 
            id: socket.id, 
            name: playerName || `Player ${room.players.length + 1}`, 
            role: 'Seeker' 
        };
        
        room.players.push(newPlayer);
        socket.join(room.id);
        
        // Notify everyone in the room that someone joined
        io.to(room.id).emit('roomUpdated', room);
    });

    // Host starts the game
    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id) {
            if (room.players.length >= 2) {
                room.status = 'playing';
                io.to(roomCode).emit('gameStarted', room);
            } else {
                socket.emit('errorMsg', 'Need at least 2 players to start.');
            }
        }
    });

    // Handle disconnections (cleanup)
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1); // Remove player
                
                if (room.players.length === 0) {
                    delete rooms[roomCode]; // Destroy empty room
                } else {
                    // Reassign host if the host left
                    if (room.host === socket.id) {
                        room.host = room.players[0].id;
                    }
                    io.to(roomCode).emit('roomUpdated', room);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});