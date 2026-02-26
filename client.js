/**
 * WebSocket client for modern Div-based CAN visualization
 */
const socket = new WebSocket('ws://cancontrol:8080');
const container = document.getElementById('can-container');
const statusDiv = document.getElementById('status');
const filterInput = document.getElementById('filter-input');
const filterDisplay = document.getElementById('active-filters');

const activeFilters = new Set();

// Offset for headers (first 4 divs)
const HEADER_COUNT = 4; 
const MAX_ROWS = 20;

socket.onopen = () => {
    statusDiv.innerText = 'Status: Connected';
    statusDiv.style.color = '#4ec9b0';
};

/* === Functions === */
/**
 * Fetches and renders the node database into the editor-container
 */
async function loadNodeDatabase() {
    const editorContainer = document.getElementById('editor-container');
    const EDITOR_HEADERS = 4;

    try {
        const response = await fetch('/api/database');
        const db = await response.json();

        Object.entries(db).forEach(([key, node]) => {
            const nodeId = node.nodeId || 'Unknown';
            
            // 1. Create Parent Row Cells
            const parentCells = [
                { html: `<button class="expand-btn" onclick="toggleSubModules('${nodeId}')">+</button>`, class: 'node-parent' },
                { html: `ID: ${nodeId}`, class: 'node-parent hex-id' },
                { html: `Node Type Msg: 0x${node.nodeTypeMsg.toString(16).toUpperCase()}`, class: 'node-parent' },
                { html: node.subModCnt, class: 'node-parent' }
            ];

            parentCells.forEach(cell => {
                const div = document.createElement('div');
                div.className = `data-cell ${cell.class}`;
                div.innerHTML = cell.html;
                editorContainer.appendChild(div);
            });

            // 2. Create Sub-Module Rows (hidden by default)
            Object.values(node.subModule).forEach(sub => {
                const subCells = [
                    { html: '└─', class: 'sub-module-row' },
                    { html: `SubIdx: ${sub.subModIdx}`, class: 'sub-module-row' },
                    { html: `DataMsg: 0x${sub.dataMsgId.toString(16).toUpperCase()}`, class: 'sub-module-row' },
                    { html: sub.dataMsgDlc, class: 'sub-module-row' }
                ];

                subCells.forEach(cell => {
                    const div = document.createElement('div');
                    div.className = `data-cell ${cell.class} node-${nodeId}`;
                    div.innerHTML = cell.html;
                    editorContainer.appendChild(div);
                });
            });
        });
    } catch (err) {
        console.error('Failed to load database:', err);
    }
}

/**
 * Toggles visibility of sub-modules for a specific node ID
 * @param {string} nodeId - The ID of the node to toggle
 */
function toggleSubModules(nodeId) {
    const rows = document.querySelectorAll(`.node-${nodeId}`);
    rows.forEach(row => row.classList.toggle('expanded'));
    
    // Update button text
    const btn = event.target;
    btn.innerText = btn.innerText === '+' ? '-' : '+';
}

// Initialize on load
document.addEventListener('DOMContentLoaded', loadNodeDatabase);

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

socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const hexId = '0x' + msg.id.toString(16).toLowerCase();
    const rangeClass = getRowClass(msg.id);

    // Filtering Logic: If filters exist, skip messages that don't match
    if (activeFilters.size > 0 && !activeFilters.has(hexId)) {
        return; 
    }

    const time = new Date(msg.timestamp).toISOString().split('T')[1].slice(0, -1);
    const hexData = msg.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

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

socket.onclose = () => {
    statusDiv.innerText = 'Status: Disconnected';
    statusDiv.style.color = '#f44747';
};