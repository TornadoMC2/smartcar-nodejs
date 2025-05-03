# Elegoo Car Teachable Machine Pose Control

## Overview

This project allows you to control an Elegoo robot car using pose detection via a web interface. It utilizes Teachable Machine to train a pose model, TensorFlow.js for running the model in the browser, a Node.js backend server with WebSockets for communication, and direct TCP commands to control the car over Wi-Fi.

The frontend (`index.html` and `script.js`) captures video from the car's camera stream, runs the Teachable Machine pose model to classify the user's pose, and sends corresponding commands (Forward, Left, Right, Stop) via WebSocket to the backend server.

The backend (`server.js`) listens for WebSocket connections from the frontend, relays commands to the Elegoo car via a TCP socket connection, and manages the connection state.

## Prerequisites

* **Git:** Required to clone the repository. Download from [https://git-scm.com/](https://git-scm.com/)
* **Node.js and npm:** Required to run the backend server and install dependencies. Download from [https://nodejs.org/](https://nodejs.org/)
* **Elegoo Robot Car:** The specific car model compatible with the TCP commands used (likely an ESP8266/ESP32 based Wi-Fi car).
* **Teachable Machine Pose Model:** You need to train your own pose model using [Google's Teachable Machine](https://teachablemachine.withgoogle.com/train/pose). Export the model (including `model.json`, `metadata.json`, and `weights.bin`) and place it in a specific directory (see Configuration). The model should have classes corresponding to the desired actions (e.g., 'left', 'right', 'move_forward', 'stop').
* **Network:** Both the computer running the server and the Elegoo car must be connected to the same Wi-Fi network.

## Setup

1.  **Clone the Repository:**
    * Open your terminal or command prompt.
    * Use the following command (works on Windows, macOS, and Linux):
        ```bash
        git clone https://github.com/TornadoMC2/smartcar-nodejs.git
        ```
    * Navigate into the cloned repository's `src` directory:
        ```bash
        cd smartcar-nodejs/src
        ```
2.  **Install Dependencies:**
    * While inside the `src` directory, install the required Node.js modules:
        ```bash
        npm install express ws net path
        ```
        *(Note: If a `package.json` file exists in the future, you might just need `npm install`.)*

## Configuration

*Within the `src` directory:*

1.  **Car IP Address:**
    * You **MUST** edit the `CAR_IP` constant in **TWO** files:
        * `server.js`: Update `const CAR_IP = "192.168.4.1";` with your car's actual IP address.
        * `script.js`: Update `const CAR_IP = "192.168.4.1";` with your car's actual IP address. This is used for the video stream URL.
    * Ensure the `CAR_PORT` in `server.js` (default is `100`) and the stream port in `CAR_STREAM_URL` in `script.js` (default is `81`) match your car's configuration.
2.  **Teachable Machine Model:**
    * Create a directory named `model/` inside the `src/` directory (if it doesn't exist).
    * Place your exported Teachable Machine model files (`model.json`, `metadata.json`, `weights.bin`) inside `src/model/`. The `script.js` file expects the model to be located here (`const MODEL_URL = './model/';`).
3.  **Server Port:** The backend server runs on port `3000` by default (`const SERVER_PORT = 3000;` in `server.js`). If this port is occupied, change it here.
4.  **Other Constants (Optional):** Review other constants in `server.js` and `script.js` (like `COMMAND_ID`, speeds, thresholds) and adjust if necessary for your specific car or preferences.

## Running the Application

1.  **Turn on the Elegoo Car:** Ensure it's powered on and connected to the same Wi-Fi network as your computer.
2.  **Start the Backend Server:**
    * Make sure your terminal is still in the `src/` directory (from the Setup steps).
    * Run the server using Node.js:
        ```bash
        node server.js
        ```
    * You should see log messages indicating the server is listening, e.g., `HTTP and WebSocket Server listening on http://localhost:3000`.
3.  **Access the Frontend:**
    * Open a web browser (like Chrome or Firefox).
    * Navigate to `http://localhost:3000`.

## Usage

1.  **Connect to Car:** On the web page, click the "Connect to Car" button. The status should update to indicate connection progress and success/failure.
2.  **Start TM Control:** Once connected to the car, the "Start TM Control" button will be enabled. Click it.
3.  **Load Model & Stream:** The application will load the Teachable Machine model and attempt to load the video stream from the car. Status messages will indicate progress.
4.  **Control:** If the model and stream load successfully, stand in front of your webcam and perform the poses you trained. The application will detect your pose, determine the corresponding action (Forward, Left, Right, Stop), and send the command to the car. The detected pose, confidence levels, and current action sent will be displayed on the page.
5.  **Stop:** Click "Stop TM Control" to deactivate pose control and stop the video stream. Click "Disconnect Car" to close the connection from the server to the car.

## File Structure (within `src/`)
```
src/
├── server.js
├── script.js
├── index.html
└── model/
    ├── model.json
    ├── metadata.json
    └── weights.bin
```
