const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================================
// THƯ MỤC LƯU CÁC FILE FIRMWARE (.BIN)
// ==========================================================
const FIRMWARE_DIR = path.join(__dirname, 'firmware');
if (!fs.existsSync(FIRMWARE_DIR)) {
    fs.mkdirSync(FIRMWARE_DIR);
}

// Cấu hình Multer để lưu file bin theo device_id
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, FIRMWARE_DIR);
    },
    filename: (req, file, cb) => {
        const deviceId = req.body.device_id;
        // Lưu file dạng: ML1_firmware.bin
        cb(null, `${deviceId}_firmware.bin`);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.bin') || file.mimetype === 'application/octet-stream') {
            cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận file định dạng .bin'));
        }
    }
});

// ==========================================================
// 1. DANH SÁCH THIẾT BỊ ĐƯỢC PHÉP HOẠT ĐỘNG (WHITELIST)
// ==========================================================
const ALLOWED_DEVICES = {
    "ML1": "123456",
    "ML2": "123",
    "ML3": "456"
};

const ONLINE_TIMEOUT = 30000; 
const devices = {};

function isOnline(deviceId) {
    if (!devices[deviceId] || !devices[deviceId].lastSeen) return false;
    return (Date.now() - devices[deviceId].lastSeen) < ONLINE_TIMEOUT;
}

function getOrCreateDevice(deviceId) {
    if (!devices[deviceId]) {
        devices[deviceId] = {
            secretKey: ALLOWED_DEVICES[deviceId] || "",
            data: {
                type: "NONE",
                d1: "N/A", d2: "N/A", d3: "N/A", d4: "N/A", d5: "N/A", d6: "N/A",        
                tag: "", value: ""
            },
            commands: {
                co_kiem: 0,
                co_axit: 0,
                co_tinhkhiet: 0,
                co_onoff: 0,
                co_volume: 0,
                has_fw_update: 0 // Cờ báo hiệu có firmware mới cần nạp cho AT2560
            },
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

// ==========================================
// --- API QUẢN LÝ NẠP FIRMWARE (.BIN) ---
// ==========================================

// API 1: Upload file .bin từ App hoặc Web Dashboard lên Server
app.post('/api/upload-firmware', upload.single('firmware'), (req, res) => {
    const { device_id, secret_key } = req.body;

    if (!device_id || !secret_key) {
        return res.status(400).json({ status: "ERROR", message: "Thiếu device_id hoặc secret_key" });
    }

    if (!ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Thiết bị hoặc Mã PIN không hợp lệ!" });
    }

    if (!req.file) {
        return res.status(400).json({ status: "ERROR", message: "Chưa chọn file .bin để upload" });
    }

    // Đặt cờ báo cho ESP8266 biết có bản cập nhật mới
    const device = getOrCreateDevice(device_id);
    device.commands.has_fw_update = 1;

    return res.json({
        status: "OK",
        message: `Đã tải lên firmware thành công cho ${device_id}`,
        file: req.file.filename
    });
}, (err, req, res, next) => {
    // Catch lỗi multer
    res.status(400).json({ status: "ERROR", message: err.message });
});

// API 2: ESP8266 kéo file .bin về để flash xuống AT2560 qua SPI
app.get('/api/download-firmware', (req, res) => {
    const { device_id, secret_key } = req.query;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    const filePath = path.join(FIRMWARE_DIR, `${device_id}_firmware.bin`);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ status: "ERROR", message: "Không tìm thấy file firmware cho thiết bị này" });
    }

    // Trả file nhị phân về cho ESP8266
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${device_id}_firmware.bin"`);
    res.sendFile(filePath);
});

// ==========================================
// --- API DÀNH CHO APP INVENTOR ---
// ==========================================

app.post('/api/check-device', (req, res) => {
    const { device_id, secret_key } = req.body;

    if (!device_id || !secret_key) {
        return res.status(400).json({ status: "ERROR", message: "Thiếu device_id hoặc secret_key" });
    }

    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) {
        return res.json({ status: "ERROR", exists: false, online: false, message: "Thiết bị không tồn tại trên Server!" });
    }

    if (ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.json({ status: "ERROR", exists: true, validKey: false, online: false, message: "Mã PIN (Secret Key) không chính xác!" });
    }

    const onlineStatus = isOnline(device_id);
    return res.json({
        status: "OK",
        exists: true,
        validKey: true,
        online: onlineStatus,
        message: onlineStatus ? "Thiết bị hợp lệ và đang Online" : "Thiết bị hợp lệ nhưng đang Offline"
    });
});

app.get('/api/getdata', (req, res) => {
    const { device_id, secret_key } = req.query;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    const device = getOrCreateDevice(device_id);
    res.json({
        ...device.data,
        online: isOnline(device_id)
    });
});

app.post('/api/control', (req, res) => {
    const { device_id, secret_key, cmd } = req.body;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    const device = getOrCreateDevice(device_id);

    if (cmd && device.commands.hasOwnProperty(`co_${cmd}`)) {
        device.commands[`co_${cmd}`] = 1;
        return res.json({ status: "OK", message: `Đã ghi nhận lệnh ${cmd}` });
    }

    res.status(400).json({ status: "ERROR", message: "Lệnh không hợp lệ" });
});

// ==========================================
// --- API DÀNH CHO ESP8266 ---
// ==========================================

app.post('/api/esp-sync', (req, res) => {
    const { device_id, secret_key, type } = req.body;

    if (!device_id || !secret_key) {
        return res.status(400).json({ status: "ERROR", message: "Thiếu device_id hoặc secret_key từ ESP" });
    }

    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) {
        return res.status(403).json({ status: "ERROR", message: "ID thiết bị này chưa được cấp phép trên Server!" });
    }

    if (ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(401).json({ status: "ERROR", message: "Mã Secret Key của ESP không đúng!" });
    }

    const device = getOrCreateDevice(device_id);
    device.lastSeen = Date.now();

    if (type) {
        if (type === "MULTI") {
            if (req.body.d1 && !req.body.d1.includes(':')) {
                device.data = {
                    type: type,
                    d1: req.body.d1, d2: req.body.d2,
                    d3: req.body.d3, d4: req.body.d4,
                    d5: req.body.d5, d6: req.body.d6
                };
            }
        } else {
            device.data = {
                type: type,
                tag: req.body.tag || "",
                value: req.body.value || ""
            };
        }
    }

    // Phản hồi các lệnh (Bao gồm cờ has_fw_update) cho ESP8266
    res.json(device.commands);

    // Reset các cờ lệnh sau khi đã gửi thành công cho ESP
    for (let key in device.commands) {
        device.commands[key] = 0;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
