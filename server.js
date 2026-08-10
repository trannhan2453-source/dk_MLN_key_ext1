const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Thư mục tạm lưu firmware upload từ App
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

// Danh sách thiết bị được phép
const ALLOWED_DEVICES = {
    "ML1": "123456",
    "ML2": "123",
    "ML3": "456"
};

// Lưu trữ kết nối WebSocket của ESP8266 theo Device ID
const espSockets = {}; 
// Lưu trữ tiến độ nạp firmware để App query
const updateProgress = {}; 

// ==========================================
// 1. DỊCH VỤ WEBSOCKET DÀNH CHO ESP8266
// ==========================================
wss.on('connection', (ws) => {
    let currentDeviceId = null;

    ws.on('message', (message) => {
        // Nếu là văn bản (String)
        if (typeof message === 'string' || message instanceof String || Buffer.isBuffer(message)) {
            const strMsg = message.toString();

            // Định danh thiết bị: ESP gửi "identity:ML1"
            if (strMsg.startsWith("identity:")) {
                currentDeviceId = strMsg.split(":")[1].trim();
                espSockets[currentDeviceId] = ws;
                console.log(`[WS] ESP8266 kết nối thành công: ${currentDeviceId}`);
            } 
            else if (strMsg === "ping") {
                ws.send("pong");
            } 
            else if (strMsg === "NEXT_CHUNK") {
                if (currentDeviceId && ws.firmwareContext) {
                    sendNextChunk(ws);
                }
            } 
            else if (strMsg.startsWith("PROGRESS_AVR:")) {
                const percent = strMsg.split(":")[1];
                if (currentDeviceId) {
                    updateProgress[currentDeviceId] = { status: "FLASHING", percent: parseInt(percent) };
                    console.log(`[ISP] ${currentDeviceId} Tiến độ Flash ATmega2560: ${percent}%`);
                }
            } 
            else if (strMsg.startsWith("ERROR_AVR:")) {
                const err = strMsg.split(":")[1];
                if (currentDeviceId) {
                    updateProgress[currentDeviceId] = { status: "ERROR", message: err };
                    console.error(`[ISP LỖI] ${currentDeviceId}: ${err}`);
                }
            }
        }
    });

    ws.on('close', () => {
        if (currentDeviceId) {
            delete espSockets[currentDeviceId];
            console.log(`[WS] ESP8266 ngắt kết nối: ${currentDeviceId}`);
        }
    });
});

// Hàm gửi gói Binary 1KB tiếp theo cho ESP8266
function sendNextChunk(ws) {
    const ctx = ws.firmwareContext;
    if (!ctx) return;

    const CHUNK_SIZE = 1024;
    const buffer = Buffer.alloc(CHUNK_SIZE);

    fs.read(ctx.fd, buffer, 0, CHUNK_SIZE, ctx.offset, (err, bytesRead) => {
        if (err || bytesRead === 0) {
            // Đã truyền xong toàn bộ file xuống ESP8266
            fs.closeSync(ctx.fd);
            fs.unlinkSync(ctx.filePath); // Xóa file tạm trên server
            delete ws.firmwareContext;
            
            ws.send("UPDATE_COMPLETE");
            console.log(`[WS] Đã gửi xong toàn bộ file sang ESP8266! Chờ ESP nạp ISP...`);
            return;
        }

        ctx.offset += bytesRead;
        const dataToSend = buffer.slice(0, bytesRead);
        ws.send(dataToSend); // Gửi Binary Chunk
    });
}

// ==========================================
// 2. API DÀNH CHO APP INVENTOR (UPLOAD FILE)
// ==========================================

// API Nạp Firmware từ App Inventor
app.post('/api/upload-firmware', upload.single('firmware'), (req, res) => {
    // Lấy device_id và secret_key từ Query String (App) hoặc Body (Form)
    const device_id = req.query.device_id || req.body.device_id;
    const secret_key = req.query.secret_key || req.body.secret_key;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    if (!req.file) {
        return res.status(400).json({ status: "ERROR", message: "Chưa đính kèm file .bin" });
    }

    const ws = espSockets[device_id];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ status: "ERROR", message: "ESP8266 hiện đang Offline!" });
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

    updateProgress[device_id] = { status: "DOWNLOADING", percent: 0 };

    // Gửi lệnh cho ESP8266 bắt đầu tải file
    ws.send(`START_UPDATE:${totalSize}`);

    return res.json({
        status: "OK",
        message: "File đã được gửi lên Server thành công! Đang tiến hành nạp xuống ESP8266..."
    });
});

// API cho App Inventor kiểm tra tiến độ nạp (?device_id=ML1)
app.get('/api/firmware-progress', (req, res) => {
    const { device_id } = req.query;
    const progress = updateProgress[device_id] || { status: "IDLE", percent: 0 };
    res.json(progress);
});

// Chạy HTTP + WebSocket chung 1 cổng PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server đang chạy tại port ${PORT}`));
