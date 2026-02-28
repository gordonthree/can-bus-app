/**
 * WebSocket client for modern Div-based CAN visualization
 */
let socket;
let container;
let statusDiv;
let filterInput;
let filterDisplay;

const activeFilters   = new Set();
const RETRY_DELAY     = 5000; /**< Wait 5 seconds before reconnecting */
const HEX_BYTE_LENGTH = 2; /**< Display length of a single hex byte */
const SMALL_BYTE_WDH  = 2; /**< Character width of a two digital decimal integer */ 

// Offset for headers (first 4 divs)
const HEADER_COUNT = 4; 
const MAX_ROWS = 20;

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

    // Route message based on the 'type' property
    if (message.type === 'DATABASE_UPDATE') {
        renderNodeDatabase(message.payload);
    } else if (message.type === 'UPDATE_ACK') {
        handleSaveConfirmation(message.nodeId, message.subModIdx);
    } else if (message.type === 'CAN_MESSAGE' || (!message.type && message.id)) {
        /* Support both old and new payload formats for compatibility */
        processLiveCanFrame(message);
    }
};

    socket.onclose = () => {
        statusDiv.innerText = 'Status: Disconnected. ';
        statusDiv.style.color = '#f44747';
    };


});

/* === Functions === */

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

  return `${hours}:${minutes}:${seconds}`;
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
    

        msgSpan.innerHTML = `<input type="text" id="input-msg-${subKey}" class="edit-input" size="4" value="${currentMsg}">`;
        rawSpan.innerHTML = `<input type="text" id="input-raw-${subKey}" class="edit-input" size="${currentRaw.length + 1}" value="${currentRaw}">`;
        dlcSpan.innerHTML = `<input type="text" id="input-dlc-${subKey}" class="edit-input" size="4" value="${currentDlc}">`;

        btn.innerText = 'S'; // Switch to Save
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
 * Refactored database renderer
 * @param {Object} db - The database object from the server
 */
function renderNodeDatabase(db) {
    const editorContainer = document.getElementById('editor-container');
    // Clear existing (except headers)
    while (editorContainer.children.length > 4) {
        editorContainer.removeChild(editorContainer.lastChild);
    }

    Object.entries(db).forEach(([key, node]) => {
        const nodeId = node.nodeId || 'Unknown';
        
        // Parent Row
        const parentCells = [
            // Change the button HTML string to include 'event'
            { html: `<button class="compact-btn" onclick="toggleSubModules(event, '${nodeId}')">+</button>
                     <button class="compact-btn" onclick="interviewNode('${nodeId}')">I</button>
                     <button class="compact-btn" onclick="eraseNode('${nodeId}')">X</button>
                     <button class="compact-btn" onclick="commandNode('${nodeId}')">C</button>`,
                    class: 'node-parent'
            },
            { html: `ID: ${nodeId}`, class: 'node-parent hex-id' },
            { html: `Type: 0x${node.nodeTypeMsg.toString(16).toUpperCase() + ' Sub modules: ' + node.subModCnt + ' Config CRC: ' + node.configCrc}`, class: 'node-parent' },
            { html: node.nodeTypeDlc, class: 'node-parent' }
        ];

        parentCells.forEach(cell => {
            const div = document.createElement('div');
            div.className = `data-cell ${cell.class}`;
            div.innerHTML = cell.html;
            editorContainer.appendChild(div);
        });

        /* === Sub-Module Rows === */
        Object.values(node.subModule).forEach(sub => {
            const subKey = `${nodeId}-${sub.subModIdx}`;

            const subCells = [
                { html:  `<button class="compact-btn" onclick="editSubModule(event,'${nodeId}',${sub.subModIdx})">E</button>
                        <button class="compact-btn" onclick="closeEditor(event, '${nodeId}', ${sub.subModIdx})">X</button>`, 
                class: 'sub-module-row' 
                },
                { html:  `Idx: ${sub.subModIdx.toString().padStart(SMALL_BYTE_WDH, '0')}`, 
                class: 'sub-module-row' 
                },
                { html:  `DataMsgId (hex): <span id="msg-${subKey}">${sub.dataMsgId.toString(16).toUpperCase()}</span>
                          Raw Config (hex): <span id="raw-${subKey}">${
                            sub.rawConfig.map(val => val.toString(16).toUpperCase().padStart(HEX_BYTE_LENGTH, '0')).join(',')
                        }</span>`, 
                class: 'sub-module-row' 
                },
                { html:  `<span id="dlc-${subKey}">${sub.dataMsgDlc}</span>`, 
                class: 'sub-module-row' 
                }
            ];

            subCells.forEach(cell => {
                const div = document.createElement('div');
                /** * Ensure each cell has the sub-module-row class 
                 * and the specific node toggle class.
                 */
                div.className = `data-cell ${cell.class} node-${nodeId}`; 
                div.innerHTML = cell.html;
                editorContainer.appendChild(div);
            });
        });
    });
}

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
    const hexId = '0x' + msg.id.toString(16).toLowerCase();
    const rangeClass = getRowClass(msg.id);

    // Filtering Logic: If filters exist, skip messages that don't match
    if (activeFilters.size > 0 && !activeFilters.has(hexId)) {
        return; 
    }

    const time = formatTimestampAsUTC(msg.timestamp);
    const hexData = msg.data.map(b => b.toString(16).toUpperCase().padStart(HEX_BYTE_LENGTH, '0')).join(' ');

    const cells = [
        { text: time, class: '' },
        { text: hexId.toUpperCase(), class: 'hex-id' },
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

