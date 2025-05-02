const connectButton = document.getElementById('connect-button');
const disconnectButton = document.getElementById('disconnect-button');
const tmButton = document.getElementById('tm-button');
const connectionStatusDiv = document.getElementById('status-connection');
const tmStatusDiv = document.getElementById('status-tm');
const actionStatusDiv = document.getElementById('status-action');
const streamContainer = document.getElementById('stream-container');
const carStreamImg = document.getElementById('car-stream-img');
const overlayCanvas = document.getElementById('overlay-canvas'); // For drawing pose
const processCanvas = document.getElementById('process-canvas'); // Hidden, for TF input
const streamPlaceholder = document.getElementById('stream-placeholder');
const labelContainer = document.getElementById('label-container');

// --- Configuration ---
const WEBSOCKET_URL = `ws://${window.location.hostname}:3000`;
// >>> IMPORTANT: Set the correct IP for your car <<<
const CAR_IP = "192.168.4.1";
const CAR_STREAM_URL = `http://${CAR_IP}:81/stream`;
const MODEL_URL = './model/';
const CONFIDENCE_THRESHOLD = 0.85;
// Desired dimensions for processing the video frame
// Smaller can be faster but less accurate
const PROCESS_WIDTH = 320;
const PROCESS_HEIGHT = 240;
// --- Pose Drawing Config ---
const DRAW_POSE = true; // Set to false to disable drawing the pose overlay
const KEYPOINT_THRESHOLD = 0.2; // Min confidence to draw a keypoint/bone
const KEYPOINT_COLOR = 'aqua';
const BONE_COLOR = 'lime';
const KEYPOINT_RADIUS = 4;
const LINE_WIDTH = 2;

// --- State ---
let ws;
let model, maxPredictions;
let isTmActive = false;
let isStreamLoading = false;
let isConnectedToServer = false;
let isConnectedToCar = false;
let requestAnimationId;
let lastAction = null;
let labels = [];
let overlayCtx = overlayCanvas.getContext('2d');
let processCtx = processCanvas.getContext('2d');
let imageAspectRatio = 4 / 3; // Default aspect ratio (e.g., 320/240)

// --- PoseNet Skeleton Connections ---
// Based on standard PoseNet keypoint order (0-16)
const POSE_CONNECTIONS = [
  // Face
  [0, 1], [0, 2], [1, 3], [2, 4],
  // Body
  [5, 6], [5, 7], [7, 9], [9, 11], [5, 11],
  [6, 8], [8, 10], [10, 12], [6, 12],
  [11, 12], [11, 13], [13, 15],
  [12, 14], [14, 16]
];
// Keypoint names (indices match POSE_CONNECTIONS) - for reference
const KEYPOINT_NAMES = [
    "nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder",
    "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
    "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle"
];


// --- WebSocket Functions ---
function initWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket connection attempt skipped: Already open or connecting.");
        return;
    }

    console.log(`Attempting to connect to WebSocket: ${WEBSOCKET_URL}`);
    ws = new WebSocket(WEBSOCKET_URL);

    ws.onopen = () => {
        console.log('WebSocket connection established.');
        isConnectedToServer = true;
        connectionStatusDiv.textContent = 'Connection: Connected to Server (Checking car status...)';
        connectionStatusDiv.className = 'status status-connected';

        // *** FIX: Send connect message AFTER WebSocket is open ***
        // Now that the WebSocket is open, tell the server to attempt car connection
        console.log("WebSocket opened. Sending connect message to server.");
        sendMessage({ type: 'connect' });

        updateUIState(); // Update button states now that WS is open
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            // console.log('Message from server:', message); // Can be noisy

            if (message.type === 'status') {
                const prevCarConnection = isConnectedToCar;
                isConnectedToCar = message.isConnected;
                if (isConnectedToCar) {
                    connectionStatusDiv.textContent = 'Connection: Connected to Car';
                    connectionStatusDiv.className = 'status status-connected';
                     // Try to start stream loading ONLY if we just connected
                     // Let TM button handle stream loading instead of auto-load
                     // if (!prevCarConnection) { }
                } else {
                    // console.log(`Car disconnected status received: ${message.error || 'Idle'}`);
                    connectionStatusDiv.textContent = `Connection: Disconnected from Car (${message.error || 'Idle'})`;
                    connectionStatusDiv.className = 'status status-disconnected';
                    stopCarStream(); // Stop stream if car disconnects
                    if (isTmActive) {
                        console.log("Car disconnected while TM was active. Stopping TM.");
                        stopTmControl(); // Also updates UI
                    } else {
                        updateUIState(); // Update UI if TM wasn't active
                    }
                    return; // Prevent redundant updateUIState below if stopTmControl was called
                }
                updateUIState(); // Update buttons based on new car status
            } else if (message.type === 'error') {
                 console.error('Server Error:', message.message);
                 connectionStatusDiv.textContent = `Connection Error: ${message.message}`;
                 connectionStatusDiv.className = 'status status-disconnected';
                 isConnectedToCar = false;
                 stopCarStream();
                 if (isTmActive) {
                    stopTmControl();
                 } else {
                     updateUIState();
                 }
            }
        } catch (error) {
            console.error('Failed to parse message or invalid message format:', event.data, error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        connectionStatusDiv.textContent = 'Connection: Error connecting to server.';
        connectionStatusDiv.className = 'status status-disconnected';
        isConnectedToServer = false;
        isConnectedToCar = false;
        stopCarStream();
        if (isTmActive) {
            stopTmControl(); // Updates UI
        } else {
             updateUIState();
        }
    };

    ws.onclose = () => {
        console.log('WebSocket connection closed.');
        if (isConnectedToServer || isConnectedToCar) { // Avoid showing disconnected if never connected
            connectionStatusDiv.textContent = 'Connection: Disconnected from Server';
            connectionStatusDiv.className = 'status status-disconnected';
        }
        isConnectedToServer = false;
        isConnectedToCar = false;
        stopCarStream();
        if (isTmActive) {
            stopTmControl(); // Updates UI
        } else {
             updateUIState();
        }
        ws = null; // Clear the websocket object
    };
}

function sendMessage(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        // Log the error, but don't alert to avoid spamming user
        console.error('WebSocket is not open. Cannot send message:', message);
        // Perhaps update UI temporarily?
        // connectionStatusDiv.textContent = 'Connection Error: Cannot reach server.';
        // connectionStatusDiv.className = 'status status-disconnected';
    }
}

// --- Car Stream Handling ---
function loadCarStream() {
    if (isStreamLoading || (carStreamImg.src && carStreamImg.src.startsWith('http'))) {
        console.log("Stream already loading or loaded.");
        if (!isStreamLoading && isTmActive && !requestAnimationId) {
             // If stream loaded previously but loop wasn't running, start it
             console.log("Stream loaded, starting TM loop.");
             loop();
        }
        return;
    }
    console.log(`Loading car stream from: ${CAR_STREAM_URL}`);
    isStreamLoading = true;
    streamPlaceholder.textContent = 'Loading stream...';
    streamPlaceholder.style.display = 'block';
    carStreamImg.style.display = 'none'; // Hide image until loaded

    // Clear previous handlers to avoid duplicates
    carStreamImg.onload = null;
    carStreamImg.onerror = null;

    carStreamImg.onload = () => {
        console.log("Car stream image loaded successfully.");
        isStreamLoading = false;
        streamPlaceholder.style.display = 'none';
        carStreamImg.style.display = 'block';
        // Set canvas sizes based on the loaded image aspect ratio
        imageAspectRatio = carStreamImg.naturalWidth / carStreamImg.naturalHeight;
        resizeCanvases();
        // Now that stream is loaded, if TM is active, start the loop
        if(isTmActive && !requestAnimationId){
             console.log("Stream loaded, starting TM loop.");
            loop();
        }
    };
    carStreamImg.onerror = (err) => {
        console.error("Error loading car stream image:", err);
        isStreamLoading = false;
        streamPlaceholder.textContent = `Error loading stream from ${CAR_STREAM_URL}. Check Car IP and connection.`;
        streamPlaceholder.style.display = 'block';
        carStreamImg.style.display = 'none';
        if (carStreamImg.src) carStreamImg.src = "#"; // Clear src on error to prevent retries

        // Only alert once per attempt potentially
        // alert(`Could not load car stream. Check CAR_IP (${CAR_IP}) in script.js and ensure the car is on and connected.`);

        // Stop TM if it was trying to start
        if(isTmActive){
            console.warn("Stopping TM control due to stream load error.");
            stopTmControl(); // This will update UI
        }
    };
    // Add cache-busting query param? Sometimes helps with MJPEG streams
    // carStreamImg.src = CAR_STREAM_URL + "?timestamp=" + new Date().getTime();
    carStreamImg.src = CAR_STREAM_URL; // Set the source to start loading
}

function stopCarStream() {
    console.log("Stopping car stream.");
    if (carStreamImg.src) carStreamImg.src = "#"; // Use # instead of "" which might reload page in some browsers
    carStreamImg.style.display = 'none';
    streamPlaceholder.textContent = 'Connect to car and start TM to view stream.';
    streamPlaceholder.style.display = 'block';
    isStreamLoading = false;
     // Clear overlay canvas when stream stops
     if (overlayCtx) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
     }
}

function resizeCanvases() {
     // Resize overlay canvas to match the displayed image size (responsive)
    const displayWidth = carStreamImg.clientWidth;
    const displayHeight = carStreamImg.clientHeight;

    if(displayWidth > 0 && displayHeight > 0){
        // Only resize if dimensions have changed significantly to avoid minor fluctuations
        if (overlayCanvas.width !== displayWidth || overlayCanvas.height !== displayHeight) {
            overlayCanvas.width = displayWidth;
            overlayCanvas.height = displayHeight;
            // console.log(`Resized overlay canvas to: ${displayWidth}x${displayHeight}`);
        }
    }

     // Keep processing canvas fixed size for consistent TM input
     if (processCanvas.width !== PROCESS_WIDTH || processCanvas.height !== PROCESS_HEIGHT) {
        processCanvas.width = PROCESS_WIDTH;
        processCanvas.height = PROCESS_HEIGHT;
        // console.log(`Set process canvas size to: ${PROCESS_WIDTH}x${PROCESS_HEIGHT}`);
     }
}

// Debounce resize events
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(resizeCanvases, 100); // Adjust delay as needed
});


// --- Teachable Machine Functions ---
async function initTeachableMachineModel() {
     // Only load the model, not the webcam
     const modelURL = MODEL_URL + 'model.json';
     const metadataURL = MODEL_URL + 'metadata.json';

     try {
         tmStatusDiv.textContent = 'TM Control: Loading model...';
         tmStatusDiv.className = 'status status-idle';

         model = await tmPose.load(modelURL, metadataURL);
         maxPredictions = model.getTotalClasses();
         labels = model.getClassLabels(); // Get labels from metadata

         // Create label divs in UI
         labelContainer.innerHTML = ''; // Clear previous labels
         for (let i = 0; i < maxPredictions; i++) {
            const div = document.createElement('div');
            const labelSpan = document.createElement('span');
            labelSpan.innerText = (labels[i] ? labels[i] : `Class ${i+1}`) + ": ";
            const valueSpan = document.createElement('span');
            valueSpan.id = `label-${i}-value`;
            valueSpan.innerText = "0%";
            const barDiv = document.createElement('div');
            barDiv.className = 'prediction-bar';
            const fillDiv = document.createElement('div');
            fillDiv.className = 'prediction-fill';
            fillDiv.id = `label-${i}-fill`;
            barDiv.appendChild(fillDiv);
            div.appendChild(labelSpan); div.appendChild(valueSpan); div.appendChild(barDiv);
            labelContainer.appendChild(div);
         }

         console.log('Teachable Machine model loaded successfully.');
         tmStatusDiv.textContent = 'TM Control: Model Ready';
         tmStatusDiv.className = 'status status-idle';
         return true;

     } catch (error) {
         console.error("Error initializing Teachable Machine Model:", error);
         tmStatusDiv.textContent = 'TM Control: Error loading model.';
         tmStatusDiv.className = 'status status-disconnected';
         alert(`Error loading model: ${error.message || error}`);
         return false;
     }
}

async function loop() {
    // Check all conditions needed to run the loop
    if (!isTmActive || isStreamLoading || !carStreamImg.src || carStreamImg.src === "#" || carStreamImg.naturalWidth === 0 || !model) {
        // Stop requesting new frames if TM is not active
        if (!isTmActive && requestAnimationId) {
            window.cancelAnimationFrame(requestAnimationId);
            requestAnimationId = null;
            console.log("Animation frame loop stopped because TM is inactive.");
            return;
        }
        // Otherwise, keep requesting frames to check conditions again
        requestAnimationId = window.requestAnimationFrame(loop);
        return;
    }

    try {
        // 1. Ensure canvases are sized correctly before drawing
        resizeCanvases(); // Quick check/resize if needed

        // 2. Draw current image frame onto the processing canvas
        processCtx.drawImage(carStreamImg, 0, 0, processCanvas.width, processCanvas.height);

        // 3. Predict using the processing canvas
        await predict(processCanvas);

    } catch (error) {
        console.error("Error in prediction loop:", error);
        // Optionally stop TM on loop error?
        // stopTmControl();
    }

    // 4. Continue the loop
    requestAnimationId = window.requestAnimationFrame(loop);
}

async function predict(canvasElement) {
    if (!model || !canvasElement) {
        console.warn("Prediction skipped: Model or canvas not ready.");
        return;
    }

    // Prediction logic using estimatePose followed by predict
    const { pose, posenetOutput } = await model.estimatePose(canvasElement);
    const prediction = await model.predict(posenetOutput);

    let highestProb = 0;
    let bestClass = -1;

    if (!labels || labels.length !== maxPredictions) {
        console.error("Labels array mismatch or not loaded.");
        return; // Prevent errors below if labels aren't ready
    }

    // Update prediction bars/values in UI
    for (let i = 0; i < maxPredictions; i++) {
        // Ensure prediction[i] exists before accessing properties
        if (prediction[i]) {
            const probability = prediction[i].probability;
            const valueSpan = document.getElementById(`label-${i}-value`);
            const fillDiv = document.getElementById(`label-${i}-fill`);
            const percentage = (probability * 100).toFixed(1) + '%';
            if(valueSpan) valueSpan.innerText = percentage;
            if(fillDiv) fillDiv.style.width = percentage;
            if (probability > highestProb) {
                highestProb = probability;
                bestClass = i;
            }
        } else {
            // console.warn(`Prediction data missing for index ${i}`);
        }
    }

    // Determine Action based on prediction
    let currentAction = 'STOP'; // Default to STOP
    if (bestClass !== -1 && highestProb >= CONFIDENCE_THRESHOLD) {
        const predictedLabel = labels[bestClass];
        tmStatusDiv.textContent = `TM Control: Active - Detected: ${predictedLabel} (${(highestProb * 100).toFixed(1)}%)`;
        tmStatusDiv.className = 'status status-connected';
        switch (predictedLabel.toLowerCase()) {
            case 'right': currentAction = 'RIGHT'; break;
            case 'left': currentAction = 'LEFT'; break;
            case 'move_forward': case 'go': currentAction = 'FORWARD'; break;
            case 'stop': currentAction = 'STOP'; break;
            default: console.warn(`Unknown label: ${predictedLabel}`); currentAction = 'STOP';
        }
    } else if (bestClass !== -1) {
        const belowConfLabel = labels[bestClass];
        tmStatusDiv.textContent = `TM Control: Active - Low Confidence (${belowConfLabel}: ${(highestProb * 100).toFixed(1)}%)`;
        tmStatusDiv.className = 'status status-idle';
        currentAction = 'STOP';
    } else {
        tmStatusDiv.textContent = `TM Control: Active - Searching...`;
        tmStatusDiv.className = 'status status-idle';
        currentAction = 'STOP';
    }

    // Send command if changed and connected
    if (currentAction !== lastAction) {
         if (isConnectedToCar) {
            // console.log(`Action changed: ${lastAction} -> ${currentAction}. Sending command.`);
            sendMessage({ type: 'command', action: currentAction });
            actionStatusDiv.textContent = `Action: Sending ${currentAction}`;
            actionStatusDiv.className = 'status status-connected'; // Indicate active command sending
         } else {
            // console.log(`Action changed: ${lastAction} -> ${currentAction}. Car disconnected, command not sent.`);
            actionStatusDiv.textContent = `Action: ${currentAction} (Car Disconnected)`;
            actionStatusDiv.className = 'status status-disconnected';
         }
        lastAction = currentAction;
    }

    // Draw the pose overlay if enabled
    if (DRAW_POSE) {
        drawPose(pose, overlayCtx, overlayCanvas.width, overlayCanvas.height);
    } else {
        // Clear overlay if drawing is disabled but was previously enabled
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

// --- Drawing Function (Part 2) ---
function drawPose(pose, ctx, canvasWidth, canvasHeight) {
    if (!pose || !ctx || canvasWidth === 0 || canvasHeight === 0 || processCanvas.width === 0) return; // Add checks for valid dimensions

    // Clear previous drawing
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Need to scale points from process resolution to display resolution
    const scaleX = canvasWidth / processCanvas.width;
    const scaleY = canvasHeight / processCanvas.height;

    // Draw keypoints
    ctx.fillStyle = KEYPOINT_COLOR;
    pose.keypoints.forEach(keypoint => {
        if (keypoint.score >= KEYPOINT_THRESHOLD) {
            const x = keypoint.position.x * scaleX;
            const y = keypoint.position.y * scaleY;
            ctx.beginPath();
            ctx.arc(x, y, KEYPOINT_RADIUS, 0, 2 * Math.PI);
            ctx.fill();
        }
    });

    // Draw skeleton bones
    ctx.strokeStyle = BONE_COLOR;
    ctx.lineWidth = LINE_WIDTH;
    POSE_CONNECTIONS.forEach(([startIdx, endIdx]) => {
        // Check if indices are within the bounds of the keypoints array
         if(startIdx >= 0 && startIdx < pose.keypoints.length && endIdx >= 0 && endIdx < pose.keypoints.length) {
            const startPoint = pose.keypoints[startIdx];
            const endPoint = pose.keypoints[endIdx];

            // Ensure points exist and meet threshold before drawing bone
            if (startPoint && endPoint && startPoint.score >= KEYPOINT_THRESHOLD && endPoint.score >= KEYPOINT_THRESHOLD) {
                const startX = startPoint.position.x * scaleX;
                const startY = startPoint.position.y * scaleY;
                const endX = endPoint.position.x * scaleX;
                const endY = endPoint.position.y * scaleY;

                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(endX, endY);
                ctx.stroke();
            }
        } else {
            // console.warn(`Invalid bone connection indices: ${startIdx}, ${endIdx}`);
        }
    });
}

// --- Control Functions ---
async function startTmControl() {
    if (!isConnectedToCar) {
        alert("Cannot start TM Control: Not connected to the car.");
        return;
    }
    if (isTmActive) {
        console.log("TM is already active.");
        return;
    }

    tmButton.disabled = true;
    tmButton.textContent = 'Starting TM...';

    let modelReady = false;
    if (!model) { // Load model only if not already loaded
        modelReady = await initTeachableMachineModel();
    } else {
        modelReady = true; // Model already loaded
    }

    if (modelReady) {
        isTmActive = true; // Set active early so loop condition is met
        tmButton.textContent = 'Stop TM Control';
        console.log("TM Active. Attempting to load car stream and start loop.");
        tmStatusDiv.textContent = 'TM Control: Active - Loading Stream...';
        tmStatusDiv.className = 'status status-connected';
        lastAction = null; // Reset last action
        loadCarStream(); // Load the stream (loop starts in onload callback if successful)
        // Send initial stop command
        sendMessage({ type: 'command', action: 'STOP' });
        actionStatusDiv.textContent = `Action: Initializing (STOP)`;
        actionStatusDiv.className = 'status status-connected';
    } else {
        tmButton.textContent = 'Start TM Control'; // Reset button on failure
        isTmActive = false; // Ensure TM is marked inactive if model load failed
    }
    updateUIState();
}

function stopTmControl() {
    // Prevent stopping if already stopped
    if (!isTmActive && !requestAnimationId) return;

    isTmActive = false; // Set inactive first
    tmButton.textContent = 'Start TM Control';
    if (requestAnimationId) {
        window.cancelAnimationFrame(requestAnimationId);
        requestAnimationId = null;
        console.log("TM prediction loop stopped.");
    }
    stopCarStream(); // Stop loading/displaying the car stream

    console.log("TM control stopped.");
    tmStatusDiv.textContent = 'TM Control: Stopped';
    tmStatusDiv.className = 'status status-idle';
    actionStatusDiv.textContent = `Action: ---`;
    actionStatusDiv.className = 'status status-idle';

    // Send final stop command if connected
    if (isConnectedToCar) {
         console.log("Sending final STOP command as TM is deactivated.");
         sendMessage({ type: 'command', action: 'STOP' });
         lastAction = 'STOP'; // Record that stop was the last command intended
         actionStatusDiv.textContent = `Action: Sending STOP`;
    }

    // Clear label values/bars
    if (labels && labels.length > 0) {
        for (let i = 0; i < labels.length; i++) {
           const valueSpan = document.getElementById(`label-${i}-value`);
           const fillDiv = document.getElementById(`label-${i}-fill`);
           if(valueSpan) valueSpan.innerText = "0%";
           if(fillDiv) fillDiv.style.width = "0%";
        }
    }
    updateUIState();
}

// --- UI Update Function ---
function updateUIState() {
    // Connect/Disconnect buttons: Connect enabled only if WS is down, Disconnect only if connected to car
    connectButton.disabled = !!ws && ws.readyState !== WebSocket.CLOSED; // Disable connect if WS exists and is not CLOSED
    disconnectButton.disabled = !isConnectedToCar; // Enable only if connected to car

    // TM button: Enable only if connected to the car
    tmButton.disabled = !isConnectedToCar;

    // Ensure TM button text reflects state even if disabled
    tmButton.textContent = isTmActive ? 'Stop TM Control' : 'Start TM Control';

     // Update overall connection status display
     if (isConnectedToCar) {
        connectionStatusDiv.textContent = 'Connection: Connected to Car';
        connectionStatusDiv.className = 'status status-connected';
     } else if (isConnectedToServer) {
        connectionStatusDiv.textContent = 'Connection: Connected to Server (Car Disconnected)';
        connectionStatusDiv.className = 'status status-idle'; // Or disconnected? Idle seems ok.
     } else {
        connectionStatusDiv.textContent = 'Connection: Disconnected';
        connectionStatusDiv.className = 'status status-disconnected';
     }
}


// --- Event Listeners ---
connectButton.addEventListener('click', () => {
    console.log("Connect button clicked."); // Added for clarity
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        // Only initiate if WS is not already open or connecting
        initWebSocket();
        // *** The connect message is now sent in ws.onopen ***
        connectionStatusDiv.textContent = 'Connection: Opening WebSocket...'; // Update status
        connectionStatusDiv.className = 'status status-idle';
    } else if (ws.readyState === WebSocket.OPEN) {
         // If WS is already open, safe to send the connect message immediately
         // This allows retrying the car connection if it failed previously
         console.log("WebSocket already open. Sending connect message to server.");
         sendMessage({ type: 'connect' });
         connectionStatusDiv.textContent = 'Connection: Attempting car connection...';
         connectionStatusDiv.className = 'status status-idle';
    } else {
        // If WS is in CONNECTING state, wait for onopen to trigger the connect message
        console.log("WebSocket is currently connecting. Waiting for onopen.");
        connectionStatusDiv.textContent = 'Connection: WebSocket connecting...';
        connectionStatusDiv.className = 'status status-idle';
    }
});


disconnectButton.addEventListener('click', () => {
    sendMessage({ type: 'disconnectCar' });
    // UI update will happen when server confirms via 'status' message
});

tmButton.addEventListener('click', () => {
    if (isTmActive) {
        stopTmControl();
    } else {
        startTmControl();
    }
});


// --- Initial Setup ---
updateUIState();
console.log("Frontend script loaded. Connect to car, then start TM.");