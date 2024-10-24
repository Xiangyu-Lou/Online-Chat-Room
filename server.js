const http = require("http");
const fs = require("fs");
const socketio = require("socket.io");

const port = 4567;
const file = "client.html";
const path = require('path');

// Create HTTP server and serve the client.html file
const server = http.createServer(function (req, res) {
    fs.readFile(file, function (err, data) {
        if (err) {
            res.writeHead(500);
            return res.end("Error loading client.html");
        }
        res.writeHead(200);
        res.end(data);
    });
});
server.listen(port);

// Attach Socket.IO to the server
const io = new socketio.Server(server);

// Room and user management data structures
let rooms = {
    "lobby": { users: [], isPrivate: false, password: null, bans: [], chatLog: [], creator: null }
};

// Handle Socket.IO connections
io.sockets.on("connection", function (socket) {
    // When a user connects, automatically add them to the lobby
    let username = "Anonymous"; // Default username
    let currentRoom = "lobby";
    rooms[currentRoom].users.push({ socket: socket, username: username });

    // Handle setting a username
    socket.on('set_username', function(data) {
        username = data.username || "Anonymous"; // Set the username or default to "Anonymous"
    });

    // Handle creating a new room
    socket.on('create_room', function(data) {
        const { roomName, isPrivate, password } = data;
        if (rooms[roomName]) {
            // Room already exists
            socket.emit("room_creation_failed", { message: "Room already exists." });
        } else {
            // Create the new room
            rooms[roomName] = {
                users: [],
                isPrivate: isPrivate,
                password: isPrivate ? password : null, // Store password only if room is private
                bans: []
            };
            rooms[roomName].creator = socket.id;
            socket.emit("room_created", { roomName: roomName });
        }
    });

    // Handle joining a room
    socket.on('join_room', function(data) {
        const { roomName, password } = data;
        if (rooms[roomName]) {
            if (rooms[roomName].isPrivate && rooms[roomName].password !== password) {
                // Incorrect password for private room
                socket.emit("room_join_failed", { message: "Incorrect password." });
            } else if (rooms[roomName].bans.includes(socket.id)) {
                // User is banned from the room
                socket.emit("room_join_failed", { message: "You are banned from this room." });
            } else {
                // Leave current room and join the new one
                socket.leave(currentRoom); // Make sure to leave the current room
                const message = username + " has joined the room \"" + roomName + "\""; // Updated message format
                rooms[roomName].users.push({ socket: socket, username: username }); // Add the user to the new room
                currentRoom = roomName;
                socket.join(currentRoom); // Join the new room
                socket.emit("room_joined", { roomName: currentRoom });

                // Broadcast the updated user list to all users in the room
                let usersInRoom = rooms[roomName].users.map(u => u.username);
                io.to(roomName).emit('room_users', { users: usersInRoom });

                // Notify all users in the room that a new user has joined
                io.to(roomName).emit('message_to_client', { username: "System", message: message });
            }
        } else {
            // Room does not exist
            socket.emit("room_join_failed", { message: "Room does not exist." });
        }
    });

    socket.on('leave_room', function() {
        // Make sure the user is part of a room
        if (!currentRoom || !rooms[currentRoom]) {
            socket.emit("error", { message: "You are not currently in a room." });
            return;
        }

        // Find the user and get the username
        const userLeaving = rooms[currentRoom].users.find(user => user.socket === socket);
        let username;
        if (userLeaving) {
            username = userLeaving.username;
        } else {
            socket.emit("error", { message: "User not found in the room." });
            return;
        }

        // Announce to the room that the user has left
        const message = username + " has left the room.";
        io.to(currentRoom).emit('message_to_client', { username: "System", message: message });

        // Remove the user from the current room's user list
        rooms[currentRoom].users = rooms[currentRoom].users.filter(user => user.socket !== socket);

        // Broadcast the updated user list to all users in the room
        let usersInRoom = rooms[currentRoom].users.map(u => u.username);
        io.to(currentRoom).emit('room_users', { users: usersInRoom });

        // Move the user back to the lobby
        socket.leave(currentRoom);
        const lobbyRoomName = "lobby"; // Assuming your lobby room is named "lobby"
        rooms[lobbyRoomName].users.push({ socket: socket, username: username });
        currentRoom = lobbyRoomName;
        socket.join(currentRoom);
        socket.emit("room_left", { roomName: currentRoom });
    });

    // Handle sending a message to a room
    // socket.on('message_to_room', function(data) {
    //     const { message } = data;
    //     // Broadcast the message with the username of the sender to all users in the current room, excluding the lobby
    //     if (currentRoom !== "lobby") {
    //         rooms[currentRoom].users.forEach(user => {
    //             user.socket.emit("message_to_client", { username: username, message: message });
    //         });
    //     }
    // });
    socket.on('message_to_room', function(data) {
        const { message } = data;
        // Broadcast the message with the username of the sender to all users in the current room, excluding the lobby
        if (currentRoom !== "lobby") {
            rooms[currentRoom].users.forEach(user => {
                user.socket.emit("message_to_client", { username: username, message: message });
            });
    
            // Save the chat message to the room's log file
            const logMessage = `${new Date().toISOString()} - ${username}: ${message}\n`;
            const logFilePath = `chatLogs/${currentRoom}.txt`;
            fs.appendFile(logFilePath, logMessage, function(err) {
                if(err) {
                    // Log the error or handle it appropriately
                    console.error("Error appending to file: ", err);
                }
            });
        }
    });

    socket.on('kick_user', function(data) {
        const { username } = data; // Using username instead of userID
    
        // Check if the user is in a room
        if (!currentRoom || !rooms[currentRoom]) {
            socket.emit("error", { message: "You are not currently in a room." });
            return;
        }
    
        // Check if the requesting user is the room creator
        if (socket.id === rooms[currentRoom].creator) {
            // Find the user to kick and get their socket
            const userToKick = rooms[currentRoom].users.find(u => u.username === username);
            let userSocket;
            if (userToKick) {
                userSocket = userToKick.socket;
            } else {
                socket.emit("error", { message: "User not found in the room." });
                return;
            }
    
            // Announce to the room that the user has been kicked
            const message = username + " has been kicked from the room.";
            io.to(currentRoom).emit('message_to_client', { username: "System", message: message });
    
            // Remove the user from the current room's user list
            rooms[currentRoom].users = rooms[currentRoom].users.filter(u => u.username !== username);
    
            // Broadcast the updated user list to all users in the room
            let usersInRoom = rooms[currentRoom].users.map(u => u.username);
            io.to(currentRoom).emit('room_users', { users: usersInRoom });
    
            // Move the user back to the lobby
            userSocket.leave(currentRoom);
            const lobbyRoomName = "lobby"; // Assuming your lobby room is named "lobby"
            rooms[lobbyRoomName].users.push({ socket: userSocket, username: username });
            userSocket.join(lobbyRoomName);
            userSocket.emit("kicked", { roomName: currentRoom });
        } else {
            // If the requesting user is not the room creator, notify them
            socket.emit('kick_failed', { message: "You do not have permission to kick users from this room." });
        }
    });    
     
    // Ban a user from a room
    socket.on('ban_user', function(data) {
        const { username } = data; // Using username instead of userID
    
        // Check if the user is in a room
        if (!currentRoom || !rooms[currentRoom]) {
            socket.emit("error", { message: "You are not currently in a room." });
            return;
        }
    
        // Check if the requesting user is the room creator
        if (socket.id === rooms[currentRoom].creator) {
            // Find the user to ban and get their socket
            const userToBan = rooms[currentRoom].users.find(u => u.username === username);
            let userSocket;
            if (userToBan) {
                userSocket = userToBan.socket;
            } else {
                socket.emit("error", { message: "User not found in the room." });
                return;
            }
    
            // Add the user to the room's ban list using their socket id
            rooms[currentRoom].bans.push(userSocket.id);
    
            // Announce to the room that the user has been banned
            const message = username + " has been banned from the room.";
            io.to(currentRoom).emit('message_to_client', { username: "System", message: message });
    
            // Remove the user from the current room's user list
            rooms[currentRoom].users = rooms[currentRoom].users.filter(u => u.username !== username);
    
            // Broadcast the updated user list to all users in the room
            let usersInRoom = rooms[currentRoom].users.map(u => u.username);
            io.to(currentRoom).emit('room_users', { users: usersInRoom });
    
            // Notify the banned user and move them back to the lobby
            userSocket.emit("banned", { roomName: currentRoom });
            userSocket.leave(currentRoom);
            const lobbyRoomName = "lobby"; // Assuming your lobby room is named "lobby"
            userSocket.join(lobbyRoomName);
        } else {
            // If the requesting user is not the room creator, notify them
            socket.emit('ban_failed', { message: "You do not have permission to ban users from this room." });
        }
    });

    socket.on('request_chatlog', function(data) {
        console.log('Chatlog request received for room:', data.roomName);
        const roomName = data.roomName;
        const chatLogFilePath = path.join(__dirname, 'chatLogs', `${roomName}.txt`);

        // Send the chatlog file if it exists
        fs.readFile(chatLogFilePath, (err, data) => {
            if (err) {
                // Handle the error if the file doesn't exist or other errors
                socket.emit('chatlog_error', 'Failed to read chatlog.');
            } else {
                // Send the chatlog data back to the client
                socket.emit('chatlog_data', { fileName: `${roomName}.txt`, chatLog: data.toString() });
            }
        });
    });

    // Handle disconnection
    socket.on('disconnect', function() {
        // Remove the user from the current room
        rooms[currentRoom].users = rooms[currentRoom].users.filter(s => s !== socket);
    });
});