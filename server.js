const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = {};
const MAP_COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

// --- HELPERS ---
function generateMap() {
  const map = {};
  const terrains = ["terrain-city", "terrain-forest", "terrain-water"];
  for (let y = 1; y <= 10; y++) {
    for (let x = 0; x < 10; x++) {
      map[`${MAP_COLS[x]}${y}`] = terrains[Math.floor(Math.random() * terrains.length)];
    }
  }
  return map;
}

function getSanitizedState(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  const sanitizedPositions = { ...room.gameState.positions };

  // Hide the Ghost from Seekers unless the game is over
  if (player && player.role === "Seeker" && room.status !== "game_over") {
    const hiderId = room.players.find((p) => p.role === "Hider")?.id;
    if (hiderId && sanitizedPositions[hiderId]) {
      delete sanitizedPositions[hiderId];
    }
  }

  return {
    turn: room.gameState.turn,
    round: room.gameState.round,
    map: room.gameState.map,
    positions: sanitizedPositions,
    logs: room.gameState.logs,
    status: room.status
  };
}

// Math to ensure a player only moves exactly 1 space Up/Down/Left/Right
function isAdjacent(pos1, pos2) {
  if (!pos1) return true; // First move (insertion) is always valid anywhere
  const x1 = MAP_COLS.indexOf(pos1[0]);
  const y1 = parseInt(pos1.substring(1));
  const x2 = MAP_COLS.indexOf(pos2[0]);
  const y2 = parseInt(pos2.substring(1));

  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1); 
}

// --- SOCKET LOGIC ---
io.on("connection", (socket) => {
  console.log(`Operator connected: ${socket.id}`);

  socket.on("createRoom", (playerName) => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

    rooms[code] = {
      id: code,
      host: socket.id,
      players: [{ id: socket.id, name: playerName || "Agent_01", role: "Hider" }],
      status: "waiting",
      gameState: null,
    };
    socket.join(code);
    io.to(code).emit("roomUpdated", rooms[code]);
  });

  socket.on("joinRoom", ({ roomCode, playerName }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return socket.emit("errorMsg", "Signal not found.");
    if (room.status !== "waiting") return socket.emit("errorMsg", "Operation already underway.");
    room.players.push({ id: socket.id, name: playerName, role: "Seeker" });
    socket.join(room.id);
    io.to(room.id).emit("roomUpdated", room);
  });

  socket.on("startGame", (roomCode) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id && room.players.length >= 2) {
      room.status = "playing";
      room.gameState = { turn: "Hider", round: 1, map: generateMap(), positions: {}, logs: ["Operation Commenced. Ghost, select your insertion point."] };
      io.to(roomCode).emit("gameStarted", room);
      room.players.forEach((p) => { io.to(p.id).emit("gameStateUpdated", getSanitizedState(room, p.id)); });
    }
  });

  // --- GAME MOVEMENT LOGIC ---
  socket.on("submitMove", ({ roomCode, coord }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== "playing") return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || room.gameState.turn !== player.role) return socket.emit("errorMsg", "Sequence violation: Not your turn.");

    const currentPos = room.gameState.positions[socket.id];

    // Check Rules: Is the move adjacent?
    if (!isAdjacent(currentPos, coord)) {
      return socket.emit("errorMsg", "Invalid Vector: Sector not adjacent.");
    }

    // Apply Move
    room.gameState.positions[socket.id] = coord;
    const ghost = room.players.find(p => p.role === "Hider");
    const ghostPos = room.gameState.positions[ghost.id];

    // Turn Toggle & Win Condition Logic
    if (player.role === "Hider") {
      room.gameState.logs.push(`[Round ${room.gameState.round}] The Ghost has shifted sectors.`);
      room.gameState.turn = "Seeker";
    } else {
      room.gameState.logs.push(`Agent ${player.name} deployed to Sector ${coord}.`);
      
      // DID THEY CATCH THE GHOST?
      if (coord === ghostPos) {
        room.status = "game_over";
        room.gameState.logs.push(`🚨 TARGET SECURED! Agent ${player.name} intercepted the Ghost at ${coord}! Mission Success!`);
      } else {
        room.gameState.turn = "Hider";
        room.gameState.round++;
      }
    }

    room.players.forEach((p) => io.to(p.id).emit("gameStateUpdated", getSanitizedState(room, p.id)));
  });

  // --- SEEKER ABILITIES ---
  socket.on("useAbility", ({ roomCode, ability }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== "playing") return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== "Seeker") return;
    if (room.gameState.turn !== "Seeker") return socket.emit("errorMsg", "Sequence violation: Not your turn.");

    const ghost = room.players.find(p => p.role === "Hider");
    const ghostPos = room.gameState.positions[ghost.id];
    const seekerPos = room.gameState.positions[player.id];

    if (!ghostPos || !seekerPos) return socket.emit("errorMsg", "Deployment required before using assets.");

    if (ability === "ping") {
      const terrainType = room.gameState.map[ghostPos].split('-')[1]; 
      room.gameState.logs.push(`Agent ${player.name} ran PING protocol: Target is in a [${terrainType.toUpperCase()}] sector.`);
    } else if (ability === "radar") {
      const gx = MAP_COLS.indexOf(ghostPos[0]);
      const gy = parseInt(ghostPos.substring(1));
      const sx = MAP_COLS.indexOf(seekerPos[0]);
      const sy = parseInt(seekerPos.substring(1));

      let dir = "";
      if (gy < sy) dir += "NORTH";
      if (gy > sy) dir += "SOUTH";
      if (gx > sx) dir += dir ? "-EAST" : "EAST";
      if (gx < sx) dir += dir ? "-WEST" : "WEST";
      
      room.gameState.logs.push(`Agent ${player.name} initiated RADAR sweep: Anomaly detected to the [${dir}].`);
    }

    room.gameState.turn = "Hider";
    room.gameState.round++;
    room.players.forEach((p) => io.to(p.id).emit("gameStateUpdated", getSanitizedState(room, p.id)));
  });

  socket.on("disconnect", () => {
    console.log(`Operator disconnected: ${socket.id}`);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const playerIndex = room.players.findIndex((p) => p.id === socket.id);

      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
          delete rooms[roomCode];
        } else {
          if (room.host === socket.id) {
            room.host = room.players[0].id;
          }
          io.to(roomCode).emit("roomUpdated", room);
        }
      }
    }
  });
});

server.listen(process.env.PORT || 3000, () => console.log(`Server Uplink Active`));