#!/usr/bin/env node

/**
 * e-Kinerja BKN MCP Server
 * Standalone JSON-RPC 2.0 stdio MCP server for e-Kinerja BKN (kinerja.bkn.go.id)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');
const readline = require('readline');

const CONFIG_PATH = path.join(os.homedir(), '.ekinerja_config.json');
const BASE_URL = 'https://kinerja.bkn.go.id';

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      // ignore
    }
  }
  return {};
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * Automatically extracts e-Kinerja cookies from Dia browser's Cookies SQLite DB
 */
function getDiaCookies() {
  try {
    const cookieDb = path.join(os.homedir(), 'Library/Application Support/Dia/User Data/Default/Cookies');
    if (!fs.existsSync(cookieDb)) return null;

    const tempDb = path.join(os.tmpdir(), `dia_cookies_${Date.now()}.db`);
    fs.copyFileSync(cookieDb, tempDb);

    const pw = execSync('security find-generic-password -s "Dia Safe Storage" -w 2>/dev/null').toString().trim();
    if (!pw) {
      if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);
      return null;
    }

    const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20);

    const query = "SELECT host_key, name, hex(encrypted_value) FROM cookies WHERE host_key = 'kinerja.bkn.go.id';";
    const output = execSync(`sqlite3 "${tempDb}" "${query}" 2>/dev/null`).toString().trim();
    if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);

    if (!output) return null;

    const cookieParts = [];
    let xsrfToken = '';

    for (const line of output.split('\n')) {
      const [host, name, hexVal] = line.split('|');
      if (!hexVal) continue;
      const buf = Buffer.from(hexVal, 'hex');
      if (buf.subarray(0, 3).toString() === 'v10') {
        const encData = buf.subarray(3);
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(false);
        const dec = Buffer.concat([decipher.update(encData), decipher.final()]);
        let raw = dec.subarray(32);
        const pad = raw[raw.length - 1];
        if (pad > 0 && pad <= 16) {
          raw = raw.subarray(0, raw.length - pad);
        }
        const val = raw.toString('utf8');
        if (name === 'XSRF-TOKEN') xsrfToken = val;
        cookieParts.push(`${name}=${encodeURIComponent(val)}`);
      }
    }

    return {
      cookieHeader: cookieParts.join('; '),
      xsrfToken
    };
  } catch (err) {
    return null;
  }
}

async function getSanctumCookies() {
  try {
    const csrfRes = await fetch(`${BASE_URL}/sanctum/csrf-cookie`);
    const setCookies = csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get('set-cookie')].filter(Boolean);
    let xsrfToken = '';
    const cookieMap = {};

    for (const sc of setCookies) {
      const parts = sc.split(';');
      const [nameVal] = parts;
      const eqIdx = nameVal.indexOf('=');
      const k = nameVal.slice(0, eqIdx).trim();
      const v = nameVal.slice(eqIdx + 1).trim();
      cookieMap[k] = v;
      if (k === 'XSRF-TOKEN') {
        xsrfToken = decodeURIComponent(v);
      }
    }

    const cookieHeader = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
    return { cookieHeader, xsrfToken };
  } catch (e) {
    return null;
  }
}

async function requestApi(endpoint, options = {}) {
  const config = loadConfig();
  let cookieHeader = config.cookieHeader;
  let xsrfToken = config.xsrfToken;
  let token = config.token;

  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET' || !cookieHeader) {
    const sanctum = await getSanctumCookies();
    if (sanctum && sanctum.cookieHeader) {
      cookieHeader = sanctum.cookieHeader;
      xsrfToken = sanctum.xsrfToken;
    } else {
      const diaData = getDiaCookies();
      if (diaData) {
        cookieHeader = diaData.cookieHeader;
        xsrfToken = diaData.xsrfToken;
      }
    }
  }

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ...(options.headers || {})
  };

  if (cookieHeader) headers['Cookie'] = cookieHeader;
  if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers
  });

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, data };
}

// Tool Definitions
const TOOLS = [
  {
    name: 'ekinerja_status',
    description: 'Cek status autentikasi dan profil pegawai yang sedang login di e-Kinerja BKN.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'ekinerja_set_token',
    description: 'Set Bearer token autentikasi e-Kinerja BKN (diambil dari localStorage.token saat login di browser).',
    inputSchema: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description: 'Nilai JWT access token dari localStorage.token di kinerja.bkn.go.id'
        }
      },
      required: ['token']
    }
  },
  {
    name: 'ekinerja_list_skp',
    description: 'Ambil daftar Sasaran Kinerja Pegawai (SKP) aktif pada tanggal tertentu.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Format tanggal YYYY-MM-DD (default hari ini)'
        }
      }
    }
  },
  {
    name: 'ekinerja_list_rhk',
    description: 'Ambil daftar Rencana Hasil Kerja (RHK) dari suatu SKP.',
    inputSchema: {
      type: 'object',
      properties: {
        skp_id: {
          type: 'string',
          description: 'ID SKP aktif, 32 karakter hex (ambil dari hasil ekinerja_list_skp)'
        }
      },
      required: ['skp_id']
    }
  },
  {
    name: 'ekinerja_list_renaksi',
    description: 'Ambil daftar Rencana Aksi (Renaksi) per SKP dan periode.',
    inputSchema: {
      type: 'object',
      properties: {
        skp_id: {
          type: 'string',
          description: 'ID SKP'
        },
        periode_id: {
          type: 'string',
          description: 'ID Periode SKP'
        }
      },
      required: ['skp_id', 'periode_id']
    }
  },
  {
    name: 'ekinerja_get_daily_activities',
    description: 'Melihat daftar log aktivitas kinerja harian pada tanggal tertentu.',
    inputSchema: {
      type: 'object',
      properties: {
        skp_id: {
          type: 'string',
          description: 'ID SKP'
        },
        date: {
          type: 'string',
          description: 'Format tanggal YYYY-MM-DD'
        }
      },
      required: ['skp_id', 'date']
    }
  },
  {
    name: 'ekinerja_add_daily_activity',
    description: 'Menambahkan laporan aktivitas/progres kinerja harian baru.',
    inputSchema: {
      type: 'object',
      properties: {
        skp_id: { type: 'string', description: 'ID SKP' },
        date: { type: 'string', description: 'Tanggal kegiatan (YYYY-MM-DD)' },
        kegiatan: { type: 'string', description: 'Uraian aktivitas/kegiatan yang dilaksanakan' },
        start: { type: 'string', description: 'Jam mulai (format HH:mm, contoh 08:00)' },
        end: { type: 'string', description: 'Jam selesai (format HH:mm, contoh 10:00)' },
        satuan_activity: { type: 'string', description: 'Satuan hasil (misal: Dokumen, Kegiatan, Laporan)' },
        realisasi_activity: { type: 'number', description: 'Jumlah realisasi capaian (contoh: 1)' },
        is_selesai: { type: 'string', enum: ['0', '1'], description: 'Apakah kegiatan selesai (1) atau belum (0)' },
        rhk_id: { type: 'string', description: 'ID RHK terkait' },
        rhk_bagian: { type: 'string', description: 'Bagian RHK (misal: utama / tambahan)' },
        renaksi_id: { type: 'string', description: 'ID Rencana Aksi terkait' },
        periode_id: { type: 'string', description: 'ID Periode SKP' },
        bukti_eviden: { type: 'string', description: 'URL link bukti dukung (Google Drive, Zoom, dsb)' },
        indikator_id: { type: 'string', description: 'ID Indikator terkait' }
      },
      required: ['skp_id', 'date', 'kegiatan', 'start', 'end']
    }
  },
  {
    name: 'ekinerja_delete_daily_activity',
    description: 'Menghapus progres kegiatan harian yang keliru.',
    inputSchema: {
      type: 'object',
      properties: {
        activity_id: {
          type: 'string',
          description: 'ID aktivitas harian yang ingin dihapus'
        }
      },
      required: ['activity_id']
    }
  }
];

// Tool Handlers
async function handleToolCall(name, args) {
  switch (name) {
    case 'ekinerja_status': {
      const res = await requestApi('/api/pegawai/profil_singkat');
      if (res.status === 200) {
        return {
          content: [{ type: 'text', text: `Autentikasi Aktif.\nData Profil:\n${JSON.stringify(res.data, null, 2)}` }]
        };
      }
      return {
        content: [{ type: 'text', text: `Autentikasi Belum Aktif (Status ${res.status}).\nSilakan set token menggunakan tool 'ekinerja_set_token'.\nDetail: ${JSON.stringify(res.data)}` }]
      };
    }

    case 'ekinerja_set_token': {
      const cfg = loadConfig();
      cfg.token = args.token.trim();
      saveConfig(cfg);
      return {
        content: [{ type: 'text', text: 'Token berhasil disimpan ke ~/.ekinerja_config.json. Silakan panggil ekinerja_status untuk verifikasi.' }]
      };
    }

    case 'ekinerja_list_skp': {
      const date = args.date || new Date().toISOString().slice(0, 10);
      const res = await requestApi(`/api/daily_activity/list_skp?date=${date}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }]
      };
    }

    case 'ekinerja_list_rhk': {
      const res = await requestApi(`/api/daily_activity/${args.skp_id}/rhk`);
      return {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }]
      };
    }

    case 'ekinerja_list_renaksi': {
      const res = await requestApi(`/api/daily_activity/${args.skp_id}/renaksi?periode_id=${args.periode_id}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }]
      };
    }

    case 'ekinerja_get_daily_activities': {
      const res = await requestApi(`/api/daily_activity/harian?date=${args.date}&skp_id=${args.skp_id}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }]
      };
    }

    case 'ekinerja_add_daily_activity': {
      const payload = {
        skp_id: args.skp_id,
        periode_id: args.periode_id || null,
        renaksi_id: args.renaksi_id || null,
        renaksi_organisasi_id: null,
        rhk_id: args.rhk_id || null,
        rhk_organisasi_id: null,
        kegiatan: args.kegiatan,
        ref_kegiatan_id: null,
        bukti_eviden: args.bukti_eviden || null,
        start: args.start,
        end: args.end,
        date: args.date,
        date_formatted: args.date,
        realisasi: null,
        realisasi_activity: args.realisasi_activity !== undefined ? args.realisasi_activity : 1,
        satuan_activity: args.satuan_activity || 'Kegiatan',
        is_selesai: args.is_selesai !== undefined ? String(args.is_selesai) : '0',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
      };

      if (args.rhk_id) {
        payload.rhk = { id: args.rhk_id, bagian: args.rhk_bagian || 'utama' };
      }
      if (args.renaksi_id) {
        payload.renaksi = { id: args.renaksi_id, is_trajectory: '0' };
      }
      if (args.indikator_id) {
        payload.indikator = { id: args.indikator_id };
      }

      const res = await requestApi('/api/daily_activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }]
      };
    }

    case 'ekinerja_delete_daily_activity': {
      const res = await requestApi(`/api/daily_activity/${args.activity_id}`, {
        method: 'DELETE'
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }]
      };
    }

    default:
      throw new Error(`Tool unknown: ${name}`);
  }
}

// JSON-RPC 2.0 Handler
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(id, result, error = null) {
  const resp = {
    jsonrpc: '2.0',
    id
  };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    const { id, method, params } = msg;

    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'ekinerja-bkn-mcp',
          version: '1.0.0'
        }
      });
    } else if (method === 'notifications/initialized') {
      // no response needed
    } else if (method === 'ping') {
      sendResponse(id, {});
    } else if (method === 'tools/list') {
      sendResponse(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const result = await handleToolCall(params.name, params.arguments || {});
        sendResponse(id, result);
      } catch (err) {
        sendResponse(id, null, {
          code: -32603,
          message: err.message
        });
      }
    } else {
      if (id !== undefined) {
        sendResponse(id, null, {
          code: -32601,
          message: `Method not found: ${method}`
        });
      }
    }
  } catch (err) {
    // parse error
  }
});
