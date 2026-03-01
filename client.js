/**
 * WebSocket client for modern Div-based CAN visualization
 */
let socket;
let container;
let statusDiv;
let filterInput;
let filterDisplay;
let allDefinitions = [];
let nodeDb;

/** Set of active filters */
const activeFilters   = new Set();
/** Wait 5 seconds before reconnecting */
const RETRY_DELAY     = 5000; 
/** Display length of a single hex byte */
const HEX_BYTE_LENGTH = 2; 
/** Character width of a two digital decimal integer */ 
const SMALL_BYTE_WDH  = 2; 
/** Base 16 for hexadecimal string parsing */
const HEX_BASE = 16;
/** Offset for headers (first 4 divs) */
const HEADER_COUNT = 4; 
const MAX_ROWS = 20;

/** Tracks which Node IDs are currently expanded in the accordion */
const expandedNodes = new Set();

/** * Mapping of Sub-Module personalities to their configuration labels.
 * Derived from the subModule_t C struct.
 */
const PERSONALITY_MAP = {
    0x438: ["Output Pin", "Blink Delay (100ms)", "Strobe Pattern"],
    0x439: ["Strip/Pin Index", "Color Index", "Configuration Index"], // Combined Analog/ARGB logic
    0x43B: ["Input Pin", "Resistor (PU/PD)", "Inversion (H/L)"],
    0x43C: ["Output Pin", "Momentary Dur (10ms)", "Output Mode"],
    0x43D: ["Input Pin", "Oversample (High)", "Oversample (Low)"], // 16-bit split
    0x43E: ["Output Pin", "Output Mode", "Reserved"],
    0x43F: ["Output Pin", "PWM Freq (100Hz)", "Inversion (H/L)"]
};


document.addEventListener('DOMContentLoaded', () => {
    // Initialize elements after DOM is ready
    container = document.getElementById('can-container');
    statusDiv = document.getElementById('status');
    filterInput   = document.getElementById('filter-input');
    filterDisplay = document.getElementById('active-filters');

    // Use the current window hostname for the socket connection
    const socketUrl = `ws://${window.location.hostname}:8080`;
    socket = new WebSocket(socketUrl);

    socket.onopen = () => {
        if (statusDiv) {
            statusDiv.innerText = 'Status: Connected';
            statusDiv.style.color = '#4ec9b0';
        }
    };

    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);

        /** Route message based on the 'type' property. */
        switch (message.type) {
            case 'DEFINITIONS_LIST':
                allDefinitions = message.payload;
                /** Populate a global Map for O(1) UI lookups */
                window.definitionsMap = new Map(allDefinitions.map(d => [d.id_dec, d]));
                console.log(`Definitions cached: ${allDefinitions.length} entries.`);
                break;

            case 'DATABASE_UPDATE':
                /** * We don't render until we have definitions to ensure 
                 * dropdowns and labels have the data they need.
                 */
                if (allDefinitions.length > 0) {
                    nodeDb = message.payload;
                    renderNodeDatabase(nodeDb);
                }
                break;

            case 'AUDIT_LOG_UPDATE':
                renderAuditLog(message.payload);
                break;

            case 'UPDATE_ACK':
                handleSaveConfirmation(message.nodeId, message.subModIdx);
                break;

            case 'CAN_MESSAGE':
                processLiveCanFrame(message);
                break;

            default:
                /** * Fallback for legacy formats or unrecognized messages.
                 * If the message has an ID but no type, treat it as a raw CAN frame.
                 */
                if (message.id) {
                    processLiveCanFrame(message);
                } else {
                    console.warn('Received unrecognized WebSocket message:', message);
                }
                break;
        }
    };

    socket.onclose = () => {
        statusDiv.innerText = 'Status: Disconnected. ';
        statusDiv.style.color = '#f44747';
    };


});

/* === Functions === */

/**
 * Helper to build a dropdown select element.
 * @param {Array} definitions - The allDefinitions array.
 * @param {Number} minId - Minimum Hex ID for this dropdown range.
 * @param {Number} maxId - Maximum Hex ID for this dropdown range.
 * @param {Number} currentValue - The current value to select.
 * @returns {String} HTML string for the select element.
 */
function buildDropdown(definitions, minId, maxId, currentValue) {
    let optionsHtml = `<option value="0">0x000 - UNKNOWN/NONE</option>`;

    if (definitions.length === 0) {
        return optionsHtml;
    } 

    // Filter definitions based on the allowed range for this field
    const validDefs = definitions.filter(def => def.id_dec >= minId && def.id_dec <= maxId);

    // console.log(definitions);

    validDefs.forEach(def => {
        /* Check if current definition matches the target value */
        const isSelected = (def.id_dec == currentValue) ? 'selected' : '';

        optionsHtml += `<option title="${def.description}" value="${def.id_dec}" ${isSelected}>${def.id_hex} - ${def.name}</option>`;
    });

    // Fallback in case the current value isn't in definitions but isn't 0
    if (currentValue !== 0 && !validDefs.some(def => def.id_dec === currentValue)) {
        const currentHex = '0x' + currentValue.toString(16).toUpperCase();
        optionsHtml += `<option value="${currentValue}" selected>${currentHex} - CUSTOM</option>`;
    }

    return optionsHtml;
}

/**
 * Sends an updated configuration payload to the server.
 * @param {String} nodeId - The 32-bit Node ID.
 * @param {String} target - Either 'PARENT' or 'SUBMODULE'.
 * @param {Number} subModIdx - The index of the sub-module (if applicable).
 * @param {Object} payload - The complete data object for the parent or sub-module.
 */
function sendConfigUpdate(nodeId, target, subModIdx, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error("Cannot send update, WebSocket is not open.");
        return;
    }

    const message = {
        type: 'UPDATE_NODE_CONFIG',
        nodeId: nodeId,
        configTarget: target, // 'PARENT' or 'SUBMODULE'
        subModIdx: subModIdx, // null if updating parent
        payload: payload
    };

    socket.send(JSON.stringify(message));
}

/**
 * Instructs the server to construct CAN messages and save the node config to the bus.
 * @param {String} nodeId - The 32-bit Node ID.
 */
function persistNodeToBus(nodeId) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    
    socket.send(JSON.stringify({
        type: 'SAVE_TO_BUS',
        nodeId: nodeId
    }));
    
    alert(`Instructed server to persist Node ${nodeId} to CAN-bus.`);
}

/**
 * Visual feedback that server has received and processed the update.
 * @param {string} nodeId - The ID of the updated node.
 * @param {number} subIdx - The index of the updated sub-module.
 */
function handleSaveConfirmation(nodeId, subIdx) {
    const subKey = `${nodeId}-${subIdx}`;
    /* Target the specific cells related to this sub-module */
    const cells = document.querySelectorAll(`.node-${nodeId}`);
    
    cells.forEach(cell => {
        /* We check the unique IDs we set in the renderer to only flash the specific row */
        if (cell.innerHTML.includes(`id="msg-${subKey}"`) || 
            cell.innerHTML.includes(`id="raw-${subKey}"`)) {
            
            cell.classList.add('flash-success');
            
            /* Remove class after animation finishes so it can be re-triggered */
            setTimeout(() => {
                cell.classList.remove('flash-success');
            }, 1500); /**< Matches CSS animation duration */
        }
    });
}

function formatTimestampAsUTC(milliseconds) {
  const dateObj = new Date(milliseconds);
  const hours = dateObj.getUTCHours().toString().padStart(SMALL_BYTE_WDH, '0');
  const minutes = dateObj.getUTCMinutes().toString().padStart(SMALL_BYTE_WDH, '0');
  const seconds = dateObj.getUTCSeconds().toString().padStart(SMALL_BYTE_WDH, '0');

  return `${hours}:${minutes}`;
//   return `${hours}:${minutes}:${seconds}`; /* don't return seconds */
}

function connect() {
    const socketUrl = `ws://${window.location.hostname}:8080`;
    socket = new WebSocket(socketUrl);

    socket.onclose = () => {
        statusDiv.innerText = 'Status: Disconnected.';
        statusDiv.style.color = '#f44747';
    };

    /* ... include your existing onmessage and onopen handlers ... */
}

document.addEventListener('DOMContentLoaded', connect);

/**
 * Renders the audit log entries into the audit-grid
 * @param {Array} logs - Recent audit entries from server
 */
function renderAuditLog(logs) {
    const container = document.getElementById('audit-container');
    
    /** Preserve the first 5 header cells */
    const headers = Array.from(container.children).slice(0, 5);
    container.innerHTML = '';
    headers.forEach(h => container.appendChild(h));

    logs.forEach(log => {
        const timeStr = new Date(log.timestamp).toLocaleTimeString();
        const changeStr = `${log.old_value} ➔ ${log.new_value}`;
        const comment = log.comment_text || '';

        /** Create cells for each column */
        const rowData = [
            { text: timeStr, class: '' },
            { text: `${log.node_id} (${log.sub_idx})`, class: 'hex-id' },
            { text: log.field, class: '' },
            { text: changeStr, class: 'hex-data' },
            { isComment: true, text: comment, id: log.id }
        ];

        rowData.forEach(cell => {
            const div = document.createElement('div');
            div.className = 'data-cell';
            
            if (cell.isComment) {
                div.innerHTML = `
                    <input type="text"  
                           id="audit-comment-${cell.id}"
                           class="audit-input"
                           value="${cell.text}" 
                           placeholder="Add note..."
                           onchange="saveAuditComment(${cell.id}, this.value)">
                `;
            } else {
                div.className += ` ${cell.class}`;
                div.innerText = cell.text;
            }
            container.appendChild(div);
        });
    });
}

/**
 * Updates the labels for the configuration bytes based on the selected personality ID.
 */
function updateConfigLabels(nodeId, subIdx, personalityId) {
    const labels = PERSONALITY_MAP[personalityId] || ["Raw Byte 0", "Raw Byte 1", "Raw Byte 2"];
    const labelContainer = document.getElementById(`labels-${nodeId}-${subIdx}`);
    if (labelContainer) {
        labelContainer.innerHTML = labels.map(l => `<span class="config-label">${l}</span>`).join('');
    }
}

/**
 * Triggers a full node re-interview.
 * @param {string} nodeId - Hex string representation of the Node ID.
 */
function requestNodeInterview(nodeId) {
    if (confirm(`Are you sure you want to re-interview node ${nodeId}? Any unsaved config will be cleared.`)) {
        socket.send(JSON.stringify({
            type: 'REQUEST_NODE_INTERVIEW',
            nodeId: nodeId
        }));
    }
}

/**
 * Sends a comment update to the server
 */
function saveAuditComment(auditId, text) {
    socket.send(JSON.stringify({
        type: 'SAVE_AUDIT_COMMENT',
        auditId: auditId,
        comment: text
    }));
}

/**
 * Toggles a sub-module row into edit mode using minimal in-line inputs.
 * @param {Event} event - The click event.
 * @param {string} nodeId - Parent node ID.
 * @param {number} subIdx - Sub-module index.
 */
function editSubModule(event, nodeId, subIdx) {
    const btn = event.target;
    const subKey = `${nodeId}-${subIdx}`;
    
    const msgSpan = document.getElementById(`msg-${subKey}`);
    const rawSpan = document.getElementById(`raw-${subKey}`);
    const dlcSpan = document.getElementById(`dlc-${subKey}`);

    if (btn.innerText === 'E') {
        /* --- Enter Edit Mode --- */
        // Store current values in data attributes in case user clicks 'X' (Cancel)
        msgSpan.dataset.before = msgSpan.innerText;
        rawSpan.dataset.before = rawSpan.innerText;
        dlcSpan.dataset.before = dlcSpan.innerText;

        const currentMsg = msgSpan.innerText;
        const currentRaw = rawSpan.innerText;
        const currentDlc = dlcSpan.innerText;
    

        msgSpan.innerHTML = `<input type="text" title="Data Message ID" id="input-msg-${subKey}" class="edit-input" size="4" value="${currentMsg}">`;
        rawSpan.innerHTML = `<input type="text" title="Raw Configuration String" id="input-raw-${subKey}" class="edit-input" size="${currentRaw.length + 1}" value="${currentRaw}">`;
        dlcSpan.innerHTML = `<input type="text" title="Data Message DLC" id="input-dlc-${subKey}" class="edit-input" size="4" value="${currentDlc}">`;

        btn.innerText = 'S'; // Switch to Save
        btn.title = "Save Changes";
        btn.classList.add('save-btn');
    } else {
        console.log("Saving changes for sub-module:", subIdx);
        /* --- Save Mode --- */
        const newMsgVal = document.getElementById(`input-msg-${subKey}`).value.trim();
        const newRawVal = document.getElementById(`input-raw-${subKey}`).value.trim();
        const newDlcVal = document.getElementById(`input-dlc-${subKey}`).value.trim();

        /** * Parse the raw config string. 
         * Regular expression /[ ,]+/ handles one or more spaces/commas as separators.
         */
        const rawArray = newRawVal.split(/[ ,]+/)
                                  .filter(Boolean)
                                  .map(hex => parseInt(hex, 16));

        // Format back to your preferred 2-character hex string: 1B,3F,02
        const formattedRaw = rawArray.map(val => 
            val.toString(16).toUpperCase().padStart(2, '0')
        ).join(',');

        // Update UI
        msgSpan.innerText = newMsgVal.toUpperCase(); /* hex values as uppercase */
        rawSpan.innerText = formattedRaw;
        dlcSpan.innerText = newDlcVal;

        btn.innerText = 'E';
        btn.classList.remove('save-btn');
        btn.title = "Edit Sub-module";

        // Transmit the update to the Node.js server
        saveNodeUpdate(nodeId, subIdx, newMsgVal, rawArray, newDlcVal);
    }
}

/**
 * Cancels editing and reverts to the previous values.
 * @param {Event} event - The click event.
 * @param {string} nodeId - Parent node ID.
 * @param {number} subIdx - Sub-module index.
 */
function closeEditor(event, nodeId, subIdx) {
    const subKey = `${nodeId}-${subIdx}`;
    const btnE = event.target.previousElementSibling; // Finds the 'S'/'E' button
    
    const msgSpan = document.getElementById(`msg-${subKey}`);
    const rawSpan = document.getElementById(`raw-${subKey}`);
    const dlcSpan = document.getElementById(`dlc-${subKey}`);

    // Only revert if we are actually in edit mode (button is 'S')
    if (btnE && btnE.innerText === 'S') {
        msgSpan.innerText = msgSpan.dataset.before || '';
        rawSpan.innerText = rawSpan.dataset.before || '';
        dlcSpan.innerText = dlcSpan.dataset.before || '';

        btnE.innerText = 'E';
        btnE.classList.remove('save-btn');
    }
}

/**
 * Sends updated node configuration back to the server.
 * @param {string} nodeId - The target node's unique ID string.
 * @param {number} subIdx - The sub-module index.
 * @param {string} msgHex - The new message ID in hex format.
 * @param {Array} rawArray - An array of decimal numbers representing the config.
 * @param {number|string} dlcVal - The data length code.
 */
function saveNodeUpdate(nodeId, subIdx, msgHex, rawArray, dlcVal) {
    const payload = {
        type: 'UPDATE_NODE_CONFIG',
        nodeId: nodeId,
        subModIdx: subIdx,
        dataMsgId: parseInt(msgHex, 16),
        /** * rawArray is already an array of numbers from the regex logic, 
         * so we can pass it directly.
         */
        rawConfig: rawArray, 
        dataMsgDlc: parseInt(dlcVal, 10)
    };

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload)); 
    }
}

/**
 * Renders the inline editor for the Node database.
 * @param {Object} nodes - The CAN node database object.
 */
function renderNodeDatabase(nodes) {
    const container = document.getElementById('editor-container');
    if (!container) return;

    // Preserve headers and clear out previous rows
    container.innerHTML = `
        <div class="header-cell">Command</div>
        <div class="header-cell">ID (Hex)</div>
        <div class="header-cell">Data (Config)</div>
        <div class="header-cell">DLC</div>        
    `;

    for (const [nodeId, nodeData] of Object.entries(nodes)) {
        const isExpanded = expandedNodes.has(nodeId);
        
        // --- Render PARENT NODE Row ---
        
        // Command Column: Expand/Collapse and Persist
        /** create the cell for the buttons */
        const cmdCell = document.createElement('div');
        cmdCell.className = 'editor-cell';
        cmdCell.classList.add('data-cell');
        cmdCell.id = `node-${nodeId}-cmd`;
        cmdCell.innerHTML = `
            <button onclick="toggleNode('${nodeId}')" style="margin-right: 5px;">
                ${isExpanded ? '[-]' : '[+]'}
            </button>
            <button onclick="persistNodeToBus('${nodeId}')">Persist</button>
        `;

        // ID Column
        const idCell = document.createElement('div');
        idCell.className = 'editor-cell data-cell hex-id';
        idCell.id = `node-${nodeId}-id`;
        idCell.innerText = nodeId.toUpperCase();

        // Data Column: Inline editing for Node Type and Sub-Module Count
        const dataCell = document.createElement('div');
        dataCell.id = `node-${nodeId}-data`;
        dataCell.className = 'editor-cell';
        dataCell.classList.add('data-cell');

        
        // Node Type Dropdown (Range 0x780 - 0x79F)
        const nodeTypeSelect = document.createElement('select');
        nodeTypeSelect.name = `node-${nodeId}-type`;
        nodeTypeSelect.classList.add('editor-input');
        nodeTypeSelect.classList.add('cell-input');
        nodeTypeSelect.innerHTML = buildDropdown(allDefinitions, 0x780, 0x79F, nodeData.nodeTypeMsg);
        
        // Sub-module Count Input
        const subModCntInput = document.createElement('input');
        subModCntInput.name = 'submod-cnt-' + nodeId;
        subModCntInput.classList.add('editor-input');
        subModCntInput.classList.add('cell-input');
        subModCntInput.type = 'number';
        subModCntInput.min = '0';
        subModCntInput.max = '8';
        subModCntInput.value = nodeData.subModCnt;
        subModCntInput.style.width = '40px';

        dataCell.innerHTML = `<label class="label">Type:</label>`;
        dataCell.appendChild(nodeTypeSelect);
        dataCell.innerHTML += `<label class="label">Sub-Mods:</label>`;
        dataCell.appendChild(subModCntInput);

        // DLC Column: Inline editing for Node DLC
        const dlcCell = document.createElement('div');
        dlcCell.id = `node-${nodeId}-dlc`;
        dlcCell.className = 'editor-cell data-cell';
        const dlcInput = document.createElement('input');
        dlcInput.classList.add('editor-input');
        dlcInput.name = 'dlc-' + nodeId;
        dlcInput.type = 'number';
        dlcInput.min = '0';
        dlcInput.max = '8';
        dlcInput.value = nodeData.nodeTypeDlc;
        dlcInput.style.width = '40px';
        dlcCell.appendChild(dlcInput);

        // Bind PARENT changes to send update
        const handleParentChange = () => {
            const updatedParent = {
                ...nodeData, // Keep existing fields
                nodeTypeMsg: parseInt(nodeTypeSelect.value, 10),
                subModCnt: parseInt(subModCntInput.value, 10),
                nodeTypeDlc: parseInt(dlcInput.value, 10)
            };
            sendConfigUpdate(nodeId, 'PARENT', null, updatedParent);
        };

        nodeTypeSelect.onchange = handleParentChange;
        subModCntInput.onchange = handleParentChange;
        dlcInput.onchange = handleParentChange;

        // Append Parent Row to Grid
        container.append(cmdCell, idCell, dataCell, dlcCell);

        // --- Render SUB-MODULE Rows (If Expanded) ---
        if (isExpanded && nodeData.subModule) {
            for (const [idxStr, subMod] of Object.entries(nodeData.subModule)) {
                const idx = parseInt(idxStr, 10);
                
                const subCmdCell = document.createElement('div');
                subCmdCell.id = `node-${nodeId}-sub-${idx}-cmd`;
                subCmdCell.className = 'data-cell';
                subCmdCell.style.textAlign = 'right';
                subCmdCell.innerHTML = `↳ Sub-module`; // Visual indicator

                const subIdCell = document.createElement('div');
                subIdCell.className = 'data-cell';
                subIdCell.id = `node-${nodeId}-sub-${idx}-id`;
                subIdCell.innerText = idxStr.toUpperCase();
                
                // Data Column for Sub-module, container for the two rows created below
                const subDataCell = document.createElement('div');
                subDataCell.id = `node-${nodeId}-sub-${idx}-data`;
                subDataCell.className = 'data-cell';
                subDataCell.style.display = 'flex';
                subDataCell.style.justifyContent = 'flex-start';
                subDataCell.style.alignItems = 'left';
                subDataCell.style.flexDirection = 'column'; // Stack rows vertically
                subDataCell.style.gap = '8px';
                
                // Row 1: Intro and Data ID
                const row1 = document.createElement('div');
                row1.className = 'label-row';
                row1.id = `node-${nodeId}-sub-${idx}-row1`;
                row1.style.display = 'flex';
                row1.style.gap = '10px';
                row1.style.alignItems = 'center';

                const introSelect = document.createElement('select');
                introSelect.name = `node-${nodeId}-sub-${idx}-intro`;
                introSelect.className = 'editor-input';
                introSelect.innerHTML = buildDropdown(allDefinitions, 0x700, 0x77F, subMod.introMsgId);
                
                const dataIdSelect = document.createElement('select');
                dataIdSelect.name = `node-${nodeId}-sub-${idx}-data-id`;
                dataIdSelect.className = 'editor-input';
                dataIdSelect.innerHTML = buildDropdown(allDefinitions, 0x110, 0x5FF, subMod.dataMsgId);

                row1.innerHTML = `<label>Intro:</label>`;
                row1.appendChild(introSelect);
                row1.innerHTML += `<label>Data ID:</label>`;
                row1.appendChild(dataIdSelect);

                // Row 2: Raw Config Bytes
                const row2 = document.createElement('div');
                row2.id = `node-${nodeId}-sub-${idx}-row2`;
                row2.className = 'label-row';
                row2.style.display = 'flex';
                row2.style.gap = '10px';
                row2.style.alignItems = 'center';
                // row2.style.height = '12px';
                row2.innerHTML = `<label>Raw Config:</label>`;

                const rawInputs = [];
                for (let i = 0; i < 3; i++) {
                    const byteInput = document.createElement('input');
                    byteInput.name = `node-${nodeId}-sub-${idx}-raw-${i}`;
                    byteInput.type = 'number';
                    byteInput.className = 'editor-input';
                    byteInput.min = '0';
                    byteInput.max = '255';
                    byteInput.value = subMod.rawConfig ? subMod.rawConfig[i] : 0;
                    byteInput.style.width = '50px';
                    rawInputs.push(byteInput);
                    row2.appendChild(byteInput);
                }

                // Add both rows to the Data cell
                subDataCell.appendChild(row1);
                subDataCell.appendChild(row2);

                // Sub-module DLC
                const subDlcCell = document.createElement('div');
                subDlcCell.className = 'data-cell';
                const subDlcInput = document.createElement('input');
                subDlcInput.type = 'number';
                subDlcInput.className = 'editor-input';
                subDlcInput.min = '0';
                subDlcInput.max = '8';
                subDlcInput.value = subMod.dataMsgDlc;
                subDlcInput.style.width = '40px';
                subDlcCell.appendChild(subDlcInput);

                // Bind SUB-MODULE changes to send update
                const handleSubModChange = () => {
                    const updatedSubMod = {
                        ...subMod,
                        introMsgId: parseInt(introSelect.value, 10),
                        dataMsgId: parseInt(dataIdSelect.value, 10),
                        dataMsgDlc: parseInt(subDlcInput.value, 10),
                        rawConfig: [
                            parseInt(rawInputs[0].value, 10),
                            parseInt(rawInputs[1].value, 10),
                            parseInt(rawInputs[2].value, 10)
                        ]
                    };
                    sendConfigUpdate(nodeId, 'SUBMODULE', idx, updatedSubMod);
                };

                introSelect.onchange = handleSubModChange;
                dataIdSelect.onchange = handleSubModChange;
                subDlcInput.onchange = handleSubModChange;
                rawInputs.forEach(input => input.onchange = handleSubModChange);

                container.append(subCmdCell, subIdCell, subDataCell, subDlcCell);
            }
        }
    }
}

/**
 * Toggles the accordion state for a given Node ID
 * @param {String} nodeId 
 */
window.toggleNode = function(nodeId) {
    if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);
    } else {
        expandedNodes.add(nodeId);
    }
    // Re-render immediately to show/hide submodules (assuming 'nodes' is stored globally)
    // If your app holds `window.currentNodes`, call renderNodeDatabase(window.currentNodes) here.
    renderNodeDatabase(nodeDb);
};

/**
 * Toggles visibility of sub-modules for a specific node ID
 * @param {Event} event - The click event
 * @param {string} nodeId - The ID of the node to toggle
 */
function toggleSubModules(event, nodeId) {
    const rows = document.querySelectorAll(`.node-${nodeId}`);
    rows.forEach(row => row.classList.toggle('expanded'));
    
    // Update button text safely using the passed event
    const btn = event.target;
    btn.innerText = btn.innerText === '+' ? '-' : '+';
}

/**
 * Toggles a specific CAN ID in the filter set
 */
function toggleFilter() {
    const val = filterInput.value.trim().toLowerCase();
    if (!val) return;

    if (activeFilters.has(val)) {
        activeFilters.delete(val);
    } else {
        activeFilters.add(val);
    }

    updateFilterUI();
    filterInput.value = '';
}

function updateFilterUI() {
    filterDisplay.innerHTML = '';
    activeFilters.forEach(id => {
        const span = document.createElement('span');
        span.className = 'filter-tag';
        span.innerText = id;
        filterDisplay.appendChild(span);
    });
}

/**
 * Determines the CSS class for a row based on the CAN ID range
 * @param {number} id - The arbitration ID
 * @returns {string} - The CSS class name
 */
function getRowClass(id) {
    if (id >= 0x700 && id <= 0x7FF) return 'range-intro';
    if (id >= 0x100 && id <= 0x1FF) return 'range-switch';
    if (id >= 0x200 && id <= 0x2FF) return 'range-display';
    if (id >= 0x400 && id <= 0x4FF) return 'range-config';
    if (id >= 0x500 && id <= 0x5FF) return 'range-data';
    return '';
}

function processLiveCanFrame(msg) {
    const hexId = '0x' + msg.id.toString(HEX_BASE).toUpperCase();
    const rangeClass = getRowClass(msg.id);

    // Filtering Logic: If filters exist, skip messages that don't match
    if (activeFilters.size > 0 && !activeFilters.has(hexId)) {
        return; 
    }
    
    const displayName = msg.name !== 'UNKNOWN' ? msg.name : hexId;
    const hexData = msg.data.map(b => b.toString(HEX_BASE).toUpperCase().padStart(HEX_BYTE_LENGTH, '0')).join(' ');

    const cells = [
        { text: formatTimestampAsUTC(msg.timestamp), class: '' },
        { text: displayName, class: 'hex-id' }, // Now shows the name!
        { text: hexData, class: 'hex-data' },
        { text: msg.data.length, class: '' }
    ];

    // Insert new cells at the top (after headers)
    cells.reverse().forEach(cellData => {
        const div = document.createElement('div');

        div.className = `data-cell ${cellData.class} ${rangeClass}`;
        // div.className = `data-cell ${cellData.class}`;
        div.innerText = cellData.text;

        
        container.insertBefore(div, container.children[HEADER_COUNT]);
    });

    // Truncate bottom rows
    while (container.children.length > (MAX_ROWS * 4) + HEADER_COUNT) {
        container.removeChild(container.lastChild);
    }
};

