const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Khởi tạo thư mục chứa file tạm cho Multer
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Cấu hình Multer nhận file firmware
const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 5 * 1024 * 1024 } // Giới hạn file tối đa 5MB
});

// Tạo HTTP Server và gắn WebSocket Server vào chung PORT
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ==========================================================
// 1. CẤU HÌNH & QUẢN LÝ THIẾT BỊ
// ==========================================================
const ALLOWED_DEVICES = {
    "ML1": "123456",
    "ML2": "123",
    "ML3": "456"
};

const ONLINE_TIMEOUT = 30000; // 30 giây không có request -> Offline

// Dữ liệu Runtime
const devices = {};         // Lưu trạng thái cảm biến & lệnh REST
const espSockets = {};      // Lưu kết nối WebSocket theo device_id
const updateProgress = {};  // Lưu tiến trình nạp OTA của từng thiết bị

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
                co_volume: 0
            },
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

// Hàm dọn dẹp tài nguyên file khi nạp OTA xong hoặc xảy ra lỗi
function cleanupFirmwareContext(ws) {
    if (ws && ws.firmwareContext) {
        try {
            if (ws.firmwareContext.fd) fs.closeSync(ws.firmwareContext.fd);
            if (fs.existsSync(ws.firmwareContext.filePath)) {
                fs.unlinkSync(ws.firmwareContext.filePath);
            }
        } catch (e) {
            console.error("[OTA] Lỗi khi dọn dẹp file tạm:", e.message);
        }
        delete ws.firmwareContext;
    }
}

// ==========================================================
// 2. CẤU HÌNH WEBSOCKET (DÙNG CHO OTA FIRMWARE)
// ==========================================================
wss.on('connection', (ws) => {
    ws.deviceId = null;

    ws.on('message', (data, isBinary) => {
        if (isBinary) return; // ESP8266 chỉ gửi text lên Server

        const msg = data.toString().trim();

        // Xử lý xác thực thiết bị kết nối WS
        if (msg.startsWith("identity:")) {
            const devId = msg.split(":")[1];
            if (ALLOWED_DEVICES[devId]) {
                ws.deviceId = devId;
                espSockets[devId] = ws;
                console.log(`[WS] ESP8266 [${devId}] đã kết nối WebSocket!`);
            } else {
                console.log(`[WS] Từ chối thiết bị chưa đăng ký: ${devId}`);
                ws.close();
            }
            return;
        }

        if (msg === "ping") {
            ws.send("pong");
            return;
        }

        // ESP8266 yêu cầu gửi gói 1KB tiếp theo
        if (msg === "NEXT_CHUNK" && ws.firmwareContext) {
            const ctx = ws.firmwareContext;
            const chunkSize = 1024;
            const buffer = Buffer.alloc(chunkSize);

            const bytesRead = fs.readSync(ctx.fd, buffer, 0, chunkSize, ctx.offset);

            if (bytesRead > 0) {
                const chunkToSend = buffer.subarray(0, bytesRead);
                ctx.offset += bytesRead;
                ws.send(chunkToSend, { binary: true });

                const percent = Math.floor((ctx.offset / ctx.totalSize) * 100);
                updateProgress[ws.deviceId] = { status: "DOWNLOADING_TO_ESP", percent: percent };
            } else {
                // Đã truyền xong trọn vẹn file sang ESP8266
                ws.send("UPDATE_COMPLETE");
                console.log(`[OTA] Đã truyền xong file .bin sang ESP8266 [${ws.deviceId}]`);
                cleanupFirmwareContext(ws);
                updateProgress[ws.deviceId] = { status: "FLASHING_ATMEGA", percent: 0 };
            }
            return;
        }

        // ESP8266 báo tiến trình nạp Flash xuống ATmega2560
        if (msg.startsWith("PROGRESS_AVR:")) {
            const percent = parseInt(msg.split(":")[1]);
            updateProgress[ws.deviceId] = { status: "FLASHING_ATMEGA", percent: percent };
            console.log(`[OTA] Tiến trình nạp Mega2560 [${ws.deviceId}]: ${percent}%`);
            return;
        }

        // ESP8266 báo lỗi nạp
        if (msg.startsWith("ERROR_AVR:")) {
            const errorMsg = msg.substring(10);
            updateProgress[ws.deviceId] = { status: "ERROR", message: errorMsg };
            console.error(`[OTA LỖI] Thiết bị [${ws.deviceId}]: ${errorMsg}`);
            cleanupFirmwareContext(ws);
            return;
        }
    });

    ws.on('close', () => {
        if (ws.deviceId) {
            console.log(`[WS] ESP8266 [${ws.deviceId}] đã ngắt kết nối WebSocket.`);
            cleanupFirmwareContext(ws);
            delete espSockets[ws.deviceId];
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS LỖI]:`, err.message);
    });
});

// ==========================================================
// 3. API DÀNH CHO APP INVENTOR
// ==========================================================

// Check trạng thái thiết bị
app.post('/api/check-device', (req, res) => {
    const { device_id, secret_key } = req.body;

    if (!device_id || !secret_key) {
        return res.status(400).json({ status: "ERROR", message: "Thiếu device_id hoặc secret_key" });
    }

    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) {
        return res.json({
            status: "ERROR", exists: false, online: false,
            message: "Thiết bị không tồn tại trên Server!"
        });
    }

    if (ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.json({
            status: "ERROR", exists: true, validKey: false, online: false,
            message: "Mã PIN (Secret Key) không chính xác!"
        });
    }

    const onlineStatus = isOnline(device_id);

    return res.json({
        status: "OK", exists: true, validKey: true, online: onlineStatus,
        message: onlineStatus ? "Thiết bị hợp lệ và đang Online" : "Thiết bị hợp lệ nhưng đang Offline"
    });
});

// Lấy dữ liệu cảm biến hiển thị
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

// Gửi lệnh điều khiển
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

// API nhận file Firmware .bin từ App Inventor (Tương thích cả Body & Query Parameters)
app.post('/api/upload-firmware', upload.single('firmware'), (req, res) => {
    const device_id = req.query.device_id || req.body.device_id;
    const secret_key = req.query.secret_key || req.body.secret_key;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    if (!req.file) {
        return res.status(400).json({ status: "ERROR", message: "Chưa đính kèm file .bin" });
    }

    const ws = espSockets[device_id];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ status: "ERROR", message: "ESP8266 hiện đang Offline (Không có WebSocket)!" });
    }

    const filePath = req.file.path;
    const stats = fs.statSync(filePath);
    const totalSize = stats.size;
    const fd = fs.openSync(filePath, 'r');

    ws.firmwareContext = {
        filePath: filePath,
        fd: fd,
        offset: 0,
        totalSize: totalSize
    };

    updateProgress[device_id] = { status: "STARTING", percent: 0 };

    // Phát tín hiệu lệnh nạp xuống ESP8266
    ws.send(`START_UPDATE:${totalSize}`);

    return res.json({
        status: "OK",
        message: "File đã được gửi lên Server thành công! Đang tiến hành nạp xuống thiết bị..."
    });
});

// API kiểm tra tiến trình nạp OTA cho App Inventor
app.get('/api/ota-progress', (req, res) => {
    const { device_id } = req.query;
    if (!device_id || !updateProgress[device_id]) {
        return res.json({ status: "IDLE", percent: 0 });
    }
    res.json(updateProgress[device_id]);
});

// ==========================================================
// 4. API DÀNH CHO ESP8266 (REST SYNC)
// ==========================================================

app.post('/api/esp-sync', (req, res) => {
    const { device_id, secret_key, type } = req.body;

    if (!device_id || !secret_key) {
        return res.status(400).json({ status: "ERROR", message: "Thiếu device_id hoặc secret_key từ ESP" });
    }

    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) {
        return res.status(403).json({ status: "ERROR", message: "ID thiết bị này chưa được cấp phép!" });
    }

    if (ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(401).json({ status: "ERROR", message: "Mã Secret Key không đúng!" });
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

    // Trả lệnh điều khiển về cho ESP8266
    res.json(device.commands);

    // Clear cờ lệnh sau khi trả về
    for (let key in device.commands) {
        device.commands[key] = 0;
    }
});

// ==========================================================
// 5. KÍCH HOẠT SERVER
// ==========================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server đang chạy trên port ${PORT}`));
