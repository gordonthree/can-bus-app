import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import can from 'socketcan';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

import * as CAN_MSG from './can_constants.js';
import console from 'console';
import Database from 'better-sqlite3';


/* === Constants === */

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

/** Beginning of module (node) intro messages 0x780 */
const INTRO_MSG_BEGIN = 0x780;

/** End of module (node) intro messages 0x7FF */
const INTRO_MSG_END = 0x7FF;

/** Beginning of sub-module intro messages 0x700 */
const SUBMOD_INTRO_BEGIN = 0x700;

/** End of sub-module intro messages 0x77F */
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

/** Create In-memory database for CAN messages */
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

// Needed for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Express app
const app = express();

// Middleware
app.use(express.json());

// Serve static files from your project root (or /public if you prefer)
app.use(express.static(path.join(__dirname)));

// ------------------------------------
// GET endpoints for seed UI
// ------------------------------------

// Get all fields
app.get('/api/seed/fields', (req, res) => {
    try {
        const rows = db.prepare(`SELECT * FROM fields ORDER BY field_id`).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all field options
app.get('/api/seed/field_options', (req, res) => {
    try {
        const rows = db.prepare(`SELECT * FROM field_options ORDER BY field_id,option_value`).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all personalities
app.get('/api/seed/personalities', (req, res) => {
    try {
        const rows = db.prepare(`SELECT * FROM personalities ORDER BY personality_id`).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all personality-field mappings
app.get('/api/seed/personality_fields', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT id, personality_id, field_index, field_id
            FROM personality_fields
            ORDER BY personality_id, field_index
        `).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ------------------------------------
// Start server
// ------------------------------------
// Wrap Express in an HTTP server
const server = http.createServer(app);

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


        // Send normalized metadata tables
        ws.send(JSON.stringify({
            type: 'DEFINITION_METADATA',
            payload: {
                personalities: selectAllPersonalities.all(),
                fields: selectAllFields.all(),
                personality_fields: selectAllPersonalityFields.all(),
                field_options: selectAllFieldOptions.all()
            }
        }));
        
    
        broadcastAuditLog();
    }

   ws.on('message', (message) => {
        try {
            /** JSON from the client */
            const request = JSON.parse(message);

            console.log(`Received JSON: ${JSON.stringify(request, null, 2)}`);

            const requestType = request.type;

            if (requestType === "UPDATE_NODE_CONFIG") {
                const configTarget = request.configTarget;

                switch (configTarget) {
                    case "PARENT_NODE_FIELD": {
                        
                        const { nodeId } = request; 
                        const { fieldId, value } = request.payload;

                        const node = canDatabase[nodeId];

                        console.log(`updating parent node ${nodeId} field ${fieldId} to ${value}`);

                        /** Update in-memory and sql database */
                        updateParentNodeField(nodeId, fieldId, value);

                        /** write changes to the bus */
                        dispatchParentNodeField(nodeId, fieldId, value);

                        break;
                    }

                    case "SUBMODULE_FIELD": {
                        const { nodeId } = request;
                        const { fieldId, value, subModIdx } = request.payload;
                        const sub = canDatabase[nodeId].subModule[subModIdx];

                        console.log(`updating node ${nodeId} submodule ${subModIdx} field ${fieldId} to ${value}`);

                        /** update in-memory and sql database */
                        updateSubmoduleField(nodeId, subModIdx, fieldId, value);

                        /** write changes to the bus */
                        dispatchSubmoduleField(nodeId, subModIdx, fieldId, value);

                        break;
                    }
                   case "SUBMODULE_RAW_BYTE": {
                        const { nodeId } = request; 
                        const { subModIdx, byteIndex, value } = request.payload;
                        const sub = canDatabase[nodeId].subModule[subModIdx];

                        const column = `config_byte${byteIndex}`;

                        /** update in-memory and sql database */
                        updateSubmoduleRawByte(nodeId, subModIdx, byteIndex, value);

                        /** write changes to the bus */
                        dispatchSubmoduleRawByte(nodeId, subModIdx);

                        break;
                    }
                    default:
                        console.warn(`Unknown node config target: ${configTarget}`);
                }
            } else {

                switch (request.type) {

                    case 'SAVE_AUDIT_COMMENT':
                        upsertComment.run(request.auditId, request.comment, Date.now());
                        broadcastAuditLog(); /**< Refresh all clients with the new comment */
                        break;

                    case 'SAVE_TO_BUS': {
                        const nodeId = request.nodeId;
                        const canMsg = request.canMsg; // "CFG_WRITE_NVS"

                        console.log(`Persist request received for node ${nodeId}`);

                        // Convert nodeId string → byte array (your existing helper)
                        const targetNodeId = hexStringToByteArray(nodeId);

                        // Construct and send the CAN message (your existing helper)
                        /** send persist changes command */
                        writeCanMessageBE(CAN_MSG.CFG_WRITE_NVS_ID, targetNodeId);
                        /** send reboot command */
                        writeCanMessageBE(CAN_MSG.CFG_REBOOT_ID, targetNodeId);


                        console.log(`Sent CFG_WRITE_NVS (0x436) to node ${nodeId}`);
                        break;
                    }

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
                        
                        case 'GET_METADATA':
                            ws.send(JSON.stringify({
                                type: 'DEFINITION_METADATA',
                                payload: {
                                    personalities: selectAllPersonalities.all(),
                                    fields: selectAllFields.all(),
                                    personality_fields: selectAllPersonalityFields.all(),
                                    field_options: selectAllFieldOptions.all()
                                }
                            }));
                            break;

                    default:
                        console.warn(`Unknown message type: ${request.type}`);
                }
            }
        } catch (err) {
            console.error('Failed to parse WebSocket message:', err);
        }
    }); /* end ws.on('message') */
});

wss.on('close', () => clearInterval(interval));


/* === Prepared SQL statements */
const selectAllPersonalities = db.prepare("SELECT * FROM personalities");
const selectAllFields = db.prepare("SELECT * FROM fields");
const selectAllPersonalityFields = db.prepare("SELECT * FROM personality_fields");
const selectAllFieldOptions = db.prepare("SELECT * FROM field_options");


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

/** Field mappings between the UI and the database */
const FIELD_MAP = {
    introMsgId:  "personality_id",
    dataMsgId:   "data_msg_id",
    dataMsgDlc:  "data_msg_dlc",
    saveState:   "save_state"
};

const NODE_FIELD_MAP = {
    nodeTypeMsg: "node_type_msg",
    configCrc:   "config_crc"
};


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
 * Seed the sub-modules for a given node string and node object.
 * This function inserts the intended sub-module configuration into the database.
 * @param {string} nodeString - The friendly text string representing the node.
 * @param {object} myNode - The node object containing the sub-module information.
 * @return {void}
 */
function seedSubModules(nodeString, myNode) {
    /** Add sub-module data to submodules table */
    const insertSubmoduleIntended = db.prepare(`
        INSERT OR IGNORE INTO node_submodules
        (node_id, sub_index, personality_id,
        config_byte0, config_byte1, config_byte2,
        data_msg_id, data_msg_dlc, save_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const [subIdx, sub] of Object.entries(myNode.subModule)) {
        // console.log("Processing sub-module", subIdx, "\n", JSON.stringify(sub, null, 2));

        /** make sure these fields are numbers */
        const introMsgId = Number(sub.introMsgId ?? 0);
        const dataMsgId  = Number(sub.dataMsgId  ?? 0);
        const dataMsgDlc = Number(sub.dataMsgDlc ?? 0);
        const saveState  = Number(sub.saveState  ?? 0);

        insertSubmoduleIntended.run(
            nodeString,
            Number(subIdx),
            introMsgId,
            sub.rawConfig[0],
            sub.rawConfig[1],
            sub.rawConfig[2],
            dataMsgId,
            dataMsgDlc,
            saveState
        );
    }    
}

function seedNodeIntendedTable() {
    const insert = db.prepare(`
        INSERT OR IGNORE INTO node_intended
            (node_id, node_type_msg, config_crc, updated_at)
        VALUES (?, ?, ?, ?)
    `);

    const now = Date.now();

    for (const nodeId of Object.keys(canDatabase)) {
        const node = canDatabase[nodeId];

        insert.run(
            nodeId,
            node.nodeTypeMsg ?? 0,
            node.configCrc ?? 0,   // or 0 if you don't have CRC yet
            now
        );
    }
}

function updateParentNodeField(nodeId, fieldId, value) {
    const node = canDatabase[nodeId];

    const column = NODE_FIELD_MAP[fieldId];
    if (!column) {
        console.warn("Unknown parent node field:", fieldId);
        return;
    }

    if (!node.intended) node.intended = {};
    node.intended[column] = value;

    db.prepare(`
        UPDATE node_intended
        SET ${column} = ?
        WHERE node_id = ?
    `).run(value, nodeId);

    db.prepare(`
        UPDATE node_intended
        SET ${column} = ?, 
        updated_at = ?
        WHERE node_id = ?
    `).run(value, Date.now(), nodeId);
}


function dispatchParentNodeField(nodeId, fieldId, value) {
    const node = canDatabase[nodeId];
    const nodeIdBytes = hexStringToByteArray(nodeId);

    if (fieldId === "nodeTypeMsg") {
        const introMsgId_hi = (value >> SHIFT_BYTE) & BYTE_MASK;
        const introMsgId_lo = value & BYTE_MASK;

        writeCanMessageBE(
            CAN_MSG.CFG_NODE_INTRO_MSG_ID,
            [
                nodeIdBytes,
                introMsgId_hi,
                introMsgId_lo,
                DEFAULT_DLC
            ]
        );
    }

    if (fieldId === "subModCnt") {
        // Nothing to dispatch to the bus for submodule count.
    }
}

function updateSubmoduleField(nodeId, subModIdx, fieldId, value) {
    const sub = canDatabase[nodeId].subModule[subModIdx];

    const column = FIELD_MAP[fieldId];
    if (!column) {
        console.warn("Unknown fieldId:", fieldId);
        return;
    }

    const normalizedValue =
        column === "save_state" ? Number(value) : value;

    sub.intended[column] = normalizedValue;

    db.prepare(`
        UPDATE node_submodules
        SET ${column} = ?
        WHERE node_id = ? AND sub_index = ?
    `).run(normalizedValue, nodeId, subModIdx);
}


function dispatchSubmoduleField(nodeId, subModIdx, fieldId, value) {
    const sub = canDatabase[nodeId].subModule[subModIdx];
    const nodeIdBytes = hexStringToByteArray(nodeId);

    if (fieldId === "introMsgId") {
        const introMsgId_hi = (value >> SHIFT_BYTE) & BYTE_MASK;
        const introMsgId_lo = value & BYTE_MASK;

        writeCanMessageBE(
            CAN_MSG.CFG_SUB_INTRO_MSG_ID,
            [
                nodeIdBytes,
                subModIdx,
                introMsgId_hi,
                introMsgId_lo,
                sub.intended.intro_msg_dlc
            ]
        );
    }

    if (fieldId === "dataMsgId") {
        const dataMsgId_hi = (value >> SHIFT_BYTE) & BYTE_MASK;
        const dataMsgId_lo = value & BYTE_MASK;

        writeCanMessageBE(
            CAN_MSG.CFG_SUB_DATA_MSG_ID,
            [
                nodeIdBytes,
                subModIdx,
                dataMsgId_hi,
                dataMsgId_lo,
                sub.intended.data_msg_dlc
            ]
        );
    }
}

function updateSubmoduleRawByte(nodeId, subModIdx, byteIndex, value) {
    const sub = canDatabase[nodeId].subModule[subModIdx];

    const column = `config_byte${byteIndex}`;

    sub.intended[column] = value;

    db.prepare(`
        UPDATE node_submodules
        SET ${column} = ?
        WHERE node_id = ? AND sub_index = ?
    `).run(value, nodeId, subModIdx);
}

function dispatchSubmoduleRawByte(nodeId, subModIdx) {
    const sub = canDatabase[nodeId].subModule[subModIdx];
    const nodeIdBytes = hexStringToByteArray(nodeId);

    writeCanMessageBE(
        CAN_MSG.CFG_SUB_RAW_DATA_ID,
        [
            nodeIdBytes,
            subModIdx,
            sub.intended.config_byte0,
            sub.intended.config_byte1,
            sub.intended.config_byte2
        ]
    );
}



/**
 * Retrieve the intended sub-module configuration for a given node ID and sub-index.
 * @param {string} nodeId - The ID of the node.
 * @param {number} subIdx - The sub-index of the sub-module.
 * @return {object|null} - The intended sub-module configuration, or null if not found.
 */
function getIntendedSubmodule(nodeId, subIdx) {
    return db.prepare(`
        SELECT personality_id,
               config_byte0, config_byte1, config_byte2,
               data_msg_id, data_msg_dlc, save_state
        FROM node_submodules
        WHERE node_id = ? AND sub_index = ?
    `).get(nodeId, subIdx);
}


function compareSubmodule(reported, intended) {
    if (!intended) {
        return {
            isInSync: false,
            personalityMatch: false,
            dataMsgIdMatch: false,
            dataMsgDlcMatch: false,
            saveStateMatch: false,
            byteMatches: [false, false, false]
        };
    }

    const byteMatches = [
        reported.rawConfig[0] === intended.config_byte0,
        reported.rawConfig[1] === intended.config_byte1,
        reported.rawConfig[2] === intended.config_byte2
    ];

    return {
        personalityMatch: reported.introMsgId === intended.personality_id,
        dataMsgIdMatch:   reported.dataMsgId   === intended.data_msg_id,
        dataMsgDlcMatch:  reported.dataMsgDlc  === intended.data_msg_dlc,
        saveStateMatch: Number(reported.saveState) === intended.save_state
,
        byteMatches,
        isInSync:
            reported.introMsgId === intended.personality_id &&
            reported.dataMsgId   === intended.data_msg_id &&
            reported.dataMsgDlc  === intended.data_msg_dlc &&
            Number(reported.saveState) === intended.save_state &&
            byteMatches.every(x => x === true)

    };
}

function compareParentNode(nodeId) {
    const node = canDatabase[nodeId];

    const intended = db.prepare(`
        SELECT node_type_msg,config_crc
        FROM node_intended
        WHERE node_id = ?
    `).get(nodeId);

    if (!intended) {
        node.parentComparison = {
            isInSync: false,
            nodeTypeMatch: false,
            configCrcMatch: false
        };
        return;
    }

    const nodeTypeMatch    = node.nodeTypeMsg === intended.node_type_msg;
    const configCrcMatch   = node.configCrc   === intended.config_crc;

    node.parentComparison = {
        nodeTypeMatch,
        configCrcMatch,
        isInSync: nodeTypeMatch && configCrcMatch
    };

    return nodeTypeMatch && configCrcMatch;
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
 * Modular function to write CAN messages with Big Endian data packing.
 * Accepts either a flat array of bytes or nested arrays of bytes.
 * @param {number} id - The CAN arbitration ID
 * @param {Array|number} data - Raw data to be packed into the CAN frame
 */
function writeCanMessageBE(id, data) {
    const buffer = Buffer.alloc(CAN_STD_DLC);

    let dataArray = [];

    if (Array.isArray(data)) {
        data.forEach(item => {
            if (Array.isArray(item)) {
                dataArray.push(...item);
            } else if (item instanceof Uint8Array) {
                dataArray.push(...item);
            } else {
                dataArray.push(item);
            }
        });
    } else if (data instanceof Uint8Array) {
        dataArray = [...data];
    } else if (typeof data === 'number') {
        dataArray = [data];
    }

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
        saveDatabaseToFile(); /* write database to disk */
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

/* === Metadata Cache (loaded once at startup) === */

const metadataCache = {
    fields: new Map(),
    fieldOptions: new Map(),
    personalityFields: new Map(),
    personalityNames: new Map(),
    nodeNames: new Map()
};

function loadMetadata() {
    // Load fields
    const fields = db.prepare(`SELECT * FROM fields`).all();
    for (const f of fields) {
        metadataCache.fields.set(f.field_id, f);
    }

    // Load field options
    const options = db.prepare(`SELECT * FROM field_options ORDER BY option_value`).all();
    for (const opt of options) {
        if (!metadataCache.fieldOptions.has(opt.field_id)) {
            metadataCache.fieldOptions.set(opt.field_id, []);
        }
        metadataCache.fieldOptions.get(opt.field_id).push(opt);
    }

    // Load personality_fields
    const pf = db.prepare(`
        SELECT personality_id, field_index, field_id
        FROM personality_fields
        ORDER BY personality_id, field_index
    `).all();

    for (const row of pf) {
        if (!metadataCache.personalityFields.has(row.personality_id)) {
            metadataCache.personalityFields.set(row.personality_id, []);
        }
        metadataCache.personalityFields.get(row.personality_id)[row.field_index] = row.field_id;
    }

    const personalitySize = Object.keys(metadataCache.personalityFields).length;
    console.log("Personality fields:", personalitySize);

    // Load personality names
    const personalities = db.prepare(`SELECT personality_id, name FROM personalities`).all();
    metadataCache.personalityNames = new Map();
    for (const p of personalities) {
        metadataCache.personalityNames.set(p.personality_id, p.name);
    }

    // Load node type names
    const nodeTypes = db.prepare(`SELECT node_type_id, name FROM node_types`).all();
    for (const nt of nodeTypes) {
        metadataCache.nodeNames.set(nt.node_type_id, nt.name);
    }


    console.log("Metadata cache loaded.");
}

/** Load metadata into ram */
loadMetadata();

function decodeSubmodule(personalityId, rawBytes) {
    const fieldIds = metadataCache.personalityFields.get(personalityId);
    if (!fieldIds) return null;  // fallback safety

    return fieldIds.map((fieldId, index) => {
        const fieldDef = metadataCache.fields.get(fieldId);
        const options = metadataCache.fieldOptions.get(fieldId) || null;

        return {
            fieldId,
            fieldName: fieldDef.name,
            inputType: fieldDef.input_type,
            description: fieldDef.description,
            value: rawBytes[index],
            options
        };
    });
}

function detectUnconfiguredSubmodules(nodeString, myNode, db) {
    // Query intended submodules from DB
    const intendedRows = db.prepare(`
        SELECT sub_index FROM node_submodules
        WHERE node_id = ?
    `).all(nodeString);

    const intendedIndices = new Set(intendedRows.map(r => r.sub_index));

    // For each submodule the node claims to have
    for (let i = 0; i < myNode.subModCnt; i++) {
        const existsOnBus = !!myNode.subModule[i];
        const existsInDB = intendedIndices.has(i);

        // Unconfigured = exists on bus, but no intended row
        if (existsOnBus && !existsInDB) {
            myNode.subModule[i].isUnconfigured = true;
            myNode.subModule[i].isInSync = false;
        }
    }
}

function detectMissingSubmodules(nodeString, myNode) {
    const reportedCount = myNode.subModCnt;                 // From intro message
    const busCount = Object.keys(myNode.subModule).length;  // From interview

    // For each submodule index the node claims to have
    for (let i = 0; i < reportedCount; i++) {
        const existsOnBus = !!myNode.subModule[i];

        if (!existsOnBus) {
            // HARD MISSING: Node claims it exists, but bus never revealed it
            myNode.subModule[i] = {
                rawConfig: [0,0,0],
                subModIdx: i,
                isMissingHard: true,
                isMissingSoft: false,
                isUnconfigured: false,
                isInSync: false
            };
        } else {
            // SOFT MISSING: Submodule existed before, but didn't respond this cycle
            // Only mark soft-missing if this submodule was seen in a previous cycle
            const sub = myNode.subModule[i];

            if (sub.lastSeen && (Date.now() - sub.lastSeen) > 0) {
                sub.isMissingHard = false;
                sub.isMissingSoft = true;
                sub.isInSync = false;
            }
        }
    }
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
    const nodeName   = metadataCache.nodeNames.get(messageId);
    // console.log("Received message from node: ", nodeString, "0x" + messageId.toString(16).toUpperCase());

    if (messageId >= INTRO_MSG_BEGIN && messageId <= INTRO_MSG_END) {

        /* Check if this is a known node */
        const isKnownNode = nodeString in canDatabase;

        if (!isKnownNode) {
            console.log("Creating new record for node", nodeString, "type:", nodeName);
            /** create new node in the in-memory database */
            canDatabase[nodeString] = { 
                                        subModule:     {}, /* empty sub-module array */
                                        lastSubModIdx: 0   /* start with index 0 */
                                      };
        }
        
        /** create a reference to the node */
        const myNode = canDatabase[nodeString];

        /** Reset missing sub-module flags */
        for (const sub of Object.values(myNode.subModule)) {
            sub.isMissingHard = false;
            sub.isMissingSoft = false;
        }
        
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

        /** Update the 'human readable' node name */
        myNode.nodeTypeName    = nodeName;

        /** If this is the first time we've seen this nodeID record first-seen time */
        if (!myNode.firstSeen) myNode.firstSeen = Date.now();

        /** Check if the number of sub-modules indexed matches the number of advertised submodules */
        if (myNode.lastSubModIdx >= (myNode.subModCnt - 1)) { /* sub module count is 0-indexed */
            /** Mark this interview as complete */
            myNode.introComplete = true;

            /** Check for missing submodules */
            detectMissingSubmodules(nodeString, myNode, db);
            
            /** Check for unconfigured submodules */
            detectUnconfiguredSubmodules(nodeString, myNode, db);

            /* === Final check to tell if the node and sub-modules are all in sync === */

            /** retrieve the number of submodules read from the bus for this node */
            const busSubModCount = Object.keys(myNode.subModule).length;

            const intendedRows = db.prepare(`
                SELECT COUNT(*) AS cnt
                FROM node_submodules
                WHERE node_id = ?
            `).get(nodeString);

            /** Check if all submodules are in sync */
            const subsInSync = Object.values(myNode.subModule)
                .every(sub => sub.isInSync === true);

            /** compare parent node specific data */
            const parentInSync = compareParentNode(nodeString);
            
            /** Set a flag for the entire node being "in sync" if all sub-modules are in sync */
            myNode.isInSync = (
                subsInSync &&
                parentInSync
            );

            /** Sync the in-memory state to SQLite */
            syncNodeToDatabase(nodeString, myNode);

            /** Seed the submodules table for this node, only if data does not already exist */
            seedSubModules(nodeString, myNode);

            seedNodeIntendedTable();

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

        let subModIdx         = msg.data[SUBMODID_OFFSET];
        const workingIdx      = (subModIdx & SUBMOD_PARTB_MASK); /* Get sub-module index */
        const messageStr      = "0x" + messageId.toString(16).toUpperCase();
        const personalityName = metadataCache.personalityNames.get(messageId) || "Unknown Personality";

        try {/** Exit if sub-module interview is already complete */
            if (canDatabase[nodeString].subModule[workingIdx].partAComplete && canDatabase[nodeString].subModule[workingIdx].partBComplete) {
                console.log("Node", nodeString, "sub-module already interviewed:", workingIdx);
                return;
            }} catch (error) {
                console.log("Node", nodeString, "interviewing new sub-module:", workingIdx, "module type:", messageStr, personalityName);
            }

        let subModPartB = false; /* Two-part introduction process */

        if (subModIdx  >= SUBMOD_PARTB_OFFSET) {
            subModPartB = true;
            subModIdx   = workingIdx; /* Subtract offset to get sub-module index */
        }

        if (subModIdx  >= NODE_MAX_SUBMODS) { /* invalid sub-module index */
            return;
        }

        /* Initialize sub-module entry, create rawConfig array and decoded object if missing */
        if (!canDatabase[nodeString].subModule[subModIdx]) {
             canDatabase[nodeString].subModule[subModIdx] = {
                rawConfig: new Array(SUBMOD_RAW_CFG_BYTES).fill(0) /* Pre-allocate for 3 config bytes */
            };
            canDatabase[nodeString].subModule[subModIdx].fieldsDecoded = null; /* Initialize to null */
        }
        
        /** create reference to the sub-module */
        const targetSub = canDatabase[nodeString].subModule[subModIdx];

        /** update sub-module specific properties */
        targetSub.subModIdx          = subModIdx;
        targetSub.lastSeen           = Date.now();
        targetSub.personalityStr     = messageStr; /* save the formatted intro message ID */
        targetSub.introMsgId         = messageId; /* personality */
        targetSub.introMsgDlc        = INTRO_MSG_DLC;

        /** get the personality name from the metadata cache */
        targetSub.personalityName    = metadataCache.personalityNames.get(messageId) || "Unknown Personality";

        if (!subModPartB) {          /* First introduction phase */
            /** Store raw configuration bytes */
            targetSub.rawConfig[0]   = msg.data[SUBMOD_RAW0_OFFSET]; /* raw config byte 0 */
            targetSub.rawConfig[1]   = msg.data[SUBMOD_RAW1_OFFSET]; /* raw config byte 1 */
            targetSub.rawConfig[2]   = msg.data[SUBMOD_RAW2_OFFSET]; /* raw config byte 2 */

            /** Set flag indicating part A of the interview is complete */
            targetSub.partAComplete  = true;
        } else {                     /* Second introduction phase */
            /* Bitwise assembly for 16-bit Big Endian Data Message ID */
            targetSub.dataMsgId      = (msg.data[SUBMOD_DATAMSGID_MSB_OFFSET] << SHIFT_BYTE) | 
                                       (msg.data[SUBMOD_DATAMSGID_LSB_OFFSET] & BYTE_MASK);
            
            const byteSeven          = msg.data[SUBMOD_DATAMSGDLC_OFFSET];
            const { dlc, saveState } = unpackByteSeven(byteSeven);
            
            targetSub.dataMsgDlc     = dlc;
            targetSub.saveState      = saveState;            
            /** Set flag indicating part B of the interview is complete */
            targetSub.partBComplete  = true;

            // console.log("Node", nodeString, "sub-module", subModIdx, "part B complete");
        }
        
        if (targetSub.partAComplete && targetSub.partBComplete) {
            /* store index last sub-module introduced for this node */
            canDatabase[nodeString].lastSubModIdx = subModIdx; 

            // console.log("Node", nodeString, "sub-module", subModIdx, "\n", JSON.stringify(targetSub, null, 2));
            /* Sync node to database */
            syncNodeToDatabase(nodeString, canDatabase[nodeString]);

            /** Decode using cached metadata */
            // targetSub.fieldsDecoded  = decodeSubmodule(messageId, targetSub.rawConfig);

            /** Load intended state from DB */
            const intended = getIntendedSubmodule(nodeString, subModIdx);

            /** Compare reported vs intended */
            const cmp = compareSubmodule(targetSub, intended);

            /** Store comparison results in memory */
            targetSub.intended = intended;
            targetSub.isInSync = cmp.isInSync;
            targetSub.byteMatches = cmp.byteMatches;
            targetSub.personalityMatch = cmp.personalityMatch;
            targetSub.dataMsgIdMatch = cmp.dataMsgIdMatch;
            targetSub.dataMsgDlcMatch = cmp.dataMsgDlcMatch;
            targetSub.saveStateMatch = cmp.saveStateMatch;
            
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

