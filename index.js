import can from 'socketcan';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

const HTTP_PORT   = 3000; // Standard port for web traffic
const WS_PORT     = 8080;   // Port for CAN data stream
const CAN_STD_DLC = 8;  // Standard CAN frame data length

const myNodeId    = [0x19, 0x00, 0x00, 0x19]; /* Four byte Node ID for the master */

/* In-memory database for CAN messages */
const canDatabase = {};
let lastReqIntro  = 0; /**< Timestamp of last "request intro" message */
const maxReqIntro = 1800000; /**< Maximum interval between "request intro" messages */

/* Import constants from can_constants.js */
import * as CAN_MSG from './can_constants.js'

/* === Setup === */

// 1. Static HTTP Server to serve HTML/JS files
const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? './index.html' : `.${req.url}`;
    const extname = path.extname(filePath);
    
    // Basic MIME type mapping
    const contentType = extname === '.js' ? 'text/javascript' : 'text/html';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(404);
            res.end('File not found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });

    /* Dump the in-memory database to client */
    if (req.url === '/api/database') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(canDatabase));
        return;
    }
});

server.listen(HTTP_PORT, () => {
    console.log(`Web UI available at http://cancontrol:${HTTP_PORT}`);
});

// 2. WebSocket Server
const wss = new WebSocketServer({ port: WS_PORT });

// 3. CAN Bus Setup
const channel = can.createRawChannel("can0", true);

/* === Functions === */

function sendRequestIntro() {
    writeCanMessageBE(CAN_MSG.REQ_NODE_INTRO_ID, myNodeId);
    lastReqIntro = Date.now();
}

function perodicReqIntro() {
    if (Date.now() - lastReqIntro > maxReqIntro) {
        sendRequestIntro();
    }
}

/**
 * Modular function to write CAN messages with Big Endian data packing
 * @param {number} id - The CAN arbitration ID
 * @param {Array} dataArray - Array of numbers to be packed
 */
function writeCanMessageBE(id, dataArray) {
    const buffer = Buffer.alloc(CAN_STD_DLC); // Standard CAN frame size is 8 bytes

    dataArray.forEach((value, index) => {
        if (index < 8) {
            buffer.writeUInt8(value, index);
        }
    });

    channel.send({ id: id, data: buffer });
}

/**
 * Updates the in-memory database with the latest CAN frame.
 * Organized by Node ID (first 4 bytes) and Arbitration ID.
 * @param {Object} msg - The raw CAN message object from socketcan
 */
function updateMessageDatabase(msg) {
    const NODE_ID_BYTE_LENGTH = 4; /* First 4 bytes represent the Node ID */
    
    /* Ensure the message has enough data to extract a Node ID */
    if (msg.data.length < NODE_ID_BYTE_LENGTH) {
        return;
    }

    /** * Extract Node ID as a Big Endian Hex string.
     * We use the first 4 bytes of the payload as requested.
     */
    const nodeId = msg.data.slice(0, NODE_ID_BYTE_LENGTH).toString('hex').toUpperCase();
    const messageId = `0x${msg.id.toString(16).toUpperCase()}`;

    /* Initialize the Node entry if it doesn't exist */
    if (!canDatabase[nodeId]) {
        canDatabase[nodeId] = {};
    }

    /* Store/Overwrite with the most recent version */
    canDatabase[nodeId][messageId] = {
        payload: [...msg.data], /* Convert buffer to array for easy JSON transport */
        timestamp: Date.now(),
        dlc: msg.data.length
    };
}

/* === Listeners === */

/* CAN Message Listener */
channel.addListener("onMessage", (msg) => {

    /* Update the in-memory database */
    updateMessageDatabase(msg);

    /* Send "request intro" messages periodically */
    perodicReqIntro();

    /* Broadcast to WebSockets as before */
    const payload = JSON.stringify({
        id: msg.id,
        data: [...msg.data],
        timestamp: Date.now()
    });

    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(payload);
        }
    });
});

/* Start the CAN channel */
channel.start();