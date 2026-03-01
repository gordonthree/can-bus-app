import can from 'socketcan';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

import * as CAN_MSG from './can_constants.js';
import console from 'console';
import Database from 'better-sqlite3';


/* === Constants === */

/* === CSV Import Constants === */

/** Number of rows to skip (5 spacer lines + 1 header line) */
const CSV_HEADER_OFFSET = 6;

/** Minimum number of columns required for a valid message definition row */
const CSV_MIN_COLUMN_COUNT = 16;

/** Column index for the Message Category (e.g., 'canerr') */
const CSV_COL_CATEGORY = 1;

/** Column index for the Hexadecimal Message ID (e.g., '0x100') */
const CSV_COL_ID_HEX = 3;

/** Column index for the Data Length Code (DLC) */
const CSV_COL_DLC = 4;

/** Column index for the human-readable constant name (c def) */
const CSV_COL_NAME = 14;

/** Column index for the detailed message description (Comments) */
const CSV_COL_DESCRIPTION = 15;

/** Base 16 for hexadecimal string parsing */
const HEX_BASE = 16;

/** Default CAN Data Length Code if column is empty or invalid */
const DEFAULT_DLC = 8;

/** Memory cache for high-speed message name lookups */
const messageLookup = new Map();

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
        /** 1. Send Message Definitions first so UI can map names */
        ws.send(JSON.stringify({
            type: 'DEFINITIONS_LIST',
            payload: selectAllDefinitions.all()
        }));
        
        ws.send(JSON.stringify({
            type: 'DATABASE_UPDATE',
            payload: canDatabase /* Reference to the live in-memory object */
        }));
    
        broadcastAuditLog();
    }

   ws.on('message', (message) => {
        try {
            const request = JSON.parse(message);

            switch (request.type) {
                case 'UPDATE_NODE_CONFIG':
                    handleNodeConfigUpdate(ws, request);
                    break;
                
                case 'SAVE_AUDIT_COMMENT':
                    upsertComment.run(request.auditId, request.comment, Date.now());
                    broadcastAuditLog(); /**< Refresh all clients with the new comment */
                    break;
                /* Add other message types here as needed */
                case 'GET_DEFINITIONS':
                    ws.send(JSON.stringify({
                        type: 'DEFINITIONS_LIST',
                        payload: selectAllDefinitions.all()
                    }));
                    break;
                case 'REQUEST_NODE_INTERVIEW':
                    if (request.nodeId) {
                        const nodeString = request.nodeId;
                        
                        /** * Documentation-First Cleanup:
                         * Reset the in-memory state so the engine re-ingests all frames.
                         */
                        if (canDatabase[nodeString]) {
                            console.log(`Resetting inventory for ${nodeString} before re-interview...`);
                            
                            /** Clear sub-modules and reset tracking indices */
                            canDatabase[nodeString].subModule     = {};
                            canDatabase[nodeString].lastSubModIdx = 0;
                            canDatabase[nodeString].introComplete = false;
                        }

                        /** Broadcast the cleared state to all clients so the UI updates immediately */
                        broadcastDatabase();

                        /** Construct and send the CAN command */
                        const targetNodeId = hexStringToByteArray(nodeString);
                        writeCanMessageBE(CAN_MSG.REQ_NODE_INTRO_ID, targetNodeId);
                        
                        console.log(`Sent REQ_NODE_INTRO (0x401) to node: ${nodeString}`);
                    }
                    break;
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

    CREATE TABLE IF NOT EXISTS config_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id INTEGER UNIQUE,
        comment_text TEXT,
        updated_at INTEGER,
        FOREIGN KEY(audit_id) REFERENCES audit_log(id)
    );

    CREATE TABLE IF NOT EXISTS message_definitions (
        id_dec INTEGER PRIMARY KEY,
        id_hex TEXT,
        name TEXT,
        dlc INTEGER,
        category TEXT,
        description TEXT
    );
`);

/** Fetch 20 most recent audits joined with their comments */
const selectRecentAudit = db.prepare(`
    SELECT a.id, a.timestamp, a.node_id, a.sub_idx, a.field, a.old_value, a.new_value, c.comment_text 
    FROM audit_log a 
    LEFT JOIN config_comments c ON a.id = c.audit_id 
    ORDER BY a.timestamp DESC 
    LIMIT 20
`);

/** Upsert a comment for a specific audit entry */
const upsertComment = db.prepare(`
    INSERT INTO config_comments (audit_id, comment_text, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(audit_id) DO UPDATE SET
        comment_text = excluded.comment_text,
        updated_at = excluded.updated_at
`);

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

/** Fetch all definitions for the UI dropdowns */
const selectAllDefinitions = db.prepare(`
    SELECT id_dec, id_hex, name, category, description 
    FROM message_definitions 
    ORDER BY id_dec ASC
`);

/** * Prepared statement for snapshots */
const insertHistorySnapshot = db.prepare(`
    INSERT INTO node_history (node_id, node_type_msg, sub_mod_cnt, config_crc, recorded_at, full_data)
    VALUES (?, ?, ?, ?, ?, ?)
`);

/* === Functions === */

/**
 * Broadcasts the current in-memory CAN database to all connected clients.
 * This is used to refresh the UI when a node is added, updated, or reset.
 */
function broadcastDatabase() {
    const payload = JSON.stringify({
        type: 'DATABASE_UPDATE',
        payload: canDatabase
    });

    for (const client of wss.clients) {
        /** 1 is WebSocket.OPEN */
        const isSocketOpen = (client.readyState === 1); 
        if (isSocketOpen) {
            client.send(payload);
        }
    }
}

/**
 * Imports message definitions from the Google Sheets CSV.
 * Handles the multi-line header and specific column mapping of the source file.
 * @param {string} filePath - Path to the source CSV file.
 */
function importMessageDefinitions(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split(/\r?\n/);
        
        /** Skip the metadata and header rows to reach raw data */
        const dataLines = lines.slice(CSV_HEADER_OFFSET);

        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO message_definitions (id_dec, id_hex, name, dlc, category, description)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        db.transaction(() => {
            for (const line of dataLines) {
                const cols = line.split(',');

                /** Verify the row has sufficient columns and a valid Hex ID prefix */
                const isValidRow = cols.length >= CSV_MIN_COLUMN_COUNT && 
                                   cols[CSV_COL_ID_HEX] && 
                                   cols[CSV_COL_ID_HEX].startsWith('0x');

                if (isValidRow) {
                    const idHex    = cols[CSV_COL_ID_HEX].trim();
                    const idDec    = parseInt(idHex, HEX_BASE);
                    const name     = cols[CSV_COL_NAME].trim();
                    const dlc      = parseInt(cols[CSV_COL_DLC]) || DEFAULT_DLC;
                    const category = cols[CSV_COL_CATEGORY].trim();
                    const desc     = cols[CSV_COL_DESCRIPTION].trim();

                    if (!isNaN(idDec)) {
                        insertStmt.run(idDec, idHex, name, dlc, category, desc);
                        
                        /** Update memory cache for O(1) lookup during live CAN feed */
                        messageLookup.set(idDec, name);
                    }
                }
            }
        })();

        console.log(`Imported ${messageLookup.size} message definitions from CSV.`);
    } catch (err) {
        console.error("Failed to import message definitions:", err.message);
    }
}

/**
 * Broadcasts the 20 most recent audit logs to all connected clients.
 */
function broadcastAuditLog() {
    const logs = selectRecentAudit.all();
    const payload = JSON.stringify({
        type: 'AUDIT_LOG_UPDATE',
        payload: logs
    });

    for (const client of wss.clients) {
        if (client.readyState === client.OPEN) {
            client.send(payload);
        }
    }
}

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
 * Processes an incoming configuration update from the client editor.
 * Compares incoming data with in-memory data to prevent redundant updates.
 * @param {Object} msg - The parsed WebSocket message object.
 */
function handleNodeConfigUpdate(msg) {
    const { nodeId, configTarget, subModIdx, payload } = msg;

    // Assuming your in-memory database is called `nodeDatabase`
    if (!nodeDatabase[nodeId]) {
        console.warn(`[Config Update] Node ${nodeId} not found in database.`);
        return;
    }

    let hasChanges = false;
    const targetNode = nodeDatabase[nodeId];

    if (configTarget === 'PARENT') {
        // Compare parent fields
        if (targetNode.nodeTypeMsg !== payload.nodeTypeMsg ||
            targetNode.nodeTypeDlc !== payload.nodeTypeDlc ||
            targetNode.subModCnt !== payload.subModCnt) {
            
            // Apply updates
            targetNode.nodeTypeMsg = payload.nodeTypeMsg;
            targetNode.nodeTypeDlc = payload.nodeTypeDlc;
            targetNode.subModCnt = payload.subModCnt;
            
            hasChanges = true;
        }
        
    } else if (configTarget === 'SUBMODULE') {
        // Ensure subModule object exists
        if (!targetNode.subModule) {
            targetNode.subModule = {};
        }
        if (!targetNode.subModule[subModIdx]) {
            targetNode.subModule[subModIdx] = {}; // Initialize if brand new
            hasChanges = true; 
        }

        const targetSub = targetNode.subModule[subModIdx];

        // Compare standard sub-module fields
        if (targetSub.introMsgId !== payload.introMsgId ||
            targetSub.dataMsgId !== payload.dataMsgId ||
            targetSub.dataMsgDlc !== payload.dataMsgDlc) {
            
            targetSub.introMsgId = payload.introMsgId;
            targetSub.dataMsgId = payload.dataMsgId;
            targetSub.dataMsgDlc = payload.dataMsgDlc;
            hasChanges = true;
        }

        // Deep compare the rawConfig array (3 bytes)
        if (!targetSub.rawConfig) targetSub.rawConfig = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            if (targetSub.rawConfig[i] !== payload.rawConfig[i]) {
                targetSub.rawConfig[i] = payload.rawConfig[i];
                hasChanges = true;
            }
        }
    }

    const hasChanged = hasChanges;

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

            /** Record the transaction in database */
            updateTransaction(nodeId, nodeData);

            /** Send updated log to connected WS clients */
            broadcastAuditLog();

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

/**
 * Synchronizes the in-memory database to the local JSON file.
 */
function saveDatabaseToFile() {
    fs.writeFile('./can-node-database.json', JSON.stringify(canDatabase, null, 4), (err) => {
        if (err) {
            console.error('Failed to save database to disk:', err);
        } else {
            console.log('Database successfully persisted to disk.');
        }
    });
}

function handlePeroidicMessages() {
    if (Date.now() - lastReqIntro > maxReqIntro) {
        sendRequestIntro(); /* initiate network scan */
    }

    if (Date.now() - lastTsMsg > sendTsInterval) {
        writeCanMessageBE(CAN_MSG.DATA_EPOCH_ID, getTimestampPayload());
        // saveDatabaseToFile(); /* write database to disk */
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

/**
 * Converts a hex string into an array of bytes.
 * Used for preparing Node IDs for CAN transmission.
 * @param {string} hexString - The hex string (e.g., "19000019").
 * @returns {number[]} Array of byte values.
 */
function hexStringToByteArray(hexString) {
    const bytes = [];
    const HEX_STEP = 2; /**< Two characters per byte */
    
    for (let i = 0; i < hexString.length; i += HEX_STEP) {
        bytes.push(parseInt(hexString.substr(i, HEX_STEP), 16));
    }
    return bytes;
}

/* === Listeners === */

/* CAN Message Listener */
channel.addListener("onMessage", (msg) => {

    /* Update the in-memory database */
    updateNodeDatabase(msg);

    /* Send "request intro" and timestamp messages periodically */
    handlePeroidicMessages();

    /** * Decorate the payload with the human-readable name 
     * sourced from the database lookup.
     */
    const payload = JSON.stringify({
        type: 'CAN_MESSAGE',
        id: msg.id,
        name: messageLookup.get(msg.id) || 'UNKNOWN',
        data: [...msg.data],
        timestamp: Date.now()
    });

    for (const client of wss.clients) {
        if (client.readyState === client.OPEN) {
            client.send(payload);
        }
    }
});

/** Start the CAN channel */
channel.start();

/** Initialize definitions on startup */
importMessageDefinitions('./can bus messages - Messages.csv');
