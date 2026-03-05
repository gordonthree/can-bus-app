/**
 * WebSocket client for modern Div-based CAN visualization
 */
let socket;
let container;
let statusDiv;
let filterInput;
let filterDisplay;
let allDefinitions = [];
/** copy of the in-memory CAN bus database from the server */
let canDatabase; 

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
/** Minimum number of sub modules */
const SUBMOD_CNT_MIN = 0;
/** Maxiumum number of sub modules */
const SUBMOD_CNT_MAX = 8;

/** Sub module intro messages begin at 0x700 */
const SUBMOD_INTRO_BEGIN = 0x700;
/** Sub module intro messages end at 0x77F */
const SUBMOD_INTRO_END   = 0x77F;

/** First node intro message value 0x780 */
const NODE_INTRO_MSG_BEGIN = 0x780;
/** Last node intro message value 0x7FF */
const NODE_INTRO_MSG_END   = 0x7FF;

/** Data messages start at 0x110 */
const SUBMOD_DATA_BEGIN = 0x110;
/** Data messages end at 0x5FF */
const SUBMOD_DATA_END   = 0x5FF;

/** Maximum DLC value */
const DLC_MAX = 8;
/** Minimum DLC value */
const DLC_MIN = 0;
/** Sub-module config bytes (24-bits) */
const SUB_CONFIG_BYTES = 3;

/** Input type 1 is a numeric text box */
const DEFAULT_INPUT_TYPE = 1;

/** Minimum value for a byte sized number */
const BYTE_MIN_VALUE = 0;

/** Maximum value for a byte sized number */
const BYTE_MAX_VALUE = 255;

/** Tracks which Node IDs are currently expanded in the accordion */
const expandedNodes = new Set();

/** Input type numeric text box 1 */
const INPUT_TYPE_NUMERIC = 1;

/** Input type select dropdown 2 */
const INPUT_TYPE_SELECT = 2;

/** Input type read-only text box 0 */
const INPUT_TYPE_READ_ONLY = 0;

/** Mapping of Sub-Module personalities to their configuration specifics.
 * Derived from the subModule_t C struct.
 * three html labels for each input field
 * three html input types 0 = read-only textbox, 1 = text numeric input, 2 = select dropdown
*/
const personalities = {
    0x702: {
        name: "ARGB Strip",
        cfgMsgId: 0x432,
        cfgMsgDlc: 8,
        labels: ["Output Pin", "LED Count", "Color Order"],
        inputs: [1, 1, 1]
    },
    0x701: {
        name: "ARGB Strip",
        cfgMsgId: 0x432,
        cfgMsgDlc: 8,
        labels: ["Output Pin", "LED Count", "Color Order"],
        inputs: [1, 1, 1]
    },
    0x711: {
        name: "Digital Input",
        cfgMsgId: 0x433,
        cfgMsgDlc: 8,
        labels: ["Input Pin", "Input Resistor", "Inverted"],
        inputs: [1, 2, 2]
    },
    0x70A: {
        name: "Analog Backlight",
        cfgMsgId: 0x434,
        cfgMsgDlc: 8,
        labels: ["Output Pin", "Blink/PWM Rate", "Output Mode"],
        inputs: [1, 1, 2]
    },
    0x744: {
        name: "Digital Output",
        cfgMsgId: 0x434,
        cfgMsgDlc: 8,
        labels: ["Output Pin", "Blink/PWM Rate", "Output Mode"],
        inputs: [1, 1, 2]
    },
    0x70B: {
        name: "LCD Display",
        cfgMsgId: 0x435,
        cfgMsgDlc: 8,
        labels: ["Reserved", "Reserved", "Reserved"],
        inputs: [0, 0, 0]
    }
}


/** * Mapping of Sub-Module personalities to their configuration labels.
 * Derived from the subModule_t C struct.
 */
const PERSONALITY_MAP_LABELS = {
    0x702: ["Output Pin", "LED Cnt", "Color Order"], /* ARGB Strip */
    0x711: ["Input Pin", "Input Resistor (PU/PD/Float)", "Inverted"], /* Digital input */
    0x70A: ["Output Pin", "Blink/PWM Rate", "Output Mode"], /* Digital output */
    0x70B: ["Reserved", "Reserved", "Reserved"], /* LCD Display */
    0x744: ["Output Pin", "Blink/PWM Rate", "Output Mode"]
};

/** Input types for each sub-module personality 0 = read-only, 1 = numeric, 2 = dropdown */
const PERSONALITY_MAP_INPUTS = {
    0x702: [1, 1, 1], /* ARGB Strip */
    0x711: [1, 2, 2], /* Digital input */
    0x70A: [1, 1, 2], /* Digital output */
    0x70B: [0, 0, 0], /* LCD Display */
    0x744: [1, 1, 2] /* Digital output */
};

/** Analog LED strip color order, from canbus_defs.h */
const ANALOG_RGB_COLOR_IDX_MAP = {
    0: "Red",
    1: "Green",
    2: "Blue",
    3: "White",
    4: "RGB",
    5: "RGBW",
    6: "RGBA",
    7: "RGBCCT"
}

/** Digital input resistor modes, from canbus_defs.h */
const DIGITAL_INPUT_RES_MODE = {
    0: "Pullup",
    1: "Pulldown",
    2: "Floating"
}

/** Digital output modes, from canbus_defs.h */
const DIGITAL_OUTPUT_MODE = {
    0: "Off",
    1: "On",
    2: "Toggle",
    3: "Momentary",
    4: "Blink",
    5: "Strobe",
    6: "PWM"
}


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
            case 'DEFINITION_METADATA':
                window.meta = message.payload;
                tryDBRender(); /* Attempt to render the node database */

                console.log(
                    `Metadata loaded: ` +
                    `${meta.personalities.length} personalities, ` +
                    `${meta.fields.length} fields, ` +
                    `${meta.personality_fields.length} personality-field links, ` +
                    `${meta.field_options.length} field options.`
                );
                break;

            case 'DEFINITIONS_LIST':
                allDefinitions = message.payload;
                /** Populate a global Map for O(1) UI lookups */
                window.definitionsMap = new Map(allDefinitions.map(d => [d.id_dec, d]));
                console.log(`Definitions cached: ${allDefinitions.length} entries.`);
                tryDBRender(); /* Attempt to render the node database */

                break;

            case 'DATABASE_UPDATE':
                /** * We don't render until we have definitions to ensure 
                 * dropdowns and labels have the data they need.
                 */
                canDatabase = message.payload;
                tryDBRender(); /* Attempt to render the node database */
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

function tryDBRender() {
    if (allDefinitions.length > 0 && window.meta && canDatabase) {
        renderNodeDatabase(canDatabase);
    }
}

function debugPrintPF(pf) {
    if (!pf || pf.length === 0) {
        console.log("PF: <empty>");
        return;
    }

    console.log("PF (personality_fields):");
    console.table(
        pf.map(p => ({
            field_index: p.field_index,
            field_id: p.field_id,
            personality_id: p.personality_id,
            created_at: p.created_at
        }))
    );
}

function debugPrintFields(fields) {
    if (!fields || fields.length === 0) {
        console.log("Fields: <empty>");
        return;
    }

    console.log("Fields (fields table):");
    console.table(
        fields.map(f => ({
            field_id: f.field_id,
            name: f.name,
            input_type: f.input_type,
            description: f.description
        }))
    );
}

function debugPrintFieldOptions(fieldId) {
    const opts = window.meta.field_options.filter(o => o.field_id === fieldId);

    if (opts.length === 0) {
        console.log(`No field_options found for field_id ${fieldId}`);
        return;
    }

    console.log(`Options for field_id ${fieldId}:`);
    console.table(
        opts.map(o => ({
            field_id: o.field_id,
            option_id: o.id || o.option_id,
            value: o.value,
            label: o.label,
            name: o.name,
            description: o.description
        }))
    );
}



/**
 * Helper to build a dropdown select element.
 * @param {Array} definitions - The allDefinitions array.
 * @param {Number} minId - Minimum Hex ID for this dropdown range.
 * @param {Number} maxId - Maximum Hex ID for this dropdown range.
 * @param {Number} currentValue - The current value to select.
 * @returns {String} HTML string for the select element.
 */
function buildDropdown(definitions, minId, maxId, currentValue) {
    const dropDown = document.createElement('select');

    if (definitions.length === 0) {
        /** error conditon, no definitions, return a basic dropdown */
        const optionItem = document.createElement('option');
        optionItem.value = 0;
        optionItem.innerText = '0x000 - UNKNOWN/NONE';
        optionItem.title = 'No definitions found';
        dropDown.appendChild(optionItem);

        // NEW: Set dropdown-level title for the error case
        dropDown.title = 'No definitions found';

        return dropDown;
    } 

    // Filter definitions based on the allowed range for this field
    const validDefs = definitions.filter(def => def.id_dec >= minId && def.id_dec <= maxId);

    validDefs.forEach(def => {
        /* Check if current definition matches the target value */
        const isSelected = (def.id_dec == currentValue) ? 'selected' : '';
        const optionItem = document.createElement('option');
        optionItem.value = def.id_dec;
        optionItem.innerText = def.id_hex + " - " + def.name;
        optionItem.title = def.description;
        optionItem.selected = isSelected;
        dropDown.appendChild(optionItem);
    });

    // Fallback in case the current value isn't in definitions but isn't 0
    if (currentValue !== 0 && !validDefs.some(def => def.id_dec === currentValue)) {
        const optionItem = document.createElement('option');
        optionItem.value = currentValue;
        optionItem.innerText = '0x' + currentValue.toString(16).toUpperCase() + ' - CUSTOM';
        optionItem.selected = true;
        optionItem.title = 'Custom / Unknown definition';
        dropDown.appendChild(optionItem);
    }

    /** 
     * Set initial title for the dropdown itself based on the selected option.
     * This gives a tooltip when hovering over the closed dropdown.
     */
    const selectedOption = dropDown.options[dropDown.selectedIndex];
    dropDown.title = selectedOption?.title || "";

    /**
     * Update the dropdown's title dynamically whenever the user changes
     * the selected option. This keeps the tooltip accurate without requiring
     * a full UI re-render.
     *
     * addEventListener does NOT override any onchange handler attached later by the caller.
     */
    dropDown.addEventListener('change', () => {
        const opt = dropDown.options[dropDown.selectedIndex];
        dropDown.title = opt?.title || "";
    });


    return dropDown;
}


/**
 * Sends an updated configuration payload to the server.
 * @param {String} nodeId - The 32-bit Node ID.
 * @param {String} target - Either 'PARENT' or 'SUBMODULE'.
 * @param {Object} payload - The complete data object for the parent or sub-module.
 */
function sendConfigUpdate(nodeId, target, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error("Cannot send update, WebSocket is not open.");
        return;
    }

    const message = {
        type: "UPDATE_NODE_CONFIG",
        configTarget: target,
        nodeId,
        payload
    };

    console.log("Sending update:", JSON.stringify(message, null, 2));
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
        canMsg: 'CFG_WRITE_NVS', // server should send 0x436 CFG_WRITE_NVS
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

    socket.onopen = () => {
        if (statusDiv) {
            statusDiv.innerText = 'Status: Connected';
            statusDiv.style.color = '#4ec9b0';
        }
    };
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
    if (!window.meta) return;

    // 1. Get all field mappings for this personality
    const pf = window.meta.personality_fields
        .filter(p => p.personality_id === personalityId)
        .sort((a, b) => a.field_order - b.field_order);

    // 2. Convert to label strings
    const labels = pf.map(p => {
        const field = window.meta.fields.find(f => f.field_id === p.field_id);
        return field ? field.label : `Raw byte ${p.field_order}`;
    });

    // 3. Apply labels to the DOM
    for (let i = 0; i < SUB_CONFIG_BYTES; i++) {
        const labelContainer = document.getElementById(`sub-${nodeId}-${subIdx}-label${i}`);
        if (labelContainer) {
            labelContainer.innerText = labels[i] || `Raw byte ${i}`;
        }
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

function renderSubModRow1(nodeId, idxStr, subMod) {
    /** === ROW 1: Intro and Data Message and Data DLC */
    const sRow1 = document.createElement('div');
    sRow1.className = 'input-group input-row1';
    sRow1.id = `sub-mod-${nodeId}-${idxStr}-row1`;

    /** Intro message label and select box */
    const introMsgLabel = document.createElement('span');
    introMsgLabel.className = 'label-text';
    introMsgLabel.innerText = 'Intro ID:';

    // let subIntroMsg = document.createElement('select');
    const subIntroMsg = buildDropdown(allDefinitions, SUBMOD_INTRO_BEGIN, SUBMOD_INTRO_END, subMod.introMsgId);
    subIntroMsg.className = 'editor-input';
    subIntroMsg.id = `sub-mod-${nodeId}-${idxStr}-intro-id`;
    if (!subMod.personalityMatch) {
        subIntroMsg.classList.add("mismatch");
    }

    sRow1.append(introMsgLabel, subIntroMsg);

    /** Data message label and select box */
    const dataMsgLabel = document.createElement('span');
    dataMsgLabel.className = 'label-text';
    dataMsgLabel.classList.add('label-text-inside');
    dataMsgLabel.innerText = 'Data ID:';

    // let subDataMsg = document.createElement('select');
    const subDataMsg = buildDropdown(allDefinitions, SUBMOD_DATA_BEGIN, SUBMOD_DATA_END, subMod.dataMsgId);
    subDataMsg.className = 'editor-input';
    subDataMsg.id = `sub-mod-${nodeId}-${idxStr}-data-id`;
    sRow1.append(dataMsgLabel, subDataMsg);

    /** Data Message DLC Label and input box */
    const dataMsgDlcLabel = document.createElement('span');
    dataMsgDlcLabel.className = 'label-text';
    dataMsgDlcLabel.classList.add('label-text-inside');
    dataMsgDlcLabel.innerText = "Data DLC:";
    
    const subDataDlc = document.createElement('input');
    subDataDlc.className = 'editor-input';
    subDataDlc.classList.add('small-input');
    subDataDlc.type = 'text';
    subDataDlc.inputMode = 'numeric'; /* Force numeric input */
    subDataDlc.min = DLC_MIN;
    subDataDlc.max = DLC_MAX;
    subDataDlc.value = subMod.dataMsgDlc;
    subDataDlc.id = `sub-mod-${nodeId}-${idxStr}-data-dlc`;
    if (!subMod.dataMsgDlcMatch) {
        subDataDlc.classList.add("mismatch");
    }

    sRow1.append(dataMsgDlcLabel, subDataDlc);
    
    /** bind onchange handlers */
    subIntroMsg.onchange = () => {
        subIntroMsg.classList.remove("mismatch");
        handleSubModChange(nodeId, idxStr, "introMsgId", parseInt(subIntroMsg.value, 10));
    };

    subDataMsg.onchange = () => {
        subDataMsg.classList.remove("mismatch");
        handleSubModChange(nodeId, idxStr, "dataMsgId", parseInt(subDataMsg.value, 10));
    };

    subDataDlc.onchange = () => {
        subDataDlc.classList.remove("mismatch");
        handleSubModChange(nodeId, idxStr, "dataMsgDlc", parseInt(subDataDlc.value, 10));
    };


    return sRow1;
}

function renderSubModRow2(nodeId, idxStr, subMod) {
    /** === ROW 2: Specific Config */
    const sRow2 = document.createElement('div');
    sRow2.className = 'input-group input-row2';
    sRow2.id = `sub-mod-${nodeId}-${idxStr}-row2`;

    // --- Metadata-driven field lookup ---
    const pf = window.meta.personality_fields
        .filter(p => p.personality_id === subMod.introMsgId)
        .sort((a, b) => a.field_index - b.field_index);


    // Extract labels, input types, and field IDs
    const labels = pf.map(p => {
        const field = window.meta.fields.find(f => f.field_id === p.field_id);
        return field ? field.name : `Raw byte ${p.field_index}`;
    });

    const inputTypes = pf.map(p => {
        const field = window.meta.fields.find(f => f.field_id === p.field_id);
        return field ? field.input_type : 0;
    });

    const fieldIds = pf.map(p => p.field_id);

    /** Config Row Label */
    const rawCfgLabel         = document.createElement('span');
    rawCfgLabel.className     = 'label-text';
    if (labels.length > 0) { 
        /** Show label if there are fields */
        rawCfgLabel.innerText = 'Configuration';
    } else {
        /** Fallback if there are no field labels */
        rawCfgLabel.innerText = 'Raw Configuration';
    }
    sRow2.append(rawCfgLabel);

    // Fallback if personality defines fewer than 3 fields
    while (labels.length < SUB_CONFIG_BYTES) labels.push(`Raw byte ${labels.length}`);
    while (inputTypes.length < SUB_CONFIG_BYTES) inputTypes.push(DEFAULT_INPUT_TYPE);   // numeric fallback
    while (fieldIds.length < SUB_CONFIG_BYTES) fieldIds.push(null);

    // --- Loop to build the three config inputs ---
    for (let i = 0; i < SUB_CONFIG_BYTES; i++) {
        const fieldLabel = labels[i];
        const inputType = inputTypes[i];
        const fieldId = fieldIds[i];
        const currentValue = subMod.rawConfig ? subMod.rawConfig[i] : 0; /* Retrieve stored value, default to 0 */

        // Label span (same DOM structure as before)
        const bLabel = document.createElement('span');
        bLabel.className = 'label-text label-text-inside';
        bLabel.innerText = `${fieldLabel}:`;
        bLabel.id = `sub-${nodeId}-${idxStr}-label${i}`;
        sRow2.append(bLabel);

        // Input element
        let bIn;

        if (inputType === INPUT_TYPE_NUMERIC) {
            // Numeric input
            bIn = document.createElement('input');
            bIn.type = 'text';
            bIn.inputMode = 'numeric';
            bIn.className = 'editor-input small-input';
            bIn.min = BYTE_MIN_VALUE;
            bIn.max = BYTE_MAX_VALUE;
            bIn.value = currentValue;

        } else if (inputType === INPUT_TYPE_SELECT) {
            // Dropdown from metadata
            bIn = document.createElement('select');
            bIn.className = 'editor-input';

            const options = window.meta.field_options.filter(o => o.field_id === fieldId);

            options.forEach(o => {
                const opt       = document.createElement('option');
                opt.value       = o.option_value;
                opt.textContent = o.option_label;

                if (o.option_value === currentValue) {
                    opt.selected = true;
                }

                bIn.appendChild(opt);
            });


        } else {
            // Read-only fallback
            bIn = document.createElement('input');
            bIn.type = 'text';
            bIn.className = 'editor-input small-input';
            bIn.value = currentValue;
            bIn.readOnly = true;
        }

        // Mismatch highlighting
        if (!subMod.byteMatches[i]) {
            bIn.classList.add("mismatch");
        }

        if (inputType === INPUT_TYPE_SELECT || inputType === INPUT_TYPE_NUMERIC) {
            bIn.id = `sub-${nodeId}-${idxStr}-raw${i}`;

            bIn.addEventListener('change', (e) => {
                const newValue = (inputType === INPUT_TYPE_NUMERIC)
                    ? parseInt(e.target.value, 10)
                    : e.target.value;

                if (fieldId === null) {
                    // Raw byte fallback
                    handleRawByteChange(nodeId, idxStr, i, newValue);
                } else {
                    // Normal metadata-driven field
                    handleSubModChange(nodeId, idxStr, fieldId, newValue);
                }
            });
        }



        sRow2.append(bIn);
    } /* End config input loop */

    /** Label for a Save State checkbox */
    const subSaveStateLabel        = document.createElement('span');
    subSaveStateLabel.className    = 'label-text';
    subSaveStateLabel.classList.add('label-text-inside');
    subSaveStateLabel.innerText    = subMod.saveStateMatch ? "Save State:" : "⚠ Save State:";

    /** Save State checkbox */
    const saveStateInput           = document.createElement('input');
    saveStateInput.className       = 'editor-input';
    saveStateInput.classList.add('small-input');
    saveStateInput.type            = 'checkbox';
    saveStateInput.checked         = subMod.saveState;
    saveStateInput.id              = `sub-mod-${nodeId}-${idxStr}-save-state`;
    if (!subMod.saveStateMatch) { 
        saveStateInput.classList.add("mismatch"); 
    }

    /** Save state change handler */
    saveStateInput.addEventListener('change', (e) => {
        handleSubModChange(nodeId, idxStr, "saveState", e.target.checked);
    });

    /** Add label and checkbox to Row2 */
    sRow2.append(subSaveStateLabel, saveStateInput);

    return sRow2;
}

function renderSubmoduleCard(nodeId, idxStr, subMod) {
    const subModIdx = idxStr;

    /* Remember grid is only three columns wide */

    /* === First column: Sub-module Command Cell, buttons would go here */
    const subCmdCell = document.createElement('div');
    subCmdCell.className = 'data-cell';
    subCmdCell.classList.add('sub-cmd');

    /** command cell text */
    const sCmdText = document.createElement('span');
    sCmdText.innerText = '↳';
    subCmdCell.appendChild(sCmdText);

    /* === Second column: Sub-module ID Cell, warning flags could go here */

    /** Sub-module ID Cell */
    const subIdCell = document.createElement('div');
    subIdCell.className = 'data-cell';
    subIdCell.classList.add('sub-id');

    /** Sub-module ID text */
    const subIdText = document.createElement('span');
    subIdText.className = 'hex-id';
    subIdText.innerText = `submod ${idxStr}`;
    subIdText.style.paddingLeft = '4px';
    subIdCell.appendChild(subIdText);

    /* === Third column: data entry rows */

    /** Sub-module Data Cell (Stacked rows) */
    const subDataCell = document.createElement('div');
    subDataCell.className = 'data-cell';
    subDataCell.classList.add('sub-config');
    subDataCell.id = `submod-${nodeId}-${subModIdx}-personality`;

    /** Create container for the input element rows */
    const sStack = document.createElement('div');
    sStack.className = 'config-stack';

    /** call a helper to render row 1 */
    const sRow1 = renderSubModRow1(nodeId, idxStr, subMod);
    /** add it to the stack */
    sStack.appendChild(sRow1);

    /** call a helper to render row 2 */
    const sRow2 = renderSubModRow2(nodeId, idxStr, subMod);
    /** add it to the stack */
    sStack.appendChild(sRow2);
    
    /** Add config stack to the sub-module data container */
    subDataCell.appendChild(sStack);

    return [subCmdCell, subIdCell, subDataCell];
}

function renderNodeDataCell(nodeId, nodeData) {
    const dataCell = document.createElement('div');
    dataCell.className = 'data-cell';
    dataCell.classList.add('config-cell');

    /** Single row wrapper for the input elements */
    const dataWrapper = document.createElement('div');
    dataWrapper.className = 'input-group parent-node';
    
    /** Create label for the Intro Message Dropdown */
    const typeLabel = document.createElement('span'); 
    typeLabel.className = 'label-text';
    typeLabel.innerText = "Intro ID:";

    /** Create the Intro Message Dropdown */
    let nodeTypeSelect = document.createElement('select');
    nodeTypeSelect = buildDropdown(allDefinitions, NODE_INTRO_MSG_BEGIN, NODE_INTRO_MSG_END, nodeData.nodeTypeMsg);
    nodeTypeSelect.className = 'editor-input';
    nodeTypeSelect.id = `node-type-${nodeId}`;
   
    /** Create label for the Sub-Module Count */
    const subLabel = document.createElement('span');
    subLabel.className = 'label-text';
    subLabel.classList.add('label-text-inside');
    subLabel.innerText = 'Sub Mod Count:';

    /** Create the Sub-Module Count Input */
    const subModCntInput = document.createElement('input');
    subModCntInput.className   = 'editor-input';
    subModCntInput.classList.add('small-input');
    subModCntInput.value       = nodeData.subModCnt;
    subModCntInput.type        = 'text';
    subModCntInput.inputMode   = 'numeric'; /* Only allow numeric input */
    subModCntInput.min         = SUBMOD_CNT_MIN;
    subModCntInput.max         = SUBMOD_CNT_MAX;
    subModCntInput.id          = `sub-mod-cnt-${nodeId}`;

    /** Create label for the DLC input */
    const dlcLabel = document.createElement('span');
    dlcLabel.className = 'label-text';
    dlcLabel.classList.add('label-text-inside');
    dlcLabel.innerText = "DLC:";
    
    /** Create the DLC Input */
    const dlcInput = document.createElement('input');
    dlcInput.className = 'editor-input';
    dlcInput.classList.add('small-input');
    dlcInput.type = 'text';
    dlcInput.inputMode = 'numeric'; /* Only allow numeric input */
    // dlcInput.min = DLC_MIN; /* Not used */
    // dlcInput.max = DLC_MAX; /* Not used */
    dlcInput.value = nodeData.nodeTypeDlc;
    dlcInput.readOnly = true; /* user cannot edit this value */
    dlcInput.id = `node-type-dlc-${nodeId}`;

    /** Append the labels and input elements to the wrapper */
    dataWrapper.append(typeLabel, nodeTypeSelect, subLabel, subModCntInput, dlcLabel, dlcInput);
    
    /** Append the wrapper to the data cell, only one row for the parent node */
    dataCell.appendChild(dataWrapper);    


    /** Bind PARENT changes to send update */
    nodeTypeSelect.onchange = () => {
        const newValue = parseInt(nodeTypeSelect.value, 10);

        sendConfigUpdate(nodeId, "PARENT_NODE_FIELD", {
            fieldId: "nodeTypeMsg",
            value: newValue
        });
    };

    subModCntInput.onchange = () => {
        const newValue = parseInt(subModCntInput.value, 10);

        sendConfigUpdate(nodeId, "PARENT_NODE_FIELD", {
            fieldId: "subModCnt",
            value: newValue
        });
    };


    if (nodeData.parentComparison && !nodeData.parentComparison.nodeTypeMatch) {
        nodeTypeSelect.classList.add("mismatch");
    }

    if (nodeData.parentComparison && !nodeData.parentComparison.subModCountMatch) {
        subModCntInput.classList.add("mismatch");
    }

    
    return dataCell;
}

function renderNodeIdCell(nodeId, nodeData) {
    // 2. ID Cell
    const idCell = document.createElement('div');
    idCell.className = 'data-cell';
    idCell.classList.add('id-cell');
    /** add coloration if node is not in sync */
    if (!nodeData.isInSync) {
        idCell.classList.add("mismatch");
    } else {
        idCell.classList.add("hex-id");
    }
    /** Add a badge to the node id cell to show sync status */
    const nodeSyncBadge = document.createElement("span");
    nodeSyncBadge.innerText = nodeData.isInSync ? "✓" : "⚠";
    nodeSyncBadge.style.color = nodeData.isInSync ? "green" : "red";
    nodeSyncBadge.style.fontSize = "0.6rem";
    nodeSyncBadge.style.marginLeft = "6px";
    idCell.appendChild(nodeSyncBadge);


    const idCellText = document.createElement('span');
    idCellText.style.fontSize = '0.6rem';
    idCellText.innerText = "ID: " + nodeId.toUpperCase() 
    idCellText.style.paddingLeft = '4px';

    idCell.appendChild(idCellText);    

    const crcCellText = document.createElement('span');
    crcCellText.style.fontSize = '0.6rem';
    crcCellText.style.paddingLeft = '6px';
    crcCellText.innerText = "CRC: " + nodeData.configCrc;
    idCell.appendChild(crcCellText);

    return idCell;
}

function renderNodeCmdButtons(nodeId, isExpanded) {
    /** Command Buttons Cell */
    const cmdCell = document.createElement('div');
    cmdCell.className = 'data-cell';
    cmdCell.classList.add('command-cell');

    /** button to expand parent node */
    const buttonExpandNode = document.createElement('button');
    buttonExpandNode.className = 'command-button';
    buttonExpandNode.id = `expand-button-${nodeId}`;
    buttonExpandNode.title = isExpanded ? 'Collapse Node' : 'Expand Node';
    buttonExpandNode.innerText = isExpanded ? '[-]' : '[+]';
    buttonExpandNode.onclick = () => toggleNode(nodeId);

    /** button to persist parent node to bus */
    const buttonPersistNode = document.createElement('button');
    buttonPersistNode.className = 'command-button';
    buttonPersistNode.id = `persist-button-${nodeId}`;
    buttonPersistNode.innerText = '[P]';
    buttonPersistNode.title = 'Persist Changes';
    buttonPersistNode.style.marginLeft = '5px';
    buttonPersistNode.onclick = () => persistNodeToBus(nodeId);

    /** button to (re)interview parent node */
    const buttonInterviewNode = document.createElement('button');
    buttonInterviewNode.className = 'command-button';
    buttonInterviewNode.id = `interview-button-${nodeId}`;
    buttonInterviewNode.innerText = '[I]';
    buttonInterviewNode.title = 'Interview Node';
    buttonInterviewNode.style.marginLeft = '5px';
    buttonInterviewNode.onclick = () => interviewNode(nodeId);

    /** add buttons to command cell */
    cmdCell.append(buttonExpandNode, buttonPersistNode, buttonInterviewNode);

    return cmdCell;
}

function handleSubModChange(nodeId, idxStr, fieldId, newValue) {
    const subMod = canDatabase[nodeId].subModule[idxStr];

    // Update intended state in memory
    if (fieldId === null) {
        // Raw byte fallback
        // rawConfig is always an array of 3 bytes
        // idxStr is the submodule index, not the byte index
        // So we need to store raw bytes separately
        console.warn("Raw byte update needs a byte index — fieldId=null");
        return;
    }

    subMod.intended[fieldId] = newValue;
    const payload = {
        subModIdx: idxStr,
        fieldId,
        value: newValue
    };

    sendConfigUpdate(nodeId, "SUBMODULE_FIELD", payload);
}


function handleRawByteChange(nodeId, idxStr, byteIndex, newValue) {
    const subMod = canDatabase[nodeId].subModule[idxStr];

    // Update intended raw byte in memory
    subMod.rawConfig[byteIndex] = newValue;
    const payload = {
        subModIdx: idxStr,
        byteIndex,
        value: newValue
    };
    // Send minimal update to server
    sendConfigUpdate(nodeId, "SUBMODULE_RAW_BYTE", payload);
}


/**
 * Renders the inline editor for the Node database.
 * @param {Object} nodes - The CAN node database object.
 */
function renderNodeDatabase(nodes) {
    const container = document.getElementById('editor-container');
    if (!container) return;

    /** Header row: three columns
     * Command | Hardware ID | Configuration
     * This seems to work as HTML, doing it through JS causes
     * the expand/collapse function to break
     */
    container.innerHTML = `
        <div class="header-cell">Command</div>
        <div class="header-cell">Hardware ID</div>
        <div class="header-cell">Configuration</div>
    `;

    for (const [nodeId, nodeData] of Object.entries(nodes)) {
        const isExpanded = expandedNodes.has(nodeId);
        
        /* Create three columns for the grid layout */

        /** 1. Render Command Buttons Cell */
        const cmdCell  = renderNodeCmdButtons(nodeId, isExpanded);

        /** 2. Render Hardware ID Cell */
        const idCell   = renderNodeIdCell(nodeId, nodeData);

        /** 3. Data Cell (Container for config labels and inputs) */
        const dataCell = renderNodeDataCell(nodeId, nodeData);

        /** Append row to grid */
        container.append(cmdCell, idCell, dataCell); 

        /** --- SUB-MODULES --- */
        if (isExpanded && nodeData.subModule) {
            /** loop through the sub-module entires and create editor rows */
            for (const [idxStr, subMod] of Object.entries(nodeData.subModule)) {
                const [subCmdCell, subIdCell, subDataCell] = renderSubmoduleCard(nodeId, idxStr, subMod);
                container.append(subCmdCell, subIdCell, subDataCell); /* Add three sub module columns to the grid */;
            } /* End submodule For loop */
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
    renderNodeDatabase(canDatabase);
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

