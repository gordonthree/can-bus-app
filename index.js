import can from 'socketcan';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

/* === Constants === */
const HTTP_PORT                       = 3000; // Standard port for web traffic
const WS_PORT                         = 8080;   // Port for CAN data stream
const CAN_STD_DLC                     = 8;  // Standard CAN frame data length
const myNodeId                        = [0x19, 0x00, 0x00, 0x19]; /* Four byte Node ID for the master */
const NODE_ID_BYTE_LENGTH             = 4; /**< Number of bytes in a Node ID */
const INTRO_MSG_DLC                   = 8; /**< Data length for "intro" messages */
const SUBMODCNT_OFFSET                = 4; /**< Offset of sub-module count in "intro" messages */
const INTRO_MSG_BEGIN                 = 0x780; /**< Beginning of module (node) "intro" messages */
const INTRO_MSG_END                   = 0x7FF; /**< End of module (node) "intro" messages */
const SUBMOD_INTRO_BEGIN              = 0x700; /**< Beginning of sub-module "intro" messages */
const SUBMOD_INTRO_END                = 0x77F; /**< End of sub-module "intro" messages */
const SUBMODID_OFFSET                 = 4; /**< Offset of sub-module ID in "intro" messages */
const NODE_MAX_SUBMODS                = 8; /**< Maximum number of sub-modules per node */
const SUBMOD_PARTB_OFFSET             = 0x80; /**< Offset of sub-module part B in "intro" messages */
const SUBMOD_PARTB_MASK               = 0x7F; /**< Mask for sub-module part B in "intro" messages */
const SUBMOD_RAW0_OFFSET              = 5; /**< First of three raw config bytes for sub-module */
const SUBMOD_RAW1_OFFSET              = 6; /**< Second of three raw config bytes for sub-module */
const SUBMOD_RAW2_OFFSET              = 7; /**< Third of three raw config bytes for sub-module */
const SUBMOD_DATAMSGID_MSB_OFFSET     = 5; /**< Offset of data message ID MSB in "intro" messages */
const SUBMOD_DATAMSGID_LSB_OFFSET     = 6; /**< Offset of data message ID LSB in "intro" messages */
const SUBMOD_DATAMSGDLC_OFFSET        = 7; /**< Offset of data message DLC in "intro" messages */

/* In-memory database for CAN messages */
const canDatabase                     = {};

/* Counters for perodic messages */
const maxReqIntro                     = 1800000; /**< Maximum interval between "request intro" messages */
const sendTsInterval                  = 10000; /**< Milliseconds between sending timestamp messages */
let lastReqIntro                      = 0; /**< Timestamp of last "request intro" message */
let lastTsMsg                         = 0; /**< Timestamp of last "timestamp" message */

/* Import constants from can_constants.js */
import * as CAN_MSG from './can_constants.js'
import console from 'console';

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
        return;
    });

    /* Dump the in-memory database to client */
    if (req.url === '/api/database') {
        fs.readFile('./can-node-database.json', (error, content) => {
            if (error) {
                res.writeHead(500);
                res.end('Error loading database');
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(content);
            }
        });
        return; // Exit early to prevent falling through to static file serving
    }
});

server.listen(HTTP_PORT, () => {
    console.log(`Web UI available at http://cancontrol:${HTTP_PORT}`);
});

// 2. WebSocket Server
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
    fs.readFile('./can-node-database.json', 'utf8', (err, data) => {
        if (!err && ws.readyState === 1) {
            /* Wrap database in a type-flagged object */
            ws.send(JSON.stringify({
                type: 'DATABASE_UPDATE',
                payload: JSON.parse(data)
            }));
        }
    });
});

// 3. CAN Bus Setup
const channel = can.createRawChannel("can0", true);

/* === Functions === */

function sendNodeDatabase() {
    /* Send the database via WS on request */
    fs.readFile('./can-node-database.json', 'utf8', (err, data) => {
        if (!err && wss.readyState === 1) {
            wss.send(JSON.stringify({
                type: 'DATABASE_UPDATE',
                payload: JSON.parse(data)
            }));
        }
    });
}
/**
 * Constructs an 8-byte CAN payload:
 * Bytes 0-3: Zeroed (Reserved/Padding)
 * Bytes 4-7: Unix Timestamp in Seconds (Big Endian)
 */
function getTimestampPayload() {
    const TOTAL_PAYLOAD_SIZE = 8; /* Standard CAN frames are limited to 8 bytes */
    const TIMESTAMP_OFFSET = 4;   /* Start writing timestamp at the 5th byte */
    const MS_PER_SECOND = 1000;    /* Factor to convert milliseconds to seconds */

    /**
     * Buffer.alloc initializes the buffer with zeros by default. 
     * This ensures bytes 0-3 are [0x00, 0x00, 0x00, 0x00].
     */
    const finalBuffer = Buffer.alloc(TOTAL_PAYLOAD_SIZE);

    // Calculate Unix seconds
    const unixSeconds = Math.floor(Date.now() / MS_PER_SECOND);

    // Write to the last 4 bytes (offset 4) in Big Endian
    finalBuffer.writeUInt32BE(unixSeconds, TIMESTAMP_OFFSET);

    return finalBuffer;
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

function getNodeId(msg) {
    if (msg.data.length < NODE_ID_BYTE_LENGTH) {
        msg.payload
        return myNodeId; /* something wrong with the message data, return my Node ID */
    } 
    const nodeId = new Uint8Array([msg.data[0], msg.data[1], msg.data[2], msg.data[3]]);
    // console.log(nodeId);
    return nodeId;
}

function getMsgId(msg) {
    if (msg.id >= 0x100 && msg.in <= 0x7FF) {
        /* return a valid message ID */
        return msg.id;
    }

    return null; /* invalid message ID */
    
}

function sendRequestIntro() {
    writeCanMessageBE(CAN_MSG.REQ_NODE_INTRO_ID, myNodeId);
    lastReqIntro = Date.now();
}

function handlePeroidicMessages() {
    if (Date.now() - lastReqIntro > maxReqIntro) {
        sendRequestIntro();
    }

    if (Date.now() - lastTsMsg > sendTsInterval) {
        writeCanMessageBE(CAN_MSG.DATA_EPOCH_ID, getTimestampPayload());
        lastTsMsg = Date.now();
    }
}

function sendAckMsg(msg) {
    const messageId = getMsgId(msg);

    /* Ensure the message has enough data to extract a Node ID, and that we received an intro message */
    if ((msg.data.length < NODE_ID_BYTE_LENGTH) && !(messageId >= 0x700 && messageId <= 0x7FF)) {
        return;
    }

    const nodeId = getNodeId(msg);

    writeCanMessageBE(CAN_MSG.ACK_INTRO_ID, nodeId);

}

function toHexString(byteArray) {
  return Array.from(byteArray, function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/**
 * Unpacks bit-packed data from byte 7 of a CAN message
 * @param {number} byteValue - The raw byte (0-255) from msg.data[7]
 */
function unpackByteSeven(byteValue) {
    // 0x0F (binary 00001111) masks the lower 4 bits to get the DLC
    const dlc = byteValue & 0x0F; 

    // We check if the bit corresponding to SUBMOD_PART_B_FLAG is set.
    // Assuming SUBMOD_PART_B_FLAG is 0x80 (10000000) or 0x10 (00010000).
    const PART_B_FLAG_MASK = SUBMOD_PARTB_OFFSET; /* Adjust this to match your C++ SUBMOD_PART_B_FLAG value */
    const saveState = (byteValue & PART_B_FLAG_MASK) !== 0;

    return { dlc, saveState };
}

/**
 * Store and organize network modules by Node Type (identifer 0x780-0x7FF)
 * Keep track of the last seen time for each node, as well as associated
 * sub-modules (identifer 0x700-0x77F). Store the sub-module configuration
 * as well as the last seen time.
 */
function updateNodeDatabase(msg) {
    if (msg.data.length < NODE_ID_BYTE_LENGTH) {
        return;
    }
    
    const messageId = msg.id;
    const nodeId    = getNodeId(msg);
    const nodeString = toHexString(nodeId);
    // console.log("Received message from node: ", nodeString, "0x" + messageId.toString(16).toUpperCase());

    if (messageId >= INTRO_MSG_BEGIN && messageId <= INTRO_MSG_END) {

        if (!canDatabase[nodeId]) {
            console.log("Creating new record for node:", nodeString);
            canDatabase[nodeId] = {
                subModule: {} /* Create entry and sub-module array if it doesn't exist */
            };
        } else {
            // console.log("Updating information for node:", nodeString);
        }
        
        const myNode           = canDatabase[nodeId];

        if (!myNode.firstSeen) {
            /* only store firstSeen once, no updates */
            myNode.firstSeen     = Date.now();
            myNode.lastSubModIdx = 0;
        }

        myNode.nodeId          = nodeString;
        myNode.lastSeen        = Date.now(); /**< Update last seen time */
        myNode.nodeTypeMsg     = messageId;
        myNode.nodeTypeDlc     = INTRO_MSG_DLC;
        myNode.subModCnt       = msg.data[SUBMODCNT_OFFSET];


        if (myNode.lastSubModIdx >= (myNode.subModCnt - 1)) { /* sub module count is 0-indexed */
            /** Mark this interview as complete */
            myNode.introComplete = true;
            // console.log("Node:", nodeString, "interview complete, not sending ack");
        } else {
            console.log("Node:", nodeString, "Sub-module count:", myNode.subModCnt);
            sendAckMsg(msg); /**< Acknowledge the intro message */
        }

    } else if (messageId >= SUBMOD_INTRO_BEGIN && messageId <= SUBMOD_INTRO_END) {
        /**
        * Sub-modules are identified by the first 4 bytes of the payload
        * being the same as the Node ID of the parent module. They have many
        * of the same properties as a network module, but are identified
        * by a different message ID. They always have 24-bits of configuration data,
        * at offset 5, 6 and 7. Offset 4 is the sub-module ID. Each parent Node
        * has a maximum of 8 sub-modules.
        */

        /** Ensure the parent node exists before trying to add sub-modules */
        if (!canDatabase[nodeId]) return;

        let subModIdx   = msg.data[SUBMODID_OFFSET];
        const workingIdx = (subModIdx & SUBMOD_PARTB_MASK); /* Get sub-module index */
        const messageStr = "0x" + messageId.toString(16).toUpperCase();

        try {/** Exit if sub-module interview is already complete */
            if (canDatabase[nodeId].subModule[workingIdx].partAComplete && canDatabase[nodeId].subModule[workingIdx].partBComplete) {
                console.log("Node", nodeString, "sub-module already interviewed:", workingIdx);
                return;
            }} catch (error) {
                console.log("Node", nodeString, "interviewing new sub-module:", workingIdx, "module type:", messageStr);
            }

        let subModPartB = false; /* Two-part introduction process */

        if (subModIdx  >= SUBMOD_PARTB_OFFSET) {
            subModPartB = true;
            subModIdx   = workingIdx; /* Subtract offset to get sub-module index */
        }

        if (subModIdx  >= NODE_MAX_SUBMODS) { /* invalid sub-module index */
            return;
        }

        /* Initialize sub-module entry and rawConfig array if missing */
        if (!canDatabase[nodeId].subModule[subModIdx]) {
             canDatabase[nodeId].subModule[subModIdx] = {
                rawConfig: new Array(3).fill(0) /* Pre-allocate for 3 config bytes */
            };
        }
        
        const targetSub = canDatabase[nodeId].subModule[subModIdx];
        
        targetSub.subModIdx          = subModIdx;
        targetSub.lastSeen           = Date.now();
        targetSub.introMsgId         = messageId;
        targetSub.introMsgDlc        = INTRO_MSG_DLC;

        if (!subModPartB) {          /* First introduction phase */
            targetSub.rawConfig[0]   = msg.data[SUBMOD_RAW0_OFFSET];
            targetSub.rawConfig[1]   = msg.data[SUBMOD_RAW1_OFFSET];
            targetSub.rawConfig[2]   = msg.data[SUBMOD_RAW2_OFFSET];
            targetSub.partAComplete  = true;
            // console.log("Node", nodeString, "sub-module", subModIdx, "part A complete");
        } else {                     /* Second introduction phase */
            /* Bitwise assembly for 16-bit Big Endian Data Message ID */
            targetSub.dataMsgId      = (msg.data[SUBMOD_DATAMSGID_MSB_OFFSET] << 8) | 
                                       (msg.data[SUBMOD_DATAMSGID_LSB_OFFSET] & 0xFF);
            
            const byteSeven          = msg.data[SUBMOD_DATAMSGDLC_OFFSET];
            const { dlc, saveState } = unpackByteSeven(byteSeven);
            
            targetSub.dataMsgDlc     = dlc;
            targetSub.saveState      = saveState;            
            targetSub.partBComplete  = true;
            // console.log("Node", nodeString, "sub-module", subModIdx, "part B complete");
        }
        
        if (targetSub.partAComplete && targetSub.partBComplete) {
            /* store index last sub-module introduced for this node */
            canDatabase[nodeId].lastSubModIdx = subModIdx; 
            console.log("Node", nodeString, "sub-module", subModIdx, "interview complete");
        } 
        sendAckMsg(msg); /**< Acknowledge the sub-module intro message */
    }
}


/* === Listeners === */

/* CAN Message Listener */
channel.addListener("onMessage", (msg) => {

    /* Update the in-memory database */
    updateNodeDatabase(msg);

    /* Send "request intro" and timestamp messages periodically */
    handlePeroidicMessages();

    /* Broadcast to WebSockets as before */
    const payload = JSON.stringify({
        type: 'CAN_MESSAGE', // Added type to distinguish from database
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