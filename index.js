import can from 'socketcan';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

import * as CAN_MSG from './can_constants.js';
import console from 'console';
import Database from 'better-sqlite3';

/* === Constants === */

/** Standard port for web traffic */
const HTTP_PORT = 3000;

/** Port for CAN data stream */
const WS_PORT = 8080;

/** Standard CAN frame data length */
const CAN_STD_DLC = 8;

/** First CAN Arbitration ID used in this project */
const CAN_FIRST_MSG = 0x100;

/** Last CAN Arbitration ID used in this project */
const CAN_LAST_MSG = 0x7FF;

/** Four byte Node ID for the master */
const myNodeId = [0x19, 0x00, 0x00, 0x19];

/** Offset of Node ID in CAN messages */
const NODE_ID_OFFSET = 0;

/** Offset of timestamp payload in intro messages */
const TS_PAYLOAD_OFFSET = 4;

/** Number of bytes in a Node ID */
const NODE_ID_BYTE_LENGTH = 4;

/** Data length for intro messages */
const INTRO_MSG_DLC = 8;

/** Offset of sub-module count in intro messages */
const SUBMODCNT_OFFSET = 4;

/** Offset of node configuration CRC in intro messages */
const CONFIGCRC_OFFSET = 5;

/** Beginning of module (node) intro messages */
const INTRO_MSG_BEGIN = 0x780;

/** End of module (node) intro messages */
const INTRO_MSG_END = 0x7FF;

/** Beginning of sub-module intro messages */
const SUBMOD_INTRO_BEGIN = 0x700;

/** End of sub-module intro messages */
const SUBMOD_INTRO_END = 0x77F;

/** Offset of sub-module ID in intro messages */
const SUBMODID_OFFSET = 4;

/** Maximum number of sub-modules per node */
const NODE_MAX_SUBMODS = 8;

/** Offset of sub-module part B in intro messages */
const SUBMOD_PARTB_OFFSET = 0x80;

/** Mask for sub-module part B in intro messages */
const SUBMOD_PARTB_MASK = 0x7F;

/** First of three raw config bytes for sub-module */
const SUBMOD_RAW0_OFFSET = 5;

/** Second of three raw config bytes for sub-module */
const SUBMOD_RAW1_OFFSET = 6;

/** Third of three raw config bytes for sub-module */
const SUBMOD_RAW2_OFFSET = 7;

/** Number of raw config bytes */
const SUBMOD_RAW_CFG_BYTES = 3;

/** Offset of data message ID MSB in intro messages */
const SUBMOD_DATAMSGID_MSB_OFFSET = 5;

/** Offset of data message ID LSB in intro messages */
const SUBMOD_DATAMSGID_LSB_OFFSET = 6;

/** Offset of data message DLC in intro messages */
const SUBMOD_DATAMSGDLC_OFFSET = 7;

/** Check every 30 seconds for socket liveness */
const HEARTBEAT_INTERVAL = 30000;

/** Factor to convert milliseconds to seconds */
const MS_PER_SECOND = 1000;

/** Bit shift for byte operations */
const SHIFT_BYTE = 8;

/** Mask for byte operations */
const BYTE_MASK = 0xFF;

/** Mask for the lower 4 bits to extract DLC */
const CAN_DLC_MASK = 0x0F;

/** Length for hex string padding */
const HEX_PAD_LENGTH = 2;

/** Maximum interval between "request intro" messages (30 minutes) */
const maxReqIntro = 1800000;

/** Milliseconds between sending timestamp messages */
const sendTsInterval = 10000;

/* === State and Initialization === */

/** In-memory database for CAN messages */
const canDatabase = {};

/** Timestamp of last "request intro" message */
let lastReqIntro = 0;

/** Timestamp of last "timestamp" message */
let lastTsMsg = 0;

/** SQLite database for tracking CAN modules and messages */
const db = new Database('can_management.db');

/** WebSocket Server */
const wss = new WebSocketServer({ port: WS_PORT });

/** CAN Bus Setup */
const channel = can.createRawChannel("can0", true);

/* === Setup === */

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('Terminating inactive connection');
            return ws.terminate();
        }
        ws.isAlive = false; /**< Mark as potentially dead; reset on pong */
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

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
});

server.listen(HTTP_PORT, () => {
    console.log(`Web UI available at http://cancontrol:${HTTP_PORT}`);
});

wss.on('connection', (ws) => {
    /** Set initial liveness for the heartbeat cleanup logic */
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    
    /** * Verify the socket is open before sending. 
     * WebSocket.OPEN (value 1) ensures the connection is ready.
     */
    if (ws.readyState === ws.OPEN) { 
        console.log('Client connected, sending live in-memory node database...');
        ws.send(JSON.stringify({
            type: 'DATABASE_UPDATE',
            payload: canDatabase /* Reference to the live in-memory object */
        }));
    }

   ws.on('message', (message) => {
        try {
            const request = JSON.parse(message);

            switch (request.type) {
                case 'UPDATE_NODE_CONFIG':
                    handleNodeConfigUpdate(ws, request);
                    break;
                
                /* Add other message types here as needed */
                default:
                    console.warn(`Unknown message type: ${request.type}`);
            }
        } catch (err) {
            console.error('Failed to parse WebSocket message:', err);
        }
    });
});

wss.on('close', () => clearInterval(interval));

/** * Database setup
 * Initialize SQLite tables. 
 * 'better-sqlite3' executes these synchronously on startup.
 */
db.exec(`
    CREATE TABLE IF NOT EXISTS node_inventory (
        node_id TEXT PRIMARY KEY,
        node_type_msg INTEGER,
        sub_mod_cnt INTEGER,
        config_crc INTEGER,
        first_seen INTEGER,
        last_seen INTEGER,
        is_active INTEGER DEFAULT 1,
        full_data TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        node_id TEXT,
        sub_idx INTEGER,
        field TEXT,
        old_value TEXT,
        new_value TEXT
    );

    CREATE TABLE IF NOT EXISTS node_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT,
            node_type_msg INTEGER,
            sub_mod_cnt INTEGER,
            config_crc INTEGER,
            recorded_at INTEGER, /**< Timestamp in ms (Date.now()) */
            full_data TEXT       /**< Snapshot of all sub-modules at this time */
        );
`);

/** * Prepare statements once for better performance */
const insertInventory = db.prepare(`
    INSERT INTO node_inventory (node_id, node_type_msg, sub_mod_cnt, config_crc, first_seen, last_seen, is_active, full_data)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(node_id) DO UPDATE SET 
        node_type_msg = excluded.node_type_msg,
        sub_mod_cnt   = excluded.sub_mod_cnt,
        config_crc    = excluded.config_crc,
        last_seen     = excluded.last_seen,
        is_active     = 1,
        full_data     = excluded.full_data
`);

const insertAudit = db.prepare(`
    INSERT INTO audit_log (node_id, sub_idx, field, old_value, new_value) 
    VALUES (?, ?, ?, ?, ?)
`);

/** * Prepared statement for snapshots */
const insertHistorySnapshot = db.prepare(`
    INSERT INTO node_history (node_id, node_type_msg, sub_mod_cnt, config_crc, recorded_at, full_data)
    VALUES (?, ?, ?, ?, ?, ?)
`);

/* === Functions === */


/**
 * Updates current inventory and archives a snapshot if data has changed.
 * @param {string} nodeId - Target node.
 * @param {Object} nodeData - The updated node object.
 */
function recordNodeSnapshot(nodeId, nodeData) {
    /* 1. Update the 'Current State' in node_inventory */
    syncNodeToDatabase(nodeId, nodeData);

    /* 2. Archive the snapshot in node_history */
    insertHistorySnapshot.run(
        nodeId,
        nodeData.nodeTypeMsg,
        nodeData.subModCnt,
        nodeData.configCrc,
        Date.now(),
        JSON.stringify(nodeData.subModule)
    );
}

/**
 * Synchronizes the in-memory state to SQLite.
 */
function syncNodeToDatabase(nodeId, nodeData) {
    insertInventory.run(
        nodeId,
        nodeData.nodeTypeMsg,
        nodeData.subModCnt,
        nodeData.configCrc,
        nodeData.firstSeen,
        nodeData.lastSeen,
        JSON.stringify(nodeData.subModule)
    );
}

/**
 * Logs a manual configuration change.
 */
function logManualChange(nodeId, subIdx, field, oldVal, newVal) {
    insertAudit.run(
        nodeId, 
        subIdx, 
        field, 
        JSON.stringify(oldVal), 
        JSON.stringify(newVal)
    );
}

/**
 * Retrieves the history of a specific sub-module.
 */
function getSubModuleHistory(nodeId, subIdx) {
    const snapshots = db.prepare("SELECT recorded_at, full_data " +
                                 "FROM node_history " +
                                 "WHERE node_id = ? ORDER BY recorded_at DESC").all(nodeId);
    
    return snapshots.map(s => {
        const subModules = JSON.parse(s.full_data);
        return {
            time: new Date(s.recorded_at).toLocaleString(),
            config: subModules[subIdx]
        };
    });
}

/**
 * Processes configuration updates, sends CAN messages, and archives snapshots in SQLite.
 * @param {WebSocket} ws - The specific client connection to respond to.
 * @param {Object} data - The payload containing nodeId, subModIdx, etc.
 */
function handleNodeConfigUpdate(ws, data) {
    const { nodeId, subModIdx, dataMsgId, rawConfig, dataMsgDlc } = data;

    const nodeData = canDatabase[nodeId]; 
    if (nodeData === undefined) {
    console.error(`Update failed: Node ${nodeId} not found.`);
    return;
}
    const targetSub = nodeData.subModule[subModIdx];
    let hasChanged = false;

    /** * 1. Handle DataMsgId or DLC changes
     */
    if (targetSub.dataMsgId !== dataMsgId || targetSub.dataMsgDlc !== dataMsgDlc) {
        /* Log change to audit trail */
        if (targetSub.dataMsgId !== dataMsgId) {
            logManualChange(nodeId, subModIdx, 'dataMsgId', targetSub.dataMsgId, dataMsgId);
        }
        if (targetSub.dataMsgDlc !== dataMsgDlc) {
            logManualChange(nodeId, subModIdx, 'dataMsgDlc', targetSub.dataMsgDlc, dataMsgDlc);
        }

        const canPayload = Buffer.alloc(CAN_MSG.CFG_SUB_DATA_MSG_DLC);
        Buffer.from(nodeId, 'hex').copy(canPayload, NODE_ID_OFFSET); 
        canPayload.writeUInt8(subModIdx, SUBMODID_OFFSET);      
        canPayload.writeUInt16BE(dataMsgId, SUBMOD_DATAMSGID_MSB_OFFSET);   
        canPayload.writeUInt8(dataMsgDlc, SUBMOD_DATAMSGDLC_OFFSET);     

        channel.send({ id: CAN_MSG.CFG_SUB_DATA_MSG_ID, data: canPayload });
        
        targetSub.dataMsgId  = dataMsgId;
        targetSub.dataMsgDlc = dataMsgDlc;
        hasChanged = true;
    }

    /** * 2. Handle Raw Config changes 
     */
    if (JSON.stringify(targetSub.rawConfig) !== JSON.stringify(rawConfig)) {
        logManualChange(nodeId, subModIdx, 'rawConfig', targetSub.rawConfig, rawConfig);
        
        const canPayload = Buffer.alloc(CAN_MSG.CFG_SUB_RAW_DATA_DLC);
        Buffer.from(nodeId, 'hex').copy(canPayload, NODE_ID_OFFSET); 
        canPayload.writeUInt8(subModIdx, SUBMODID_OFFSET);

        /* Copy the array of bytes directly into the buffer */
        Buffer.from(rawConfig).copy(canPayload, SUBMOD_RAW0_OFFSET);
        
        channel.send({ id: CAN_MSG.CFG_SUB_RAW_DATA_ID, data: canPayload });
        
        targetSub.rawConfig = rawConfig;
        hasChanged = true;
    }

    /** * 3. Atomic Database Sync and History Snapshot
     */
    if (hasChanged) {
        nodeData.lastSeen = Date.now(); 

        try {
            /* Execute inventory update and history snapshot in a single synchronous transaction */
            const updateTransaction = db.transaction((id, info) => {
                // This updates the 'current' row
                syncNodeToDatabase(id, info); 
                // This inserts the 'historical' row
                insertHistorySnapshot.run(
                    id, info.nodeTypeMsg, info.subModCnt, info.config_crc, Date.now(), JSON.stringify(info.subModule)
                );
            });

            updateTransaction(nodeId, nodeData);

            ws.send(JSON.stringify({
                type: 'UPDATE_ACK',
                nodeId: nodeId,
                subModIdx: subModIdx,
                success: true
            }));
            
            console.log(`Node ${nodeId} updated, archived, and ACK sent.`);
        } catch (dbErr) {
            console.error(`Database transaction failed for ${nodeId}:`, dbErr);
        }
    }
}

/**
 * Constructs an 8-byte CAN payload:
 * Bytes 0-3: Zeroed (Reserved/Padding)
 * Bytes 4-7: Unix Timestamp in Seconds (Big Endian)
 */
function getTimestampPayload() {
    const finalBuffer = Buffer.alloc(CAN_STD_DLC);
    const unixSeconds = Math.floor(Date.now() / MS_PER_SECOND);

    // Write to the last 4 bytes (offset 4) in Big Endian
    finalBuffer.writeUInt32BE(unixSeconds, TS_PAYLOAD_OFFSET);

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
        if (index < CAN_STD_DLC) {
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
    return nodeId;
}

function getMsgId(msg) {
    if (msg.id >= CAN_FIRST_MSG && msg.in <= CAN_LAST_MSG) return msg.id;
    
    return null; /* invalid message ID */
}

function sendRequestIntro() {
    writeCanMessageBE(CAN_MSG.REQ_NODE_INTRO_ID, myNodeId);
    lastReqIntro = Date.now();
}

function handlePeroidicMessages() {
    if (Date.now() - lastReqIntro > maxReqIntro) {
        // saveDatabaseToFile(); /* write database to disk */
        sendRequestIntro(); /* initiate network scan */
    }

    if (Date.now() - lastTsMsg > sendTsInterval) {
        writeCanMessageBE(CAN_MSG.DATA_EPOCH_ID, getTimestampPayload());
        lastTsMsg = Date.now();
    }
}

function sendAckMsg(msg) {
    const messageId = getMsgId(msg);

    /* Ensure the message has enough data to extract a Node ID, and that we received an intro message */
    if ((msg.data.length < NODE_ID_BYTE_LENGTH) && !(messageId >= SUBMOD_INTRO_BEGIN && messageId <= INTRO_MSG_END)) {
        return;
    }

    const nodeId = getNodeId(msg);

    writeCanMessageBE(CAN_MSG.ACK_INTRO_ID, nodeId);
}

/**
 * Converts a byte array to a hexadecimal string.
 * @param {Uint8Array} byteArray - The byte array to be converted.
 * @returns {string} A hexadecimal string representation of the input byte array.
 */
function toHexString(byteArray) {
    return Array.from(byteArray)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Unpacks bit-packed data from byte 7 of a CAN message
 * @param {number} byteValue - The raw byte (0-255) from msg.data[7]
 */
function unpackByteSeven(byteValue) {
    // 0x0F (binary 00001111) masks the lower 4 bits to get the DLC
    const dlc = byteValue & CAN_DLC_MASK; 

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
    
    const messageId  = msg.id;
    const nodeId     = getNodeId(msg);
    const nodeString = toHexString(nodeId);
    // console.log("Received message from node: ", nodeString, "0x" + messageId.toString(16).toUpperCase());

    if (messageId >= INTRO_MSG_BEGIN && messageId <= INTRO_MSG_END) {

        /* Check if this is a known node */
        const isKnownNode = nodeString in canDatabase;

        if (!isKnownNode) {
            console.log("Creating new record for node:", nodeString);
            /** create new node in the in-memory database */
            canDatabase[nodeString] = { 
                                        subModule:     {}, /* empty sub-module array */
                                        lastSubModIdx: 0   /* start with index 0 */
                                      };
        }
        
        const myNode = canDatabase[nodeString];
        
        /* Capture the new CRC from the bus */
        const incomingCrc = ((msg.data[CONFIGCRC_OFFSET] << SHIFT_BYTE) |
                            (msg.data[CONFIGCRC_OFFSET + 1] & BYTE_MASK));

        /** * CRC Change Detection Logic
         * If we know this node and the CRC is different, archive the state.
         */
        const crcChanged = isKnownNode && myNode.configCrc !== undefined && myNode.configCrc !== incomingCrc;

        if (crcChanged) {
            console.warn(`CRC mismatch detected for node ${nodeString}: 0x${myNode.configCrc.toString(16)} -> 0x${incomingCrc.toString(16)}`);
            /* Snapshot the current (old) state before we overwrite it with the new CRC data */
            recordNodeSnapshot(nodeString, myNode);
        }
        

        /* Update memory with the latest bus data */
        myNode.nodeId          = nodeString;
        myNode.lastSeen        = Date.now(); 
        myNode.nodeTypeMsg     = messageId;
        myNode.nodeTypeDlc     = INTRO_MSG_DLC;
        myNode.subModCnt       = msg.data[SUBMODCNT_OFFSET];
        myNode.configCrc       = incomingCrc;

        /** If this is the first time we've seen this nodeID record first-seen time */
        if (!myNode.firstSeen) myNode.firstSeen = Date.now();

        if (myNode.lastSubModIdx >= (myNode.subModCnt - 1)) { /* sub module count is 0-indexed */
            /** Mark this interview as complete */
            myNode.introComplete = true;

            /** Sync the in-memory state to SQLite */
            syncNodeToDatabase(nodeString, myNode);
            // console.log("Node:", nodeString, "interview complete, not sending ack");
        } else {
            console.log("Node:", nodeString, "Sub-module count:", myNode.subModCnt, "CRC: ", myNode.configCrc);
            /** Acknowledge the intro message */
            sendAckMsg(msg); 
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
        if (!canDatabase[nodeString]) return;

        let subModIdx   = msg.data[SUBMODID_OFFSET];
        const workingIdx = (subModIdx & SUBMOD_PARTB_MASK); /* Get sub-module index */
        const messageStr = "0x" + messageId.toString(16).toUpperCase();

        try {/** Exit if sub-module interview is already complete */
            if (canDatabase[nodeString].subModule[workingIdx].partAComplete && canDatabase[nodeString].subModule[workingIdx].partBComplete) {
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
        if (!canDatabase[nodeString].subModule[subModIdx]) {
             canDatabase[nodeString].subModule[subModIdx] = {
                rawConfig: new Array(SUBMOD_RAW_CFG_BYTES).fill(0) /* Pre-allocate for 3 config bytes */
            };
        }
        
        const targetSub = canDatabase[nodeString].subModule[subModIdx];
        
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
            targetSub.dataMsgId      = (msg.data[SUBMOD_DATAMSGID_MSB_OFFSET] << SHIFT_BYTE) | 
                                       (msg.data[SUBMOD_DATAMSGID_LSB_OFFSET] & BYTE_MASK);
            
            const byteSeven          = msg.data[SUBMOD_DATAMSGDLC_OFFSET];
            const { dlc, saveState } = unpackByteSeven(byteSeven);
            
            targetSub.dataMsgDlc     = dlc;
            targetSub.saveState      = saveState;            
            targetSub.partBComplete  = true;
            // console.log("Node", nodeString, "sub-module", subModIdx, "part B complete");
        }
        
        if (targetSub.partAComplete && targetSub.partBComplete) {
            /* store index last sub-module introduced for this node */
            canDatabase[nodeString].lastSubModIdx = subModIdx; 

            /* Sync node to database */
            syncNodeToDatabase(nodeString, canDatabase[nodeString]);

            // console.log("Node", nodeString, "sub-module", subModIdx, "interview complete");
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

    for (const client of wss.clients) {
        const isSocketOpen = (client.readyState === 1); /* 1 is WebSocket.OPEN */
        if (isSocketOpen) {
            client.send(payload);
        }
    }
});

/* Start the CAN channel */
channel.start();