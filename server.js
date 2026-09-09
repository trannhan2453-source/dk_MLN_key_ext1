const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const Aedes = require('aedes');

// Khởi tạo App & HTTP Server
const app = express();
const httpServer = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CẤU HÌNH THƯ MỤC LƯU TRỮ BIN FILE (OTA) ---
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

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
                d1: "N/A", d2: "N/A", d3: "N/A", d4: "N/A", d5: "N/A", d6: "N/A", d7: "N/A", d8: "N/A", d9: "N/A", d10: "N/A", d11: "N/A", d12: "N/A", d13: "N/A", d14: "N/A", d15: "N/A", d16: "N/A", d17: "N/A", d18: "N/A", d19: "N/A", d20: "N/A",         
                tag: "", value: ""
            },
            ackStatus: "",
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

// ==========================================
// --- CẤU HÌNH MQTT BROKER (AEDES) ---
// ==========================================
const aedes = new Aedes();

// 1. Xác thực kết nối MQTT từ ESP8266
aedes.authenticate = (client, username, password, callback) => {
    const deviceId = username || client.id;
    const pwdStr = password ? password.toString() : "";

    if (ALLOWED_DEVICES[deviceId] && ALLOWED_DEVICES[deviceId] === pwdStr) {
        client.deviceId = deviceId;
        return callback(null, true);
    }
    console.log(`[MQTT Auth] Từ chối kết nối từ Client ID: ${client.id}`);
    return callback(null, false);
};

// 2. Lắng nghe dữ liệu Publish từ ESP8266
aedes.on('publish', (packet, client) => {
    if (!client) return; // Bỏ qua các message hệ thống nội bộ

    const topic = packet.topic;
    const payloadStr = packet.payload.toString();

    // Nhận dữ liệu sensor/trạng thái: device/{deviceId}/data
    if (topic.endsWith('/data')) {
        try {
            const json = JSON.parse(payloadStr);
            const deviceId = json.device_id;
            
            if (deviceId && ALLOWED_DEVICES[deviceId] && ALLOWED_DEVICES[deviceId] === json.secret_key) {
                const device = getOrCreateDevice(deviceId);
                device.lastSeen = Date.now();

                if (json.type === "MULTI" && json.data) {
                    device.data = {
                        type: "MULTI",
                        ...json.data
                    };
                } else if (json.type === "SINGLE") {
                    if (json.tag === "CAPNHATOK") {
                        device.ackStatus = "CAPNHATOK";
                    } else {
                        device.data = {
                            type: "SINGLE",
                            tag: json.tag || "",
                            value: json.value || ""
                        };
                    }
                }
            }
        } catch (err) {
            console.error("[MQTT Parse Error] Lỗi đọc dữ liệu JSON:", err);
        }
    } 
    // Nhận báo cáo kết quả nạp OTA: device/{deviceId}/ota_result
    else if (topic.endsWith('/ota_result')) {
        try {
            const json = JSON.parse(payloadStr);
            const deviceId = json.device_id;
            if (deviceId && ALLOWED_DEVICES[deviceId]) {
                const device = getOrCreateDevice(deviceId);
                device.ackStatus = json.tag || "OTA_FINISHED";
                console.log(`[MQTT OTA] Kết quả OTA từ ${deviceId}: ${device.ackStatus}`);
            }
        } catch (err) {
            console.error("[MQTT OTA Parse Error]:", err);
        }
    }
});

// Hàm phát lệnh trực tiếp từ Server xuống ESP8266 qua MQTT
function publishToDevice(deviceId, payloadObject) {
    const topic = `device/${deviceId}/commands`;
    const payload = JSON.stringify(payloadObject);
    aedes.publish({
        topic: topic,
        payload: payload,
        qos: 0,
        retain: false
    }, (err) => {
        if (err) console.error(`[MQTT Publish Error] Gửi tới ${deviceId} thất bại:`, err);
    });
}

// ==========================================
// --- API HTTP DÀNH CHO APP INVENTOR ---
// ==========================================

// API Upload Firmware (.bin) & Phát lệnh OTA tức thì qua MQTT
app.post('/api/upload-firmware', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const { device_id, secret_key } = req.query;

    console.log(`[OTA] Nhận yêu cầu nạp từ Device: ${device_id}`);

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại!" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    if (!req.body || req.body.length === 0) {
        return res.status(400).json({ status: "ERROR", message: "File .bin rỗng hoặc không hợp lệ!" });
    }

    const filePath = path.join(uploadsDir, `${device_id}.bin`);
    fs.writeFile(filePath, req.body, (err) => {
        if (err) {
            console.error("Lỗi ghi file:", err);
            return res.status(500).json({ status: "ERROR", message: "Lỗi ghi file trên Server!" });
        }

        // Bắn trực tiếp lệnh kích hoạt OTA sang MQTT Broker
        publishToDevice(device_id, { co_update: 1 });

        console.log(`[OTA] File .bin lưu thành công! Đã phát lệnh co_update=1 qua MQTT`);
        return res.status(200).json({ 
            status: "OK", 
            message: "Đã tải file thành công lên Server!" 
        });
    });
});

app.post('/api/check-device', (req, res) => {
    const { device_id, secret_key } = req.body;
    if (!device_id || !secret_key) return res.status(400).json({ status: "ERROR", message: "Thiếu thông tin" });
    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) return res.json({ status: "ERROR", exists: false, online: false });
    if (ALLOWED_DEVICES[device_id] !== secret_key) return res.json({ status: "ERROR", exists: true, validKey: false });
    
    const onlineStatus = isOnline(device_id);
    return res.json({ status: "OK", exists: true, validKey: true, online: onlineStatus });
});

// API Lấy dữ liệu cho App Inventor
app.get('/api/getdata', (req, res) => {
    const { device_id, secret_key } = req.query;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }
    const device = getOrCreateDevice(device_id);

    const responseData = {
        ...device.data,
        ack: device.ackStatus,
        online: isOnline(device_id)
    };

    device.ackStatus = ""; // Xóa ACK sau khi gửi để không bị lặp
    res.json(responseData);
});

// API Điều khiển thiết bị từ App Inventor -> Bắn trực tiếp qua MQTT
app.post('/api/control', (req, res) => {
    const { device_id, secret_key, cmd } = req.body;
    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    if (cmd) {
        publishToDevice(device_id, { cmd: cmd });
        return res.json({ status: "OK", message: `Đã ghi nhận và gửi lệnh ${cmd} qua MQTT` });
    }
    res.status(400).json({ status: "ERROR", message: "Lệnh không hợp lệ" });
});

// API Gửi cài đặt tham số từ App Inventor -> Bắn trực tiếp qua MQTT
app.post('/api/set-settings', (req, res) => {
    const { device_id, secret_key, config_str } = req.body;

    if (!device_id || !ALLOWED_DEVICES[device_id] || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Xác thực thất bại" });
    }

    if (!config_str || typeof config_str !== 'string') {
        return res.status(400).json({ status: "ERROR", message: "Dữ liệu chuỗi không hợp lệ" });
    }

    const parsedSettings = {};
    config_str.split(',').forEach(pair => {
        const [key, value] = pair.split(':');
        if (key && value !== undefined) {
            parsedSettings[key.trim()] = value.trim();
        }
    });

    publishToDevice(device_id, { settings: parsedSettings });

    return res.json({
        status: "OK",
        message: "Lưu cài đặt thành công và đã chuyển tới thiết bị qua MQTT",
        settings: parsedSettings
    });
});

// ==========================================
// --- API TẢI FIRMWARE (DÀNH CHO ESP8266) ---
// ==========================================
app.get('/api/download-firmware/:device_id', (req, res) => {
    const { device_id } = req.params;
    const filePath = path.join(uploadsDir, `${device_id}.bin`);

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ status: "ERROR", message: "File firmware không tồn tại" });
    }
});

// ==========================================
// --- KHỞI CHẠY LẮNG NGHE SERVER & BROKER ---
// ==========================================

// 1. MQTT Server qua TCP Sockets truyền thống (Cổng 1883)
const tcpMqttServer = net.createServer(aedes.handle);
const MQTT_PORT = process.env.MQTT_PORT || 1883;
tcpMqttServer.listen(MQTT_PORT, () => {
    console.log(`[MQTT Broker] Đang lắng nghe ở chuẩn TCP Port: ${MQTT_PORT}`);
});

// 2. MQTT Server qua WebSockets (Dùng chung cổng với HTTP Express API)
const wss = new WebSocket.Server({ server: httpServer });
wss.on('connection', (ws) => {
    const stream = WebSocket.createWebSocketStream(ws);
    aedes.handle(stream);
});

// 3. Khởi chạy HTTP Server + WebSocket Broker
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`[HTTP Server & MQTT WS] Đang chạy tại Port: ${PORT}`);
});
