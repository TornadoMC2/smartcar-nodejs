const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');

// --- Configuration ---
const SERVER_PORT = 3000;
const CAR_IP = "192.168.4.1"; // <<< --- CHANGE THIS TO YOUR CAR'S IP ADDRESS --- <<<
const CAR_PORT = 100;
const COMMAND_ID = "Elegoo";
const HEARTBEAT_INTERVAL_MS = 1000; // Send heartbeat every 1 second
const CONNECT_TIMEOUT_MS = 5000; // Car connection timeout
const SEND_DEBOUNCE_MS = 50; // Prevent flooding commands (min time between sends)

// --- State ---
let carSocket = null;
let isCarConnected = false;
let heartbeatInterval = null;
let lastCommandTime = 0;
let lastSentCommand = null; // Store the last command JSON string sent

// --- Car Command Helpers (from Python script) ---
function createStopCommandJson() {
    return JSON.stringify({ "H": COMMAND_ID, "N": 4, "D1": 0, "D2": 0 }) + "\n";
}

function createN4CommandJson(leftSpeed, rightSpeed) {
    const l = Math.max(-255, Math.min(255, Math.round(leftSpeed)));
    const r = Math.max(-255, Math.min(255, Math.round(rightSpeed)));
    return JSON.stringify({ "H": COMMAND_ID, "N": 4, "D1": l, "D2": r }) + "\n";
}
const DIR_CODE_LEFT = 1;
const DIR_CODE_RIGHT = 2;
function createN3CommandJson(directionCode, speed) {
    const s = Math.max(0, Math.min(255, Math.round(speed)));
    return JSON.stringify({ "H": COMMAND_ID, "N": 3, "D1": directionCode, "D2": s }) + "\n";
}

// --- Fixed Speed/Turning Config (can be adjusted) ---
const DEFAULT_SPEED = 100;
const TURNING_SPEED = 75; // N3 turning speed

const CMD_STOP = createStopCommandJson();
const CMD_FORWARD = createN4CommandJson(DEFAULT_SPEED, DEFAULT_SPEED);
const CMD_BACKWARD = createN4CommandJson(-DEFAULT_SPEED, -DEFAULT_SPEED); // Example, not used by pose model
const CMD_LEFT = createN3CommandJson(DIR_CODE_LEFT, TURNING_SPEED);
const CMD_RIGHT = createN3CommandJson(DIR_CODE_RIGHT, TURNING_SPEED);
const CMD_HEARTBEAT = "{Heartbeat}\n";

const ACTION_COMMAND_MAP = {
    'STOP': CMD_STOP,
    'FORWARD': CMD_FORWARD,
    'LEFT': CMD_LEFT,
    'RIGHT': CMD_RIGHT,
    // Add 'BACKWARD': CMD_BACKWARD if needed
};

// --- Express App Setup ---
const app = express();
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
const server = http.createServer(app);

// --- WebSocket Server Setup ---
const wss = new WebSocket.Server({ server });

console.log(`WebSocket server starting on port ${SERVER_PORT}`);

wss.on('connection', (ws) => {
    console.log('Client connected via WebSocket.');

    // Send current car connection status to newly connected client
    broadcastConnectionStatus();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received from client:', data);

            if (data.type === 'connect') {
                if (!isCarConnected) {
                    connectToCar();
                } else {
                    console.log("Already connected/connecting to car.");
                    broadcastConnectionStatus(); // Re-send status
                }
            } else if (data.type === 'disconnectCar') {
                disconnectFromCar('Client request');
            } else if (data.type === 'command') {
                const commandJson = ACTION_COMMAND_MAP[data.action];
                if (commandJson) {
                    sendCarCommand(commandJson, `Client Action: ${data.action}`);
                } else {
                    console.warn(`Unknown action received: ${data.action}`);
                    // Optionally send STOP on unknown command
                    // sendCarCommand(CMD_STOP, `Unknown Action Fallback`);
                }
            }
        } catch (e) {
            console.error('Failed to parse message or invalid message format:', message, e);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
        // Optional: If the last client disconnects, stop the car?
        // if (wss.clients.size === 0 && isCarConnected) {
        //     console.log("Last client disconnected. Stopping car.");
        //     sendCarCommand(CMD_STOP, "Last Client Disconnect");
        //     // Maybe disconnect from car too? Or leave it for next client?
        //     // disconnectFromCar("Last client disconnected");
        // }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// --- TCP Socket Functions for Car ---
function connectToCar() {
    if (carSocket || isCarConnected) {
         console.log("Connection attempt skipped: Already connected or in progress.");
         // broadcastConnectionStatus(); // Update clients just in case
         return;
    }
    console.log(`Attempting to connect to car at ${CAR_IP}:${CAR_PORT}...`);
    // Notify clients that connection is in progress
    broadcast({ type: 'status', isConnected: false, message: 'Connecting...' });


    carSocket = new net.Socket();
    carSocket.setTimeout(CONNECT_TIMEOUT_MS);

    carSocket.connect(CAR_PORT, CAR_IP, () => {
        console.log('Successfully connected to the car.');
        isCarConnected = true;
        carSocket.setTimeout(0); // Disable connect timeout, rely on heartbeat/errors

        // Set TCP options (best effort, might not work on all OS/Node versions)
        try { carSocket.setKeepAlive(true, 1000); console.log("TCP KeepAlive enabled."); }
        catch (e) { console.warn("Could not set TCP KeepAlive:", e.message); }
        try { carSocket.setNoDelay(true); console.log("TCP NoDelay enabled."); }
        catch (e) { console.warn("Could not set TCP NoDelay:", e.message); }


        startHeartbeat();
        // Send an initial stop command upon connection for safety
        sendCarCommand(CMD_STOP, "Initial Connection");
        broadcastConnectionStatus();
    });

    carSocket.on('data', (data) => {
        // The car might send status data, log it for now
        console.log('Data from car:', data.toString().trim());
    });

    carSocket.on('timeout', () => {
        console.error('Car connection timeout.');
        disconnectFromCar('Connection Timeout');
    });

    carSocket.on('error', (err) => {
        console.error('Car socket error:', err.message);
        // Don't call disconnectFromCar here if 'close' will also be emitted
        // disconnectFromCar(`Socket Error: ${err.code || err.message}`);
    });

    carSocket.on('close', (hadError) => {
        const reason = hadError ? 'Socket Error/Closed' : 'Connection Closed by Car';
        console.log(`Car connection closed. Reason: ${reason}`);
        // Ensure cleanup happens only once and state is reset
        if (isCarConnected || carSocket) {
             disconnectFromCar(reason); // Use the disconnect function for proper cleanup
        }
    });
}

function disconnectFromCar(reason = 'Unknown') {
    console.log(`Disconnecting from car. Reason: ${reason}`);
    stopHeartbeat();
    isCarConnected = false;
    lastSentCommand = null; // Reset last command on disconnect

    if (carSocket) {
        carSocket.removeAllListeners(); // Prevent duplicate close/error handling
        carSocket.destroy(); // Force close the socket
        carSocket = null;
    }
    broadcastConnectionStatus(reason); // Notify clients about the disconnection
}

function sendCarCommand(commandJson, source = "Unknown") {
    if (!isCarConnected || !carSocket) {
        console.warn(`Cannot send command (${source}): Not connected to car.`);
        return;
    }

    const now = Date.now();
    // Debounce: Check time since last command
    // Also prevent sending the exact same command repeatedly unless it's heartbeat
    if (now - lastCommandTime < SEND_DEBOUNCE_MS && commandJson !== CMD_HEARTBEAT) {
        // console.log(`Command debounce (${source}): Skipping.`);
        return;
    }
    if (commandJson === lastSentCommand && commandJson !== CMD_HEARTBEAT) {
        // console.log(`Command unchanged (${source}): Skipping.`);
        return;
    }


    // Reduce logging spam for heartbeat/stop
    if (commandJson !== CMD_HEARTBEAT && commandJson !== CMD_STOP) {
       console.log(`Sending to car (${source}): ${commandJson.trim()}`);
    } else if (commandJson === CMD_STOP && lastSentCommand !== CMD_STOP) {
       console.log(`Sending to car (${source}): ${commandJson.trim()}`); // Log STOP only when it changes
    }


    carSocket.write(commandJson, 'utf-8', (err) => {
        if (err) {
            console.error('Error sending command to car:', err);
            disconnectFromCar(`Send Error: ${err.message}`);
        } else {
            lastCommandTime = now;
             // Store the last successfully *attempted* non-heartbeat command
            if (commandJson !== CMD_HEARTBEAT) {
               lastSentCommand = commandJson;
            }
        }
    });
}

function startHeartbeat() {
    stopHeartbeat(); // Clear any existing interval
    console.log(`Starting heartbeat (${HEARTBEAT_INTERVAL_MS}ms).`);
    heartbeatInterval = setInterval(() => {
        sendCarCommand(CMD_HEARTBEAT, "Heartbeat");
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        console.log("Heartbeat stopped.");
    }
}

// --- Broadcasting Functions ---
function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastConnectionStatus(error = null) {
    console.log(`Broadcasting connection status: ${isCarConnected ? 'Connected' : 'Disconnected'}${error ? `(${error})` : ''}`);
    broadcast({
        type: 'status',
        isConnected: isCarConnected,
        error: error // Include reason for disconnection if provided
    });
}

// --- Server Start ---
server.listen(SERVER_PORT, () => {
    console.log(`HTTP and WebSocket Server listening on http://localhost:${SERVER_PORT}`);
    console.log(`Backend ready. Open the HTML page in your browser.`);
    console.log(`Ensure the car is powered on and connected to the same network.`);
    console.log(`Target car IP: ${CAR_IP}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('\nSIGINT received. Shutting down...');
    stopHeartbeat();
    if (isCarConnected) {
        console.log("Sending final STOP command before exit.");
        // Use a direct write attempt, might fail if socket already closing
        try {
            if (carSocket && !carSocket.destroyed) {
                carSocket.write(CMD_STOP, 'utf-8', () => {
                     carSocket.destroy(); // Close after writing stop
                     process.exit(0);
                });
                 // Timeout for safety
                 setTimeout(() => {
                      if (carSocket && !carSocket.destroyed) carSocket.destroy();
                      process.exit(0);
                 }, 500);
            } else {
                process.exit(0);
            }

        } catch (e) {
             console.error("Error sending final stop:", e.message);
             if (carSocket && !carSocket.destroyed) carSocket.destroy();
             process.exit(0);
        }

    } else {
        process.exit(0);
    }

});