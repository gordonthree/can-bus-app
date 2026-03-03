# Database docs (from Copilot)

You only need to seed **one more metadata table**: `field_options`. Everything else should remain empty until real CAN nodes report themselves. Below is a clean example of how to seed `field_options`, followed by a complete, human‑readable reference guide to *all* tables in your schema so you can document the system properly.

---

## 🌈 Example `field_options` seed data

`field_options` is used **only** for fields where `input_type = 2` (dropdowns).  
Each option row belongs to a specific field via `field_id`.

Here are realistic examples you can paste directly into SQLite.

### Color Order (field_id = 3)

```sql
INSERT INTO field_options (field_id, option_value, option_label) VALUES
(3, 0, 'RGB'),
(3, 1, 'RBG'),
(3, 2, 'GRB'),
(3, 3, 'GBR'),
(3, 4, 'BRG'),
(3, 5, 'BGR');
```

### Input Mode (field_id = 4)

```sql
INSERT INTO field_options (field_id, option_value, option_label) VALUES
(4, 0, 'Active Low'),
(4, 1, 'Active High'),
(4, 2, 'Toggle'),
(4, 3, 'Momentary');
```

### Pull Resistor (field_id = 5)

```sql
INSERT INTO field_options (field_id, option_value, option_label) VALUES
(5, 0, 'None'),
(5, 1, 'Pull-Up'),
(5, 2, 'Pull-Down');
```

You can add more later as you define additional fields.

---

## 📘 Complete reference: all tables in your system

This is the documentation you asked for — a clear, durable summary of every table, what it stores, and whether it should be seeded manually.

---

### **1. `fields`**  
**Purpose:** Defines reusable configuration fields for sub‑modules.  
**Seed manually:** Yes.  
**Key columns:**  
- `field_id` — primary key  
- `name` — human‑readable label  
- `input_type` — 1 = numeric, 2 = dropdown  
- `description` — what the field means  
- `created_at` — timestamp  

Used by the UI to build config forms.

---

### **2. `field_options`**  
**Purpose:** Dropdown values for fields with `input_type = 2`.  
**Seed manually:** Yes.  
**Key columns:**  
- `option_id`  
- `field_id` → references `fields`  
- `option_value` — numeric value stored in config byte  
- `option_label` — human label  
- `created_at`  

---

### **3. `personalities`**  
**Purpose:** Metadata for **sub‑module types** (0x700–0x77F).  
**Seed manually:** Yes.  
**Key columns:**  
- `personality_id` — CAN sub‑module type  
- `name` — human‑readable  
- `cfg_msg_id` — always 0x429  
- `cfg_msg_dlc` — always 8  
- `created_at`  

Defines how each sub‑module behaves and what fields it exposes.

---

### **4. `personality_fields`**  
**Purpose:** Maps personalities → fields in byte order.  
**Seed manually:** Yes (once you know the mapping).  
**Key columns:**  
- `id`  
- `personality_id`  
- `field_index` — byte offset (0–7)  
- `field_id`  
- `created_at`  

This is how the UI knows which fields to show for each sub‑module.

---

### **5. `node_types`**  
**Purpose:** Metadata for **node‑level modules** (0x780–0x79F).  
**Seed manually:** Yes.  
**Key columns:**  
- `node_type_id`  
- `name`  
- `dlc` — always 8  
- `created_at`  

These are the parent devices that *contain* sub‑modules.

---

### **6. `node_inventory`**  
**Purpose:** Latest reported state of each node.  
**Seed manually:** No — populated from CAN intro messages.  
**Key columns:**  
- `node_id`  
- `node_type_id`  
- `submodule_count`  
- `config_crc`  
- `last_seen`  
- `raw_json` — full reported structure  
- `created_at`  

This is the authoritative “reported state”.

---

### **7. `node_submodules`**  
**Purpose:** Intended configuration for each sub‑module.  
**Seed manually:** No — populated by UI + sync logic.  
**Key columns:**  
- `node_id`  
- `submodule_index`  
- `personality_id`  
- `config_bytes` (BLOB)  
- `dataMsgId`  
- `dataMsgDlc`  
- `saveState`  
- `created_at`  

This is what you *want* the node to be configured as.

---

### **8. `audit_log`**  
**Purpose:** Every configuration message sent to the CAN bus.  
**Seed manually:** No.  
**Key columns:**  
- `id`  
- `node_id`  
- `submodule_index`  
- `old_config`  
- `new_config`  
- `timestamp`  

Provides traceability and rollback.

---

### **9. `config_comments`**  
**Purpose:** Optional human comments attached to audit_log entries.  
**Seed manually:** No.  
**Key columns:**  
- `audit_id`  
- `comment`  
- `created_at`  

---

### **10. `node_history`**  
**Purpose:** Historical snapshots of `node_inventory`.  
**Seed manually:** No.  
**Key columns:**  
- `node_id`  
- `snapshot_json`  
- `timestamp`  

Useful for debugging and long‑term analytics.

---

### **11. `message_definitions`**  
**Purpose:** Metadata imported from your CSV of CAN messages.  
**Seed manually:** No — populated by your CSV loader.  
**Key columns:**  
- `msg_id`  
- `dlc`  
- `category`  
- `name`  
- `description`  

Used for decoding live CAN traffic.

---

## 🧭 Summary: what you *must* seed manually

| Table | Seed? | Why |
|-------|-------|------|
| `fields` | Yes | Defines config fields |
| `field_options` | Yes | Dropdown values |
| `personalities` | Yes | Sub‑module types |
| `personality_fields` | Yes | Field mapping |
| `node_types` | Yes | Node‑level types |

Everything else is runtime‑generated.

---

A durable, schema‑aligned reference works best when it mirrors the way your system actually behaves: a small number of *true* personalities with known structure, and a large number of display/sensor/reserved personalities that fall back to raw bytes. The goal is to give you a document you can drop directly into your project wiki and use later if you ever need to rebuild the database or restart a chat.

---

## Personality categories and how they map to fields

Your personality space from **0x700–0x77F** naturally breaks into two groups:

### Known structured personalities (8 total)
These have explicit 3‑byte structs in firmware and therefore use real fields:

- **0x700** — Analog RGB/RGBW Strip  
- **0x702** — ARGB LED Strip  
- **0x703** — Strobe/Blink Output  
- **0x710** — Analog Input (ADC)  
- **0x711** — Digital Input (GPIO)  
- **0x744** — Digital Output (GPIO)  
- **0x745** — PWM Output  
- **0x746** — Analog Output (DAC)

Each of these maps byte‑for‑byte to your defined fields (1–14).

### All other personalities (120 total)
These include:

- Display modules  
- Sensors  
- Reserved IDs  
- System personalities  
- Alternate names for the same underlying capability (e.g., analog knob vs analog ADC)

These personalities do not have defined configuration structures in firmware. They are safely handled using your fallback fields:

- **Field 15 — Raw Byte 0**  
- **Field 16 — Raw Byte 1**  
- **Field 17 — Raw Byte 2**

This ensures every personality is editable and represented without requiring you to define 120 different structs.

---

## Field mapping reference for the 8 structured personalities

This table captures the authoritative mapping between firmware struct bytes and your `fields` table.

### Analog RGB/RGBW Strip — 0x700
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | colorIndex | 10 |
| 1 | pinIndex | 11 |
| 2 | reserved | 14 |

### ARGB LED Strip — 0x702
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | gpioPin | 1 |
| 1 | ledCount | 2 |
| 2 | colorOrder | 3 |

### Strobe/Blink Output — 0x703
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | gpioPin | 1 |
| 1 | blinkDelay | 9 |
| 2 | strobePat | 4 |

### Analog Input (ADC) — 0x710
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | gpioPin | 1 |
| 1 | overSampleCnt | 13 |
| 2 | reserved | 14 |

### Digital Input (GPIO) — 0x711
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | gpioPin | 1 |
| 1 | outputRes | 5 |
| 2 | isInverted | 6 |

### Digital Output (GPIO) — 0x744
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | gpioPin | 1 |
| 1 | momPressDur | 8 |
| 2 | outputMode | 7 |

### PWM Output — 0x745
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | gpioPin | 1 |
| 1 | pwmFreq | 9 |
| 2 | isInverted | 6 |

### Analog Output (DAC) — 0x746
| Byte | Meaning | Field |
|------|---------|--------|
| 0 | gpioPin | 1 |
| 1 | outputMode | 7 |
| 2 | reserved | 14 |

---

## Field mapping reference for all fallback personalities

Every personality ID **not listed above** uses:

| Byte | Field |
|------|--------|
| 0 | 15 (Raw Byte 0) |
| 1 | 16 (Raw Byte 1) |
| 2 | 17 (Raw Byte 2) |

This includes all display, sensor, reserved, and system personalities.

---

## Personality ID summary (0x700–0x77F)

This section groups personalities by category so you can quickly see which ones use real mappings and which use fallback bytes.

### Structured personalities (use real fields)
- **0x700** Analog LED Strip  
- **0x702** ARGB LED Strip  
- **0x703** Strobe Module  
- **0x710** Analog ADC Input  
- **0x711** Digital GPIO Input  
- **0x744** GPIO Digital Output  
- **0x745** GPIO PWM Output  
- **0x746** GPIO DAC Output  

### Display personalities (fallback)
0x701, 0x704–0x70F

### Input personalities (fallback except 0x710, 0x711)
0x712–0x71F, 0x714–0x718, 0x730

### Sensor personalities (fallback)
0x720–0x73F

### Output personalities (fallback except 0x744–0x746)
0x740–0x743, 0x747–0x74F

### Intro/system/reserved personalities (fallback)
0x750–0x77F

---

## How to use this document

This reference gives you:

- A durable mapping between firmware structs and database fields  
- A clear fallback rule for all other personalities  
- A way to regenerate the `personality_fields` table at any time  
- A structure you can drop directly into your project documentation  

It also ensures that if you ever add new personalities in firmware, you can safely assign them to fields 15–17 until you define a real struct.

---

