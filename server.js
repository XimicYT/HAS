const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // Allows your Netlify frontend to connect

const server = http.createServer(app);

// Setup Socket.io with CORS allowing your frontend
const io = new Server(server, {
    cors: {
        origin: "*", // IMPORTANT: Change this to your Netlify URL later for security
        methods: ["GET", "POST"]
    }
});

// Listen for connections
io.on('connection', (socket) => {
    console.log(`A player connected: ${socket.id}`);

    // Handle disconnections
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});